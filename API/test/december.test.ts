import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, lastCompletedPayWeek } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Bonus = { id: string; staffId: string; kind: string; basis: number; amount: number; deduction: number; periodStart: string | null; periodEnd: string | null; paidAt: string | null };
type Suggestion = { period: { start: string; end: string }; commission: number; profitBefore: number; thirteenthMonth: number; profit: number; bp: number | null; scenarios: { bp: number }[]; lines: { staffId: string; commission: number; deferred: number }[] };

const finished = () => lastCompletedPayWeek(businessDayOf(new Date()), 'therapist');
const year = () => Number(finished().start.slice(0, 4));

let n = 0;
async function person(admin: Client, fields: Record<string, unknown>) {
  const name = `Y${++n}`;
  const res = await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, ...fields });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}
const therapist = (admin: Client, fields: Record<string, unknown> = {}) => person(admin, { kind: 'therapist', therapistClass: 'regular', ...fields });

const pastWeek = (staffId: string, weekStart: string, gross: number) =>
  env.DB.prepare(`INSERT INTO past_therapist_weeks (id, week_start, staff_id, gross, days_worked, net, created_at) VALUES (?, ?, ?, ?, 5, ?, ?)`)
    .bind(crypto.randomUUID(), weekStart, staffId, gross, gross, new Date().toISOString())
    .run();

async function sale(staffId: string, day: string, commission: number) {
  const now = new Date().toISOString();
  const booking = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?)`).bind(booking, day, now),
    env.DB.prepare(
      `INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at) VALUES (?, ?, ?, 'paid', 'swedish-60', ?, 50000, 'none', 50000, 50000, 3000, ?, ?)`,
    ).bind(crypto.randomUUID(), booking, day, staffId, commission, now),
  ]);
}

const pastPayslip = (staffId: string, weekStart: string, basic: number, late: number, caBalance: number | null) =>
  env.DB.prepare(
    `INSERT INTO past_payslips (id, staff_id, week_start, week_end, daily_rate, days_worked, basic, overtime_hours, overtime_pay, premium_pay, late_undertime, sss, hdmf, phic, ca_repayment, gross, net, ca_balance, days_json, created_at) VALUES (?, ?, ?, ?, 65000, 6, ?, 0, 0, 0, ?, 0, 0, 0, 0, ?, ?, ?, '[]', ?)`,
  )
    .bind(crypto.randomUUID(), staffId, weekStart, weekStart, basic, late, basic, basic, caBalance, new Date().toISOString())
    .run();

const bonusOf = async (c: Client, staffId: string, kind = 'year_end_bonus') =>
  (await json<{ bonuses: Bonus[] }>(await c.get(`/bonuses?year=${year()}`))).bonuses.find((b) => b.staffId === staffId && b.kind === kind)!;
const owed = async (c: Client, id: string) => (await json<{ people: { staffId: string; balance: number }[] }>(await c.get('/deferred-deductions'))).people.find((p) => p.staffId === id)!.balance;
const opening = (c: Client, staffId: string, amount: number) => c.send('PUT', '/deferred-deductions/opening', { staffId, amount });
const suggestion = async (c: Client, share?: number) => json<Suggestion>(await c.get(`/bonuses/year-end/suggestion?year=${year()}${share === undefined ? '' : `&share=${share}`}`));

let admin: Client;

beforeEach(async () => {
  admin = await loggedIn('super_admin');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM deduction_ledger`),
    env.DB.prepare(`DELETE FROM past_therapist_weeks`),
    env.DB.prepare(`DELETE FROM past_payslips`),
    env.DB.prepare(`DELETE FROM opening_basic_pay`),
    env.DB.prepare(`DELETE FROM bonuses`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM bookings`),
  ]);
});

describe('Year-end Bonus', () => {
  it('adds the weekly sheet to live Sales, through the last finished Pay Week only', async () => {
    const t = await therapist(admin);
    const w = finished();
    await pastWeek(t, w.start, 1_000_000);
    await sale(t, w.end, 200_000);
    await sale(t, businessDayOf(new Date()), 500_000); // this Pay Week has not finished

    expect((await admin.post('/bonuses/year-end', { year: year(), bp: 1000 })).status).toBe(200);
    expect(await bonusOf(admin, t)).toMatchObject({ basis: 1_200_000, amount: 120_000, deduction: 0, periodEnd: w.end });
  });

  it('leaves out On-call Therapists', async () => {
    const t = await therapist(admin, { isOnCall: true });
    await pastWeek(t, finished().start, 1_000_000);
    await admin.post('/bonuses/year-end', { year: year(), bp: 1000 });
    expect(await bonusOf(admin, t)).toBeUndefined();
  });

  it('starts the day after last year’s cut-off', async () => {
    const t = await therapist(admin);
    const w = finished();
    const cutOff = new Date(`${w.start}T00:00:00Z`);
    cutOff.setUTCDate(cutOff.getUTCDate() - 1);
    const end = cutOff.toISOString().slice(0, 10);
    await env.DB.prepare(`INSERT INTO bonuses (id, year, staff_id, kind, basis, amount, period_start, period_end, created_at) VALUES (?, ?, ?, 'year_end_bonus', 100, 10, '2000-01-03', ?, ?)`)
      .bind(crypto.randomUUID(), year() - 1, t, end, new Date().toISOString())
      .run();
    await pastWeek(t, w.start, 300_000);
    await sale(t, end, 900_000); // belongs to last year
    await admin.post('/bonuses/year-end', { year: year(), bp: 1000 });
    expect(await bonusOf(admin, t)).toMatchObject({ basis: 300_000, periodStart: w.start });
  });

  it('takes Deferred Deductions off when paid, not when computed', async () => {
    const t = await therapist(admin);
    await pastWeek(t, finished().start, 10_000_000);
    await opening(admin, t, 40_900);

    await admin.post('/bonuses/year-end', { year: year(), bp: 1000 });
    expect(await bonusOf(admin, t)).toMatchObject({ amount: 1_000_000, deduction: 40_900 });
    expect(await owed(admin, t)).toBe(40_900);

    expect((await admin.post(`/bonuses/${(await bonusOf(admin, t)).id}/paid`)).status).toBe(200);
    expect(await owed(admin, t)).toBe(0);
  });

  it('keeps what a small bonus can’t cover owing', async () => {
    const t = await therapist(admin);
    await pastWeek(t, finished().start, 100_000);
    await opening(admin, t, 40_900);
    await admin.post('/bonuses/year-end', { year: year(), bp: 1000 });
    expect(await bonusOf(admin, t)).toMatchObject({ amount: 10_000, deduction: 10_000 });
    await admin.post(`/bonuses/${(await bonusOf(admin, t)).id}/paid`);
    expect(await owed(admin, t)).toBe(30_900);
  });

  it('refuses to pay on old figures once the balance moved', async () => {
    const t = await therapist(admin);
    await pastWeek(t, finished().start, 10_000_000);
    await opening(admin, t, 40_900);
    await admin.post('/bonuses/year-end', { year: year(), bp: 1000 });
    await opening(admin, t, 20_000);
    const res = await admin.post(`/bonuses/${(await bonusOf(admin, t)).id}/paid`);
    expect(res.status).toBe(409);
    expect(await owed(admin, t)).toBe(20_000);
  });
});

describe('Bonus suggestion', () => {
  it('works from profit after 13th Month Pay and lists who gets what', async () => {
    const t = await therapist(admin);
    const r = await person(admin, { kind: 'receptionist', dailyRate: 65_000 });
    await sale(t, finished().end, 15_000); // ₱500 sale, ₱150 Commission
    await opening(admin, t, 5_000);
    await admin.send('PUT', '/bonuses/opening-basic', { year: year(), staffId: r, amount: 12_000 });

    const s = await suggestion(admin);
    expect(s.period.end).toBe(finished().end);
    expect(s.commission).toBe(15_000);
    expect(s.thirteenthMonth).toBe(1_000);
    expect(s.profit).toBe(s.profitBefore - 1_000);
    expect(s.lines).toEqual([{ staffId: t, displayName: expect.any(String), commission: 15_000, deferred: 5_000 }]);
    expect(s.scenarios.map((x) => x.bp)).toEqual(expect.arrayContaining([500, 600, 700]));
  });

  it('does not count bonuses already paid against the profit', async () => {
    const t = await therapist(admin);
    await sale(t, finished().end, 15_000);
    const before = (await suggestion(admin)).profitBefore;
    await admin.post('/bonuses/year-end', { year: year(), bp: 5000 });
    await admin.post(`/bonuses/${(await bonusOf(admin, t)).id}/paid`);
    expect((await suggestion(admin)).profitBefore).toBe(before);
  });

  it('is for the Super Admin', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.get(`/bonuses/year-end/suggestion?year=${year()}`)).status).toBe(403);
  });
});

describe('13th Month Pay opening', () => {
  it('adds the opening figure to basic pay, and suggests it from Past Payslips', async () => {
    const r = await person(admin, { kind: 'receptionist', dailyRate: 65_000 });
    await pastPayslip(r, `${year()}-01-04`, 390_000, 10_000, null);
    await pastPayslip(r, `${year()}-01-11`, 390_000, 0, 500_000);

    const people = async () => (await json<{ people: { staffId: string; amount: number | null; suggested: number }[] }>(await admin.get(`/bonuses/opening-basic?year=${year()}`))).people;
    expect((await people()).find((p) => p.staffId === r)).toMatchObject({ amount: null, suggested: 770_000 });

    expect((await admin.send('PUT', '/bonuses/opening-basic', { year: year(), staffId: r, amount: 1_200_000 })).status).toBe(200);
    expect((await admin.send('PUT', '/bonuses/opening-basic', { year: year(), staffId: r, amount: 2_400_000 })).status).toBe(200);
    expect((await people()).find((p) => p.staffId === r)?.amount).toBe(2_400_000);

    expect((await admin.post('/bonuses/thirteenth-month', { year: year() })).status).toBe(200);
    expect(await bonusOf(admin, r, 'thirteenth_month')).toMatchObject({ basis: 2_400_000, amount: 200_000 });
  });

  it('is for the Super Admin, and only for a Receptionist', async () => {
    const desk = await loggedIn('receptionist');
    const r = await person(admin, { kind: 'receptionist', dailyRate: 65_000 });
    const t = await therapist(admin);
    expect((await desk.send('PUT', '/bonuses/opening-basic', { year: year(), staffId: r, amount: 100 })).status).toBe(403);
    expect((await admin.send('PUT', '/bonuses/opening-basic', { year: year(), staffId: t, amount: 100 })).status).toBe(404);
  });

  it('suggests her opening Cash Advance from the last Past Payslip', async () => {
    const r = await person(admin, { kind: 'receptionist', dailyRate: 65_000 });
    await pastPayslip(r, `${year()}-01-04`, 390_000, 0, 600_000);
    await pastPayslip(r, `${year()}-01-11`, 390_000, 0, 500_000);
    const { balances } = await json<{ balances: { staffId: string; suggestedOpening?: number | null }[] }>(await admin.get('/cash-advances/balances'));
    expect(balances.find((b) => b.staffId === r)?.suggestedOpening).toBe(500_000);
  });
});
