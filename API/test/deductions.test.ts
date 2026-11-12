import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, daysOf, lastCompletedPayWeek, manilaInstant, weekFrom } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Payroll = { id: string; staffId: string; status: string; gross: number; govSss: number; govDeferred: number; govCollected: number; govOverride: number | null; govAgreed: boolean; deferredOwed: { total: number; weeks: { weekStart: string; number: number; amount: number }[] } | null; commissionBefore: number; net: number; lines: { deductions: Record<string, number> } };

const thisWeek = () => lastCompletedPayWeek(businessDayOf(new Date()), 'therapist');
const earlier = () => {
  const d = new Date(`${thisWeek().start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return weekFrom(d.toISOString().slice(0, 10));
};

let n = 0;
async function therapist(admin: Client, fields: Record<string, unknown> = {}) {
  const name = `D${++n}`;
  const res = await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass: 'regular', govSss: 10_000, govPhic: 6_250, govPagibig: 4_200, ...fields });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

async function worked(staffId: string, day: string, commission: number) {
  const now = new Date().toISOString();
  const booking = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO business_days (date, opened_at, closed_at) VALUES (?, ?, ?)`).bind(day, now, now),
    env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?)`).bind(booking, day, now),
    env.DB.prepare(
      `INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at) VALUES (?, ?, ?, 'paid', 'swedish-60', ?, 50000, 'none', 50000, 50000, 3000, ?, ?)`,
    ).bind(crypto.randomUUID(), booking, day, staffId, commission, now),
    env.DB.prepare(`INSERT INTO dtr (id, staff_id, business_day, clock_in, clock_out, source, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?)`).bind(crypto.randomUUID(), staffId, day, manilaInstant(day, '14:00').toISOString(), manilaInstant(day, '23:00').toISOString(), now),
  ]);
}

const week = async (c: Client, start: string) => json<{ payrolls: Payroll[]; beforeGoLive: { staffId: string; amount: number | null }[] | null; unclosedDays: string[] }>(await c.get(`/payroll/weeks/${start}`));
const generate = (c: Client, start: string) => c.post(`/payroll/weeks/${start}/generate`, { kind: 'therapist' });
const mine = async (c: Client, start: string, id: string) => (await week(c, start)).payrolls.find((p) => p.staffId === id)!;
const owed = async (c: Client, id: string) => (await json<{ people: { staffId: string; balance: number; opening: number | null; suggested: number }[] }>(await c.get('/deferred-deductions'))).people.find((p) => p.staffId === id)!;

let admin: Client;
let desk: Client;

beforeEach(async () => {
  admin = await loggedIn('super_admin');
  desk = await loggedIn('receptionist');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM deduction_ledger`),
    env.DB.prepare(`DELETE FROM past_therapist_weeks`),
    env.DB.prepare(`DELETE FROM ca_ledger`),
    env.DB.prepare(`DELETE FROM cash_transfers`),
    env.DB.prepare(`DELETE FROM cash_advances`),
    env.DB.prepare(`DELETE FROM cash_outs`),
    env.DB.prepare(`DELETE FROM deduction_refunds`),
    env.DB.prepare(`DELETE FROM payroll_adjustments`),
    env.DB.prepare(`DELETE FROM payrolls`),
    env.DB.prepare(`DELETE FROM payments`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM dtr`),
    env.DB.prepare(`DELETE FROM business_days`),
    env.DB.prepare(`UPDATE pay_rules SET value_json = '100000' WHERE key = 'take_home_floor'`),
    env.DB.prepare(`UPDATE pay_rules SET value_json = '"2020-01-05"' WHERE key = 'go_live_date'`),
    env.DB.prepare(`UPDATE staff SET active = 0`),
  ]);
});

describe('Deferred Deductions', () => {
  it('hold a slow week over and leave it on the balance, once approved', async () => {
    const t = await therapist(admin);
    const [, slow] = daysOf(earlier());
    const [, good] = daysOf(thisWeek());
    await worked(t, slow!, 90_000);
    await worked(t, good!, 300_000);

    expect((await generate(desk, earlier().start)).status).toBe(200);
    const first = await mine(desk, earlier().start, t);
    expect(first).toMatchObject({ gross: 90_000, govSss: 10_000, govDeferred: 20_450, govCollected: 0, net: 90_000 });
    expect(first.lines.deductions.deferred).toBe(-20_450);
    expect((await owed(admin, t)).balance).toBe(0); // a draft owes nothing yet
    expect((await desk.post(`/payrolls/${first.id}/approve`)).status).toBe(403);
    expect((await admin.post(`/payrolls/${first.id}/approve`)).status).toBe(200);
    expect((await owed(admin, t)).balance).toBe(20_450);

    await generate(desk, thisWeek().start);
    const second = await mine(desk, thisWeek().start, t);
    expect(second).toMatchObject({ govDeferred: 0, govCollected: 0, net: 300_000 - 20_450 });
    expect(second.deferredOwed).toMatchObject({ total: 20_450, weeks: [{ weekStart: earlier().start, amount: 20_450 }] });

    // When the Therapist asks to pay sooner.
    expect((await admin.send('PUT', `/payrolls/${second.id}/deductions`, { amount: 40_900 })).status).toBe(200);
    const paying = await mine(desk, thisWeek().start, t);
    expect(paying).toMatchObject({ govCollected: 20_450, net: 300_000 - 40_900, deferredOwed: { total: 0, weeks: [] } });
    expect((await admin.post(`/payrolls/${paying.id}/approve`)).status).toBe(200);
    expect((await owed(admin, t)).balance).toBe(0);

    // Back to draft undoes what it did to the balance.
    expect((await admin.post(`/payrolls/${second.id}/unapprove`, { reason: 'Recheck' })).status).toBe(200);
    expect((await owed(admin, t)).balance).toBe(20_450);
  });

  it('won’t approve figures that have gone out of date', async () => {
    const t = await therapist(admin);
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 110_000);
    await generate(desk, thisWeek().start);
    const row = await mine(desk, thisWeek().start, t);
    expect(row.govDeferred).toBe(10_450);
    await env.DB.prepare(`UPDATE pay_rules SET value_json = '50000' WHERE key = 'take_home_floor'`).run();
    const res = await admin.post(`/payrolls/${row.id}/approve`);
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toBe('stale');
    await generate(desk, thisWeek().start);
    expect((await admin.post(`/payrolls/${(await mine(desk, thisWeek().start, t)).id}/approve`)).status).toBe(200);
  });

  it('a Cash Advance or Adjustment keeps the draft right', async () => {
    const t = await therapist(admin);
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 150_000);
    await generate(desk, thisWeek().start);
    const row = await mine(desk, thisWeek().start, t);
    expect(row.net).toBe(150_000 - 20_450);
    await admin.post(`/payrolls/${row.id}/adjustments`, { label: 'Correction', amount: -40_000, reason: 'Last week' });
    expect(await mine(desk, thisWeek().start, t)).toMatchObject({ gross: 110_000, govDeferred: 10_450, net: 100_000 });
    expect((await admin.post(`/payrolls/${row.id}/approve`)).status).toBe(200);
  });

  it('a week away with no work goes on the balance', async () => {
    const t = await therapist(admin);
    await generate(desk, thisWeek().start);
    const row = await mine(desk, thisWeek().start, t);
    expect(row).toMatchObject({ gross: 0, govSss: 10_000, govDeferred: 20_450, net: 0 });
    expect((await admin.post(`/payrolls/${row.id}/approve`)).status).toBe(200);
    expect((await owed(admin, t)).balance).toBe(20_450);
  });

  it('nothing is owed for a week after leaving or before starting', async () => {
    const gone = await therapist(admin, { active: false });
    const future = await therapist(admin, { hireDate: '2099-01-01' });
    await generate(desk, thisWeek().start);
    const rows = (await week(desk, thisWeek().start)).payrolls;
    expect(rows.find((p) => p.staffId === gone)).toBeUndefined();
    expect(rows.find((p) => p.staffId === future)).toBeUndefined();
  });

  it('the last working week can take everything owed, past the Take-home Floor', async () => {
    const t = await therapist(admin);
    await env.DB.prepare(`INSERT INTO deduction_ledger (id, staff_id, entry, amount, created_at, created_by) VALUES (?, ?, 'opening', 40_900, ?, NULL)`.replace('40_900', '40900')).bind(crypto.randomUUID(), t, new Date().toISOString()).run();
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 120_000);
    await generate(desk, thisWeek().start);
    const row = await mine(desk, thisWeek().start, t);
    expect(row).toMatchObject({ govDeferred: 450, govCollected: 0, net: 100_000 });
    expect((await admin.send('PUT', `/payrolls/${row.id}/deductions`, { amount: 61_350 })).status).toBe(200);
    expect(await mine(desk, thisWeek().start, t)).toMatchObject({ govCollected: 40_900, net: 58_650 });
    expect((await admin.post(`/payrolls/${row.id}/approve`)).status).toBe(200);
    expect((await owed(admin, t)).balance).toBe(0);
  });

  it('takes the week under the floor when the Therapist agrees, and remembers it', async () => {
    const t = await therapist(admin);
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 90_000);
    await generate(desk, thisWeek().start);
    const row = await mine(desk, thisWeek().start, t);
    expect((await admin.send('PUT', `/payrolls/${row.id}/deductions`, { amount: 20_450, agreed: true })).status).toBe(200);
    expect(await mine(desk, thisWeek().start, t)).toMatchObject({ govDeferred: 0, govAgreed: true, net: 69_550 });
    await generate(desk, thisWeek().start);
    const again = await mine(desk, thisWeek().start, t);
    expect(again).toMatchObject({ govAgreed: true, net: 69_550 });
    await admin.send('PUT', `/payrolls/${again.id}/deductions`, { amount: null });
    expect(await mine(desk, thisWeek().start, t)).toMatchObject({ govAgreed: false, govDeferred: 20_450 });
  });

  it('shows an opening balance by its weeks, oldest paid first', async () => {
    const t = await therapist(admin);
    const weeks = [{ weekStart: '2026-02-23', amount: 20_450 }, { weekStart: '2026-03-30', amount: 20_450 }];
    expect((await admin.send('PUT', '/deferred-deductions/opening', { staffId: t, amount: 40_900, weeks })).status).toBe(200);
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 300_000);
    await generate(desk, thisWeek().start);
    const row = await mine(desk, thisWeek().start, t);
    expect(row.deferredOwed).toMatchObject({ total: 40_900, weeks: [{ number: 9 }, { number: 14 }] });
    await admin.send('PUT', `/payrolls/${row.id}/deductions`, { amount: 40_900 });
    expect((await mine(desk, thisWeek().start, t)).deferredOwed).toMatchObject({ total: 20_450, weeks: [{ number: 14 }] });
  });

  it('only the Super Admin can set their own figure for a Payroll, and it survives recomputing', async () => {
    const t = await therapist(admin);
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 90_000);
    await generate(desk, thisWeek().start);
    const row = await mine(desk, thisWeek().start, t);
    expect((await desk.send('PUT', `/payrolls/${row.id}/deductions`, { amount: 20_450 })).status).toBe(403);
    expect((await admin.send('PUT', `/payrolls/${row.id}/deductions`, { amount: 20_450 })).status).toBe(200);
    expect(await mine(desk, thisWeek().start, t)).toMatchObject({ govDeferred: 0, govOverride: 20_450, net: 69_550 });
    await generate(desk, thisWeek().start);
    expect(await mine(desk, thisWeek().start, t)).toMatchObject({ govOverride: 20_450, net: 69_550 });
    expect((await admin.send('PUT', `/payrolls/${row.id}/deductions`, { amount: null })).status).toBe(404); // the draft was regenerated
    const again = await mine(desk, thisWeek().start, t);
    expect((await admin.send('PUT', `/payrolls/${again.id}/deductions`, { amount: null })).status).toBe(200);
    expect(await mine(desk, thisWeek().start, t)).toMatchObject({ govDeferred: 20_450, govOverride: null, net: 90_000 });
  });

  it('opening balances come from the record, and Not Enrolled staff owe nothing', async () => {
    const t = await therapist(admin);
    const none = await therapist(admin, { notEnrolled: true });
    const noneName = `D${n}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE pay_rules SET value_json = '"2026-11-08"' WHERE key = 'go_live_date'`).run();
    const week = (id: string, start: string, gross: number, net: number) => env.DB.prepare(`INSERT INTO past_therapist_weeks (id, week_start, staff_id, gross, days_worked, net, created_at) VALUES (?, ?, ?, ?, 5, ?, ?)`).bind(crypto.randomUUID(), start, id, gross, net, now);
    await env.DB.batch([week(t, '2026-03-02', 400_000, 379_550), week(t, '2026-03-09', 60_000, 60_000), week(t, '2026-03-16', 0, -20_450), week(none, '2026-03-02', 400_000, 400_000)]);

    expect(await owed(admin, t)).toMatchObject({ suggested: 40_900, opening: null, balance: 0 });
    expect((await owed(admin, none)).suggested).toBe(0);
    expect((await desk.send('PUT', '/deferred-deductions/opening', { staffId: t, amount: 40_900 })).status).toBe(403);
    expect((await desk.get('/deferred-deductions')).status).toBe(403);
    expect((await admin.send('PUT', '/deferred-deductions/opening', { staffId: t, amount: 40_900 })).status).toBe(200);
    expect((await admin.send('PUT', '/deferred-deductions/opening', { staffId: t, amount: 30_000 })).status).toBe(200);
    expect(await owed(admin, t)).toMatchObject({ opening: 30_000, balance: 30_000 });

    const [, day] = daysOf(thisWeek());
    await worked(none, day!, 300_000);
    await generate(desk, thisWeek().start);
    expect(await mine(desk, thisWeek().start, none)).toMatchObject({ govSss: 0, govDeferred: 0, net: 300_000 });
    const { items } = await json<{ items: { key: string; detail: string | null }[] }>(await admin.get('/attention'));
    expect(items.find((i) => i.key === 'government-ids')?.detail ?? '').not.toContain(noneName);
  });
});

describe('The first Pay Week', () => {
  it('adds Commission from before Go-live and can’t be approved without it', async () => {
    const w = thisWeek();
    const days = daysOf(w);
    await env.DB.prepare(`UPDATE pay_rules SET value_json = ? WHERE key = 'go_live_date'`).bind(JSON.stringify(days[6])).run();
    const t = await therapist(admin);
    await worked(t, days[6]!, 50_000);
    // Days before Go-live were never run here, so they can stay open.
    await env.DB.prepare(`INSERT INTO business_days (date, opened_at) VALUES (?, 'x')`).bind(days[1]).run();
    expect((await week(desk, w.start)).unclosedDays).toEqual([]);

    expect((await week(desk, w.start)).beforeGoLive).toEqual([expect.objectContaining({ staffId: t, amount: null })]);
    expect((await generate(desk, w.start)).status).toBe(200);
    const row = await mine(desk, w.start, t);
    const blocked = await admin.post(`/payrolls/${row.id}/approve`);
    expect(blocked.status).toBe(409);
    expect((await json<{ error: string }>(blocked)).error).toBe('before_go_live_missing');

    expect((await desk.send('PUT', `/payroll/weeks/${w.start}/before-go-live`, { staffId: t, amount: 200_000 })).status).toBe(200);
    await generate(desk, w.start);
    const ready = await mine(desk, w.start, t);
    expect(ready).toMatchObject({ gross: 250_000, commissionBefore: 200_000, govDeferred: 0, net: 250_000 - 20_450 });
    expect((await admin.post(`/payrolls/${ready.id}/approve`)).status).toBe(200);
    expect((await desk.send('PUT', `/payroll/weeks/${w.start}/before-go-live`, { staffId: t, amount: 1 })).status).toBe(409);
  });

  it('doesn’t ask for it in any other week', async () => {
    const w = thisWeek();
    expect((await week(desk, w.start)).beforeGoLive).toBeNull();
    expect((await desk.send('PUT', `/payroll/weeks/${w.start}/before-go-live`, { staffId: 'x', amount: 1 })).status).toBe(409);
  });
});

describe('Government Deduction Refund', () => {
  type Refund = { sss: number; phic: number; pagibig: number; total: number; applied: number; cash: number; status?: string | null };
  const refunds = async (c: Client) => json<{ people: { staffId: string; kind: string; owed: number; refund: Refund | null }[] }>(await c.get('/deduction-refunds'));
  const refund = (c: Client, staffId: string, weekStart: string, shares = { sss: -3_200, phic: 20_000, pagibig: 12_800 }) => c.post('/deduction-refunds', { staffId, weekStart, ...shares });
  const opening = (t: string, weeks: { weekStart: string; amount: number }[]) => admin.send('PUT', '/deferred-deductions/opening', { staffId: t, amount: weeks.reduce((s, w) => s + w.amount, 0), weeks });

  it('clears what a Therapist owes first, oldest week first, and pays no cash while they still owe', async () => {
    const t = await therapist(admin);
    await opening(t, [
      { weekStart: '2025-12-29', amount: 20_450 },
      { weekStart: '2026-01-05', amount: 20_450 },
      { weekStart: '2026-03-30', amount: 20_450 },
    ]);
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 300_000);
    await generate(desk, thisWeek().start);

    expect((await refund(desk, t, thisWeek().start)).status).toBe(403);
    expect((await desk.get('/deduction-refunds')).status).toBe(403);
    const res = await refund(admin, t, thisWeek().start);
    expect(res.status).toBe(201);
    expect(await json<Refund>(res)).toMatchObject({ total: 29_600, applied: 29_600, cash: 0 });
    expect((await owed(admin, t)).balance).toBe(61_350 - 29_600);

    const row = await mine(desk, thisWeek().start, t);
    expect(row).toMatchObject({ gross: 300_000, refund: { sss: -3_200, phic: 20_000, pagibig: 12_800, applied: 29_600, cash: 0 } });
    expect(row.deferredOwed).toMatchObject({ total: 31_750, weeks: [{ number: 2, amount: 11_300 }, { number: 14, amount: 20_450 }] });

    expect((await refund(admin, t, thisWeek().start)).status).toBe(409); // one refund each
    expect((await admin.send('DELETE', `/deduction-refunds/${t}`)).status).toBe(200);
    expect((await owed(admin, t)).balance).toBe(61_350);
  });

  it('adds what is left after the balance to the Payroll as its own line', async () => {
    const t = await therapist(admin);
    await opening(t, [{ weekStart: '2026-02-16', amount: 20_450 }]);
    const [, day] = daysOf(thisWeek());
    await worked(t, day!, 300_000);
    await generate(desk, thisWeek().start);
    const before = await mine(desk, thisWeek().start, t);

    expect(await json<Refund>(await refund(admin, t, thisWeek().start))).toMatchObject({ applied: 20_450, cash: 9_150 });
    const row = await mine(desk, thisWeek().start, t);
    expect(row).toMatchObject({ gross: 309_150, net: before.net + 9_150, deferredOwed: { total: 0 } });
    const adjustments = (row as unknown as { adjustments: { id: string; label: string; amount: number }[] }).adjustments;
    expect(adjustments).toEqual([expect.objectContaining({ label: 'Government Deduction Refund', amount: 9_150 })]);

    // Removed only with the refund itself, so the balance and the cash stay together.
    expect((await admin.send('DELETE', `/payrolls/${row.id}/adjustments/${adjustments[0]!.id}`)).status).toBe(409);
    expect((await admin.post(`/payrolls/${row.id}/approve`)).status).toBe(200);
    expect((await admin.send('DELETE', `/deduction-refunds/${t}`)).status).toBe(409);
    expect((await refunds(admin)).people.find((p) => p.staffId === t)?.refund).toMatchObject({ cash: 9_150, status: 'approved' });
  });

  it('pays the Receptionist in cash on a Sunday Pay Week, and never refunds below zero', async () => {
    const { id: r } = await json<{ id: string }>(await admin.post('/settings/staff', { ...PERSON, firstName: 'Desk', lastName: 'Test', displayName: 'Desk', kind: 'receptionist', dailyRate: 69_200 }));
    const sunday = lastCompletedPayWeek(businessDayOf(new Date())).start;
    expect((await refund(admin, r, thisWeek().start)).status).toBe(422); // a Monday
    expect((await refund(admin, r, sunday, { sss: -10_000, phic: 5_000, pagibig: 5_000 })).status).toBe(422);
    const res = await refund(admin, r, sunday, { sss: 38_740, phic: 25_154, pagibig: 37_361 });
    expect(await json<Refund>(res)).toMatchObject({ total: 101_255, applied: 0, cash: 101_255 });
    expect((await refunds(admin)).people.find((p) => p.staffId === r)).toMatchObject({ kind: 'receptionist', owed: 0, refund: { cash: 101_255, status: null } });
  });
});

describe('Pay Weeks by kind', () => {
  it('a Therapist’s Payroll needs a Monday, the Receptionist’s a Sunday', async () => {
    const t = thisWeek().start;
    const sunday = lastCompletedPayWeek(businessDayOf(new Date())).start;
    expect((await admin.post(`/payroll/weeks/${t}/generate`, { kind: 'receptionist' })).status).toBe(409);
    expect((await admin.post(`/payroll/weeks/${sunday}/generate`, { kind: 'therapist' })).status).toBe(409);
    expect((await json<{ kinds: string[] }>(await admin.get(`/payroll/weeks/${t}`))).kinds).toEqual(['therapist']);
    expect((await json<{ kinds: string[] }>(await admin.get(`/payroll/weeks/${sunday}`))).kinds).toEqual(['receptionist', 'reliever']);
    expect((await json<{ kinds: string[] }>(await desk.get(`/payroll/weeks/${sunday}`))).kinds).toEqual([]);
  });
});
