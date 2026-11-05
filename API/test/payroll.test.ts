import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, daysOf, lastCompletedPayWeek, manilaInstant, payWeekOf } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Payroll = { id: string; staffId: string; kind: string; status: string; gross: number; govSss: number; govPhic: number; govPagibig: number; caDeduction: number; net: number; basic: number };
type Week = { ended: boolean; unclosedDays: string[]; kinds: string[]; payrolls: Payroll[] };

const last = () => lastCompletedPayWeek(businessDayOf(new Date()));
const lastDays = () => daysOf(last());

let n = 0;
async function newStaff(admin: Client, fields: Record<string, unknown>): Promise<string> {
  const name = `P${++n}`;
  const res = await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, ...fields });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/** A closed Business Day in the past with paid sales for `therapistId`. */
async function pastSales(day: string, therapistId: string, commissions: number[]) {
  const now = new Date().toISOString();
  const stmts = [env.DB.prepare(`INSERT OR IGNORE INTO business_days (date, opened_at, closed_at) VALUES (?, ?, ?)`).bind(day, now, now)];
  for (const amount of commissions) {
    const booking = crypto.randomUUID();
    stmts.push(
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?)`).bind(booking, day, now),
      env.DB.prepare(
        `INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at)
         VALUES (?, ?, ?, 'paid', 'swedish-60', ?, 50000, 'none', 50000, 50000, 3000, ?, ?)`,
      ).bind(crypto.randomUUID(), booking, day, therapistId, amount, now),
    );
  }
  await env.DB.batch(stmts);
}

async function punched(staffId: string, day: string, inAt: string, outAt: string) {
  const clockIn = manilaInstant(day, inAt);
  let clockOut = manilaInstant(day, outAt);
  if (clockOut < clockIn) clockOut = new Date(+clockOut + 86_400_000);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO business_days (date, opened_at, closed_at) VALUES (?, ?, ?)`).bind(day, now, now),
    env.DB.prepare(`INSERT INTO dtr (id, staff_id, business_day, clock_in, clock_out, source, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?)`).bind(
      crypto.randomUUID(),
      staffId,
      day,
      clockIn.toISOString(),
      clockOut.toISOString(),
      now,
    ),
  ]);
}

const weekOf = async (c: Client, start = last().start) => json<Week>(await c.get(`/payroll/weeks/${start}`));
const mine = (w: Week, staffId: string) => w.payrolls.find((p) => p.staffId === staffId)!;

beforeEach(async () => {
  const w = last();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ca_ledger`),
    env.DB.prepare(`DELETE FROM cash_transfers`),
    env.DB.prepare(`DELETE FROM cash_advances`),
    env.DB.prepare(`DELETE FROM cash_outs`),
    env.DB.prepare(`DELETE FROM payroll_adjustments`),
    env.DB.prepare(`DELETE FROM payrolls`),
    env.DB.prepare(`DELETE FROM bonuses`),
    env.DB.prepare(`DELETE FROM payments`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM dtr`),
    env.DB.prepare(`DELETE FROM business_days`),
    // Tests run on the real calendar; keep holidays out of the sample week.
    env.DB.prepare(`DELETE FROM holidays WHERE date BETWEEN ? AND ?`).bind(w.start, w.end),
  ]);
});

describe('therapist payroll', () => {
  it('runs a week: CA within the cap, generate, approve, release', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await newStaff(admin, { kind: 'therapist', therapistClass: 'regular' });
    const [, mon, , wed] = lastDays();
    await pastSales(mon!, t, [15000, 15000]);
    await pastSales(wed!, t, [21000]);
    await punched(t, mon!, '14:00', '23:00');
    await punched(t, wed!, '14:00', '23:00');

    // Net so far: 510.00 − 202.50 government shares = 307.50.
    const { balances } = await json<{ balances: { staffId: string; cap: { cap: number; week: { start: string } } }[] }>(await desk.get('/cash-advances/balances'));
    expect(balances.find((b) => b.staffId === t)!.cap).toMatchObject({ cap: 30750, week: { start: last().start } });
    expect((await desk.post('/cash-advances', { staffId: t, amount: 20000 })).status).toBe(201);
    const over = await desk.post('/cash-advances', { staffId: t, amount: 20000 });
    expect(over.status).toBe(409);
    expect((await json<{ message: string }>(over)).message).toMatch(/107\.50/);
    // Only the Super Admin may go over.
    expect((await desk.post('/cash-advances', { staffId: t, amount: 20000, override: true })).status).toBe(409);

    // The CA came out of today's drawer.
    const { cashOuts } = await json<{ cashOuts: { category: string; amount: number; staffId: string }[] }>(await desk.get(`/cash-outs?day=${businessDayOf(new Date())}`));
    expect(cashOuts).toEqual([expect.objectContaining({ category: 'cash_advance', amount: 20000, staffId: t })]);

    expect((await desk.post(`/payroll/weeks/${payWeekOf(businessDayOf(new Date())).start}/generate`, { kind: 'therapist' })).status).toBe(409);
    expect((await desk.post(`/payroll/weeks/${last().start}/generate`, { kind: 'therapist' })).status).toBe(200);
    const p = mine(await weekOf(desk), t);
    expect(p).toMatchObject({ status: 'draft', gross: 51000, govSss: 10000, govPhic: 6250, govPagibig: 4000, caDeduction: 20000, net: 10750 });

    expect((await desk.post(`/payrolls/${p.id}/release`)).status).toBe(409);
    expect((await desk.post(`/payrolls/${p.id}/approve`)).status).toBe(403);
    expect((await admin.post(`/payrolls/${p.id}/approve`)).status).toBe(200);
    expect((await desk.post(`/payrolls/${p.id}/release`)).status).toBe(200);
    // Paid from the shop's Sales Cash by default.
    const paid = await env.DB.prepare(`SELECT amount FROM cash_transfers WHERE kind = 'payroll' AND payroll_id = ?`).bind(p.id).first<{ amount: number }>();
    expect(paid?.amount).toBe(10750);

    // Repaid in full; the next CA counts against this week.
    const after = await json<{ balances: { staffId: string; balance: number; cap: { week: { start: string } } }[] }>(await desk.get('/cash-advances/balances'));
    const mineNow = after.balances.find((b) => b.staffId === t)!;
    expect(mineNow.balance).toBe(0);
    expect(mineNow.cap.week.start).toBe(payWeekOf(businessDayOf(new Date())).start);
  });

  it('waits for every day of the week to be closed, and regenerates drafts with new CAs', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await newStaff(admin, { kind: 'therapist', therapistClass: 'lmt', qualification: 'doh' });
    const [, mon] = lastDays();
    await pastSales(mon!, t, [30000]);
    await env.DB.prepare(`UPDATE business_days SET closed_at = NULL WHERE date = ?`).bind(mon).run();

    const open = await desk.post(`/payroll/weeks/${last().start}/generate`, { kind: 'therapist' });
    expect(open.status).toBe(409);
    expect((await json<{ message: string }>(open)).message).toMatch(/not closed/);
    await env.DB.prepare(`UPDATE business_days SET closed_at = ? WHERE date = ?`).bind(new Date().toISOString(), mon).run();
    expect((await desk.post(`/payroll/weeks/${last().start}/generate`, { kind: 'therapist' })).status).toBe(200);

    // A CA taken now goes into the existing draft at once, and removing it puts it back.
    const { id } = await json<{ id: string }>(await desk.post('/cash-advances', { staffId: t, amount: 5000 }));
    expect(mine(await weekOf(desk), t)).toMatchObject({ caDeduction: 5000, net: 30000 - 20250 - 5000 });
    const { cashOuts } = await json<{ cashOuts: { id: string }[] }>(await desk.get(`/cash-outs?day=${businessDayOf(new Date())}`));
    expect((await desk.send('DELETE', `/cash-outs/${cashOuts[0]!.id}`)).status).toBe(409);
    expect((await desk.send('DELETE', `/cash-advances/${id}`)).status).toBe(200);
    expect(mine(await weekOf(desk), t)).toMatchObject({ caDeduction: 0, net: 9750 });
  });

  it('splits out Holiday Commission, and keeps Adjustment reasons from the Receptionist', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await newStaff(admin, { kind: 'therapist', therapistClass: 'regular' });
    const [, mon] = lastDays();
    await pastSales(mon!, t, [25000]); // ₱500 Swedish at the 50% Holiday rate
    await env.DB.prepare(`UPDATE sales SET is_holiday = 1, commission_bp = 5000 WHERE therapist_id = ?`).bind(t).run();
    await desk.post(`/payroll/weeks/${last().start}/generate`, { kind: 'therapist' });
    const id = mine(await weekOf(desk), t).id;

    expect((await desk.post(`/payrolls/${id}/adjustments`, { label: 'Bonus', amount: 5000, reason: 'Covered the desk' })).status).toBe(403);
    expect((await admin.post(`/payrolls/${id}/adjustments`, { label: 'Bonus', amount: 5000, reason: 'Covered the desk' })).status).toBe(201);

    type Full = Payroll & { lines: { earnings: Record<string, number> }; adjustments: { label: string; reason?: string }[] };
    const { payroll } = await json<{ payroll: Full }>(await desk.get(`/payrolls/${id}`));
    expect(payroll.lines.earnings).toMatchObject({ commission: 15000, holidayExtra: 10000, adjustments: 5000 });
    expect(payroll.gross).toBe(30000);
    expect(payroll.adjustments).toEqual([{ id: expect.any(String), label: 'Bonus', amount: 5000 }]);
  });

  it('refuses CAs for On-call Therapists', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await newStaff(admin, { kind: 'therapist', therapistClass: 'regular', isOnCall: true });
    expect((await desk.post('/cash-advances', { staffId: t, amount: 100 })).status).toBe(409);
  });
});

describe('receptionist payroll', () => {
  it('is for the Super Admin only, and repays the standing CA Repayment or a chosen amount', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const r = await newStaff(admin, { kind: 'receptionist', dailyRate: 69200 });
    const [, mon, tue] = lastDays();
    await punched(r, mon!, '14:10', '23:00'); // 10 min late: 677.58
    await punched(r, tue!, '14:00', '23:30'); // 30 min OT: 692.00 + 54.06

    expect((await desk.post('/cash-advances', { staffId: r, amount: 10000 })).status).toBe(403);
    expect((await admin.send('PUT', '/cash-advances/opening', { staffId: r, amount: 400000 })).status).toBe(200);

    expect((await desk.post(`/payroll/weeks/${last().start}/generate`, { kind: 'receptionist' })).status).toBe(403);
    expect((await admin.post(`/payroll/weeks/${last().start}/generate`, { kind: 'receptionist' })).status).toBe(200);
    expect((await weekOf(desk)).payrolls.some((p) => p.kind === 'receptionist')).toBe(false);

    const p = mine(await weekOf(admin), r);
    expect(p).toMatchObject({ gross: 67758 + 69200 + 5406, basic: 67758 + 69200, govSss: 21250, govPhic: 10563, govPagibig: 5000, caDeduction: 50000 });
    expect((await admin.send('PUT', `/payrolls/${p.id}/ca-repayment`, { amount: 500000 })).status).toBe(400);
    expect((await admin.send('PUT', `/payrolls/${p.id}/ca-repayment`, { amount: 100000 })).status).toBe(200);
    expect(mine(await weekOf(admin), r).net).toBe(142364 - 36813 - 100000);

    expect((await admin.post(`/payrolls/${p.id}/approve`)).status).toBe(200);
    expect((await admin.post(`/payrolls/${p.id}/release`)).status).toBe(200);
    const { balance } = await json<{ balance: number }>(await admin.get(`/cash-advances?staffId=${r}`));
    expect(balance).toBe(300000);

    // 13th Month: a twelfth of the basic pay in approved Payrolls.
    const year = Number(mon!.slice(0, 4));
    expect((await desk.post('/bonuses/thirteenth-month', { year })).status).toBe(403);
    expect((await admin.post('/bonuses/thirteenth-month', { year })).status).toBe(200);
    const { bonuses } = await json<{ bonuses: { staffId: string; kind: string; basis: number; amount: number }[] }>(await admin.get(`/bonuses?year=${year}`));
    expect(bonuses.find((b) => b.staffId === r && b.kind === 'thirteenth_month')).toMatchObject({ basis: 136958, amount: 11413 });
  });

  it('breaks the week into Payslip lines, with Adjustments and the standing CA Repayment', async () => {
    const admin = await loggedIn('super_admin');
    const r = await newStaff(admin, { kind: 'receptionist', dailyRate: 69200 });
    const [sun, mon, tue] = lastDays();
    await punched(r, sun!, '14:00', '23:00'); // Rest Day: 692 + 207.60 premium
    await punched(r, mon!, '14:10', '23:00'); // late 10 min: −14.42
    await punched(r, tue!, '14:00', '23:30'); // OT 30 min: 54.06
    expect((await admin.send('PUT', '/cash-advances/opening', { staffId: r, amount: 60000 })).status).toBe(200);
    expect((await admin.send('PATCH', `/settings/staff/${r}`, { caRepayment: 75000 })).status).toBe(200);

    await admin.post(`/payroll/weeks/${last().start}/generate`, { kind: 'receptionist' });
    const p = mine(await weekOf(admin), r);
    // ₱750 standing, but only ₱600 is owed.
    expect(p.caDeduction).toBe(60000);

    expect((await admin.post(`/payrolls/${p.id}/adjustments`, { label: 'Underpaid Oct 26', amount: 20000 })).status).toBe(400);
    const add = await admin.post(`/payrolls/${p.id}/adjustments`, { label: 'Underpaid Oct 26', amount: 20000, reason: 'Missed OT last week' });
    expect(add.status).toBe(201);
    // A recompute keeps it.
    await admin.post(`/payroll/weeks/${last().start}/generate`, { kind: 'receptionist' });

    type Lines = { earnings: Record<string, number>; deductions: Record<string, number>; totalEarned: number; totalDeductions: number; daysPresent: number };
    type Full = Payroll & { lines: Lines; adjustments: { id: string; label: string; amount: number; reason?: string }[] };
    const { payroll } = await json<{ payroll: Full }>(await admin.get(`/payrolls/${mine(await weekOf(admin), r).id}`));
    expect(payroll.lines.daysPresent).toBe(3);
    expect(payroll.lines.earnings).toMatchObject({ basic: 69200 * 3, restDayPremium: 20760, overtime: 5406, adjustments: 20000 });
    expect(payroll.lines.deductions).toMatchObject({ late: 1442, ca: 60000 });
    expect(payroll.gross).toBe(69200 * 3 + 20760 - 1442 + 5406 + 20000);
    expect(payroll.basic).toBe(69200 * 2 + 67758);
    expect(payroll.lines.totalEarned - payroll.lines.totalDeductions).toBe(payroll.net);
    expect(payroll.adjustments).toEqual([expect.objectContaining({ label: 'Underpaid Oct 26', amount: 20000, reason: 'Missed OT last week' })]);

    // Removing it takes it back off; none once approved.
    expect((await admin.send('DELETE', `/payrolls/${payroll.id}/adjustments/${payroll.adjustments[0]!.id}`)).status).toBe(200);
    expect(mine(await weekOf(admin), r).net).toBe(payroll.net - 20000);
    await admin.post(`/payrolls/${payroll.id}/approve`);
    expect((await admin.post(`/payrolls/${payroll.id}/adjustments`, { label: 'Late fix', amount: 100, reason: 'test' })).status).toBe(409);
  });

  it('refuses to generate while a DTR entry has no clock-out', async () => {
    const admin = await loggedIn('super_admin');
    const r = await newStaff(admin, { kind: 'receptionist', dailyRate: 69200 });
    const [, mon] = lastDays();
    await punched(r, mon!, '14:00', '23:00');
    await env.DB.prepare(`UPDATE dtr SET clock_out = NULL WHERE staff_id = ?`).bind(r).run();
    const res = await admin.post(`/payroll/weeks/${last().start}/generate`, { kind: 'receptionist' });
    expect(res.status).toBe(409);
    expect((await json<{ message: string }>(res)).message).toMatch(/clock-out/);
  });
});

describe('Year-end Bonus', () => {
  it('is the year’s Commission times the chosen percentage, kept once paid', async () => {
    const admin = await loggedIn('super_admin');
    const t = await newStaff(admin, { kind: 'therapist', therapistClass: 'regular' });
    const [, mon] = lastDays();
    await pastSales(mon!, t, [30000, 21000]);
    const year = Number(mon!.slice(0, 4));

    expect((await admin.post('/bonuses/year-end', { year, bp: 813 })).status).toBe(200);
    const list = async () => (await json<{ bonuses: { id: string; staffId: string; amount: number; bp: number }[] }>(await admin.get(`/bonuses?year=${year}`))).bonuses.find((b) => b.staffId === t)!;
    // 510.00 × 8.13% = 41.463
    expect(await list()).toMatchObject({ amount: 4146, bp: 813 });
    expect((await admin.post(`/bonuses/${(await list()).id}/paid`)).status).toBe(200);
    expect((await admin.post('/bonuses/year-end', { year, bp: 1000 })).status).toBe(200);
    expect((await list()).amount).toBe(4146);
  });
});

describe('Clock-in Screen', () => {
  it('shows a Therapist this week’s Commission so far', async () => {
    const admin = await loggedIn('super_admin');
    const t = await newStaff(admin, { kind: 'therapist', therapistClass: 'regular' });
    await admin.post(`/settings/staff/${t}/pin`, { pin: '4321' });
    await pastSales(businessDayOf(new Date()), t, [15000]);
    const res = await json<{ earnings: { commission: number; services: number } }>(await admin.post('/clock/punch', { staffId: t, pin: '4321', action: 'in' }));
    expect(res.earnings).toMatchObject({ commission: 15000, services: 1 });
  });
});
