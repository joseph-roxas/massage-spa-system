import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, daysOf, lastCompletedPayWeek, monthOf, percentageTaxDue, previousQuarter, quarterOf, quarterRange, weeklyPart } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const today = () => businessDayOf(new Date());
const IDS = { sssNo: '34-1234567-8', phicNo: '12-345678901-2', pagibigNo: '1234-5678-9012' };

let n = 0;
async function newStaff(admin: Client, fields: Record<string, unknown>): Promise<string> {
  const name = `F${++n}`;
  const res = await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, ...fields });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/** A paid sale on `day`, with its payment. */
async function sold(day: string, amount: number, commission: number, extra: { discount?: number } = {}) {
  const now = new Date().toISOString();
  const booking = crypto.randomUUID();
  const sale = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO business_days (date, opened_at, closed_at) VALUES (?, ?, ?)`).bind(day, now, now),
    env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?)`).bind(booking, day, now),
    env.DB.prepare(
      `INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, discount_amount, service_amount, amount_due, commission_bp, commission_amount, created_at)
       VALUES (?, ?, ?, 'paid', 'swedish-60', (SELECT id FROM staff LIMIT 1), ?, ?, ?, ?, ?, 3000, ?, ?)`,
    ).bind(sale, booking, day, amount + (extra.discount ?? 0), extra.discount ? 'senior' : 'none', extra.discount ?? 0, amount, amount, commission, now),
    env.DB.prepare(`INSERT INTO payments (id, sale_id, business_day, method, amount, created_at) VALUES (?, ?, ?, 'cash', ?, ?)`).bind(crypto.randomUUID(), sale, day, amount, now),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM percentage_tax_filings`),
    env.DB.prepare(`DELETE FROM expenses WHERE contributions_month IS NOT NULL OR category_id = 'bir'`),
    env.DB.prepare(`DELETE FROM payments`),
    env.DB.prepare(`DELETE FROM sale_addons`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM payrolls`),
    env.DB.prepare(`DELETE FROM dtr`),
    env.DB.prepare(`DELETE FROM business_days`),
    env.DB.prepare(`UPDATE staff SET active = 0`),
  ]);
});

describe('employer contributions', () => {
  it('drafts the month’s employer share from each bracket, only for agencies with an ID on file', async () => {
    const admin = await loggedIn('super_admin');
    await newStaff(admin, { kind: 'therapist', therapistClass: 'regular', contributionBase: 800000, ...IDS });
    await newStaff(admin, { kind: 'receptionist', dailyRate: 69200, contributionBase: 1690000, ...IDS });
    // No government IDs yet: nothing to remit for her.
    await newStaff(admin, { kind: 'therapist', therapistClass: 'regular', contributionBase: 800000 });
    expect((await admin.post('/settings/staff', { ...PERSON, firstName: 'X', lastName: 'Y', displayName: 'XY', kind: 'therapist', therapistClass: 'regular', isOnCall: true, contributionBase: 800000 })).status).toBe(400);

    const month = monthOf(today());
    expect(await json(await admin.post('/expenses/contributions/draft', { month }))).toEqual({ amount: 122000 + 235250 });
    const row = await env.DB.prepare(`SELECT amount, status, category_id FROM expenses WHERE contributions_month = ?`).bind(month).first<{ amount: number; status: string; category_id: string }>();
    expect(row).toEqual({ amount: 357250, status: 'pending', category_id: 'employer-contributions' });
    // Recomputing replaces the draft rather than adding another.
    await admin.post('/expenses/contributions/draft', { month });
    expect((await env.DB.prepare(`SELECT count(*) AS n FROM expenses WHERE contributions_month = ?`).bind(month).first<{ n: number }>())!.n).toBe(1);
  });

  it('deducts the monthly employee share over the Pay Weeks ending in the month', async () => {
    const admin = await loggedIn('super_admin');
    const t = await newStaff(admin, { kind: 'therapist', therapistClass: 'regular', contributionBase: 800000, sssNo: IDS.sssNo });
    const week = lastCompletedPayWeek(today());
    const day = daysOf(week)[1]!;
    await sold(day, 50000, 15000);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO dtr (id, staff_id, business_day, clock_in, clock_out, source, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?)`)
      .bind(crypto.randomUUID(), t, day, now, now, now)
      .run();
    await env.DB.prepare(`UPDATE sales SET therapist_id = ?`).bind(t).run();
    expect((await admin.post(`/payroll/weeks/${week.start}/generate`, { kind: 'therapist' })).status).toBe(200);
    const { payrolls } = await json<{ payrolls: { staffId: string; govSss: number; govPhic: number; govPagibig: number }[] }>(await admin.get(`/payroll/weeks/${week.start}`));
    // Only SSS is on file: ₱400 a month, split over that month's Saturdays.
    expect(payrolls.find((p) => p.staffId === t)).toMatchObject({ govSss: weeklyPart(40000, week.end), govPhic: 0, govPagibig: 0 });
  });
});

describe('Percentage Tax (2551Q)', () => {
  it('is 3% of the quarter’s payments, due 25 days after, and recorded as a BIR Expense once filed', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const q = previousQuarter(quarterOf(today()));
    const { start, end } = quarterRange(q);
    await sold(start, 300000, 90000);
    await sold(end, 200000, 60000);

    expect((await desk.get(`/finance/percentage-tax?quarter=${q}`)).status).toBe(403);
    const status = await json<{ grossSales: { total: number }; tax: number; dueOn: string; filing: unknown }>(await admin.get(`/finance/percentage-tax?quarter=${q}`));
    expect(status).toMatchObject({ grossSales: { total: 500000 }, tax: 15000, filing: null });
    expect(status.dueOn >= percentageTaxDue(q)).toBe(true);
    expect((await json<{ due: { quarter: string } | null }>(await admin.get('/finance/percentage-tax/due'))).due).toMatchObject({ quarter: q });

    expect((await admin.post(`/finance/percentage-tax/${quarterOf(today())}/file`, { filedOn: today(), amountPaid: 1 })).status).toBe(409); // not over yet
    expect((await admin.post(`/finance/percentage-tax/${q}/file`, { filedOn: today(), amountPaid: 15000 })).status).toBe(201);
    expect((await admin.post(`/finance/percentage-tax/${q}/file`, { filedOn: today(), amountPaid: 15000 })).status).toBe(409);
    expect((await json<{ due: unknown }>(await admin.get('/finance/percentage-tax/due'))).due).toBeNull();
    const bir = await env.DB.prepare(`SELECT amount, status FROM expenses WHERE category_id = 'bir'`).first();
    expect(bir).toEqual({ amount: 15000, status: 'confirmed' });
  });
});

describe('Income Statement', () => {
  it('is revenue less costs for the period, beside the same period last year', async () => {
    const admin = await loggedIn('super_admin');
    const day = today();
    await sold(day, 40000, 15000, { discount: 10000 });
    await env.DB.prepare(`INSERT INTO expenses (id, category_id, date, amount, description, status, created_at) VALUES (?, 'electricity', ?, 5000, 'Meralco', 'confirmed', ?)`)
      .bind(crypto.randomUUID(), day, new Date().toISOString())
      .run();
    await env.DB.prepare(`INSERT INTO expenses (id, category_id, date, amount, description, status, created_at) VALUES (?, 'bookkeeping', ?, 125000, 'Draft', 'pending', ?)`)
      .bind(crypto.randomUUID(), day, new Date().toISOString())
      .run();

    type Line = { label: string; amount: number };
    type S = { revenueTotal: number; costTotal: number; net: number; discounts: number; costs: Line[]; pending: Line[] };
    const res = await json<{ current: S; lastYear: S & { from: string } }>(await admin.get(`/finance/income-statement?from=${day}&to=${day}`));
    expect(res.current).toMatchObject({ revenueTotal: 40000, discounts: 10000, costTotal: 20000, net: 20000 });
    expect(res.current.costs).toEqual(
      expect.arrayContaining([
        { label: 'Therapist commission', amount: 15000 },
        { label: 'Electricity', amount: 5000 },
      ]),
    );
    expect(res.current.pending).toEqual([{ label: 'Bookkeeping', amount: 125000 }]);
    expect(res.lastYear).toMatchObject({ from: `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`, revenueTotal: 0 });
    await env.DB.prepare(`DELETE FROM expenses WHERE description IN ('Meralco', 'Draft')`).run();
  });
});
