import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, daysOf, lastCompletedPayWeek, manilaInstant } from '@spa/domain';
import { client, loggedIn, PERSON, seedUser, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const last = () => lastCompletedPayWeek(businessDayOf(new Date()));
const lastDays = () => daysOf(last());

let n = 0;
async function newStaff(admin: Client, fields: Record<string, unknown>, pin = '1234'): Promise<string> {
  const name = `R${++n}`;
  const res = await admin.post('/settings/staff', { firstName: name, lastName: 'Test', displayName: name, ...fields });
  expect(res.status).toBe(201);
  const { id } = await json<{ id: string }>(res);
  await admin.post(`/settings/staff/${id}/pin`, { pin });
  return id;
}

/** A closed day's DTR entry; `relief` marks a Relief Shift. */
async function punched(staffId: string, day: string, inAt: string, outAt: string, relief = false) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO business_days (date, opened_at, closed_at) VALUES (?, ?, ?)`).bind(day, now, now),
    env.DB.prepare(`INSERT INTO dtr (id, staff_id, business_day, clock_in, clock_out, source, is_relief, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`).bind(
      crypto.randomUUID(),
      staffId,
      day,
      manilaInstant(day, inAt).toISOString(),
      manilaInstant(day, outAt).toISOString(),
      relief ? 1 : 0,
      now,
    ),
  ]);
}

const THERAPIST = { ...PERSON, kind: 'therapist', therapistClass: 'regular' };
const OUTSIDE = (reliefPay: 'on_return' | 'weekly') => ({ kind: 'reliever', therapistClass: null, isOnCall: false, dailyRate: null, govSss: 0, govPhic: 0, govPagibig: 0, active: true, reliefPay });

beforeEach(async () => {
  const w = last();
  await env.DB.batch([
    env.DB.prepare(`UPDATE dtr SET clock_out = ? WHERE clock_out IS NULL`).bind(new Date().toISOString()),
    env.DB.prepare(`DELETE FROM ca_ledger`),
    env.DB.prepare(`DELETE FROM payroll_adjustments`),
    env.DB.prepare(`DELETE FROM payrolls`),
    env.DB.prepare(`DELETE FROM cash_outs`),
    env.DB.prepare(`DELETE FROM holidays WHERE date BETWEEN ? AND ?`).bind(w.start, w.end),
  ]);
});

describe('Relief Shifts', () => {
  it('take a Therapist out of the Rotation and add Relief pay to their Payroll', async () => {
    const owner = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await newStaff(owner, THERAPIST);
    const other = await newStaff(owner, THERAPIST);
    await owner.post('/clock/punch', { staffId: other, pin: '1234', action: 'in' });
    expect((await owner.post('/clock/punch', { staffId: t, pin: '1234', action: 'in', relief: true })).status).toBe(200);
    const board = await json<{ rotation: { staffId: string }[]; relieving: string[] }>(await desk.get('/front-desk'));
    expect(board.rotation.map((r) => r.staffId)).toContain(other);
    expect(board.rotation.map((r) => r.staffId)).not.toContain(t);
    expect(board.relieving).toHaveLength(1);
    await owner.post('/clock/punch', { staffId: t, pin: '1234', action: 'out' });
    await owner.post('/clock/punch', { staffId: other, pin: '1234', action: 'out' });

    // Last Sunday covered in full (ordinary rate, no Rest Day premium), Monday 14:00–17:00 only.
    const [sun, mon] = lastDays();
    await punched(t, sun!, '14:00', '23:00', true);
    await punched(t, mon!, '14:00', '17:00', true);
    await punched(t, mon!, '17:00', '23:00');
    await desk.post(`/payroll/weeks/${last().start}/generate`, { kind: 'therapist' });
    const { payrolls } = await json<{ payrolls: { staffId: string; gross: number; lines: { earnings: Record<string, number> } }[] }>(await desk.get(`/payroll/weeks/${last().start}`));
    const p = payrolls.find((x) => x.staffId === t)!;
    // ₱582 + ₱582 × 180/480
    expect(p.lines.earnings).toMatchObject({ reliefPay: 58200 + 21825, commission: 0 });
    expect(p.gross).toBe(80025);
  });

  it('pay a short-cover Outside Reliever in cash when the Receptionist returns', async () => {
    const owner = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    expect((await owner.post('/settings/staff', { firstName: 'X', lastName: 'Y', displayName: 'X', ...OUTSIDE('on_return'), dailyRate: 50000 })).status).toBe(400);
    const r = await newStaff(owner, OUTSIDE('on_return'));
    const [, , tue, wed] = lastDays();
    await punched(r, tue!, '14:00', '23:00', true);
    await punched(r, wed!, '14:00', '23:00', true);

    const { owed } = await json<{ owed: { staffId: string; amount: number; days: string[] }[] }>(await desk.get('/relief-pay'));
    expect(owed.find((o) => o.staffId === r)).toMatchObject({ amount: 116400, days: [tue, wed] });
    const pay = await desk.post(`/relief-pay/${r}`);
    expect(pay.status).toBe(201);
    const { cashOuts } = await json<{ cashOuts: { id: string; category: string; amount: number }[] }>(await desk.get(`/cash-outs?day=${businessDayOf(new Date())}`));
    const out = cashOuts.find((x) => x.category === 'relief_pay')!;
    expect(out.amount).toBe(116400);
    expect((await desk.send('DELETE', `/cash-outs/${out.id}`)).status).toBe(409);
    expect((await json<{ owed: { staffId: string }[] }>(await desk.get('/relief-pay'))).owed.some((o) => o.staffId === r)).toBe(false);
    // No Cash Advances for an Outside Reliever.
    expect((await owner.post('/cash-advances', { staffId: r, amount: 10000 })).status).toBe(409);
  });

  it('pay a long-cover Outside Reliever by weekly Payroll, without Government Deductions', async () => {
    const owner = await loggedIn('super_admin');
    const r = await newStaff(owner, OUTSIDE('weekly'));
    const [, mon, tue] = lastDays();
    await punched(r, mon!, '14:00', '23:00', true);
    await punched(r, tue!, '14:10', '23:00', true);
    expect((await owner.post(`/payroll/weeks/${last().start}/generate`, { kind: 'reliever' })).status).toBe(200);
    const { payrolls } = await json<{ payrolls: { staffId: string; kind: string; gross: number; govSss: number; net: number }[] }>(await owner.get(`/payroll/weeks/${last().start}`));
    // ₱582 + ₱582 × 470/480
    expect(payrolls.find((p) => p.staffId === r)).toMatchObject({ kind: 'reliever', gross: 58200 + 56988, govSss: 0, net: 58200 + 56988 });
  });
});

describe('Reliever Login', () => {
  it('works only while someone is clocked in on relief, and credits their work to that Reliever', async () => {
    const owner = await loggedIn('super_admin');
    const r = await newStaff(owner, OUTSIDE('on_return'));
    const login = await seedUser({ role: 'reliever' });
    const pc = client();
    const refused = await pc.post('/auth/login', { email: login.email, password: login.password });
    expect(refused.status).toBe(403);
    expect((await json<{ error: string }>(refused)).error).toBe('no_relief_shift');

    await owner.post('/clock/punch', { staffId: r, pin: '1234', action: 'in' });
    expect((await pc.post('/auth/login', { email: login.email, password: login.password })).status).toBe(200);
    const me = await json<{ user: { role: string; actingAs: { staffId: string } } }>(await pc.get('/auth/me'));
    expect(me.user).toMatchObject({ role: 'reliever', actingAs: { staffId: r } });

    // Receptionist powers minus Payroll.
    expect((await pc.get(`/payroll/weeks/${last().start}`)).status).toBe(403);
    expect((await pc.get('/me/pay')).status).toBe(403);
    expect((await pc.post('/cash-outs', { category: 'laundry', amount: 15000, purpose: 'Laundry' })).status).toBe(201);
    // A time record added under the shared login is credited to the Reliever clocked in.
    const t = await newStaff(owner, THERAPIST);
    const day = lastDays()[3]!;
    const added = await pc.post('/dtr', { staffId: t, clockIn: manilaInstant(day, '14:00').toISOString(), clockOut: manilaInstant(day, '23:00').toISOString(), reason: 'Paper DTR' });
    expect(added.status).toBe(201);
    const audit = await env.DB.prepare(`SELECT acting_staff_id FROM audit_log WHERE actor_user_id = ? AND action = 'dtr.add' ORDER BY id DESC LIMIT 1`).bind(login.id).first<{ acting_staff_id: string | null }>();
    expect(audit?.acting_staff_id).toBe(r);
    const cash = await json<{ reminder: string; relief: boolean }>(await pc.get('/cash/summary'));
    expect(cash.relief).toBe(true);

    // Once the Reliever clocks out, the login stops working.
    await owner.post('/clock/punch', { staffId: r, pin: '1234', action: 'out' });
    expect((await pc.get('/auth/me')).status).toBe(401);
  });
});
