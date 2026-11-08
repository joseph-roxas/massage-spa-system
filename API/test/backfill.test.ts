import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const YEAR = Number(businessDayOf(new Date()).slice(0, 4)) - 1;
const M = `${YEAR}-03`;
const day = (d: string, cash = 1_000_000) => ({ date: `${M}-${d}`, cash, gcash: 100_000, oil: 4_000, voucher: 150_000, foc: 20_000, commission: 350_000, guests: 12, therapists: 6, rejects: 1, laundry: 80_000, expenses: 5_000 });
const month = (over = {}) => ({
  days: [day('02'), day('03')],
  receptionistPay: 2_000_000,
  expenses: [
    { categoryId: 'electricity', description: 'VECO', amount: 800_000 },
    { categoryId: 'government', description: 'Employer share of contributions', amount: 300_000 },
  ],
  royalty: { serviceSales: 2_000_000, voucherSales: 0, grossSales: 2_000_000, bp: 300, amount: 60_000, paid: false },
  ...over,
});

const received = (1_000_000 + 100_000 + 150_000 - 20_000) * 2;

let admin: Client;

beforeEach(async () => {
  admin = await loggedIn('super_admin');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM daily_summaries`),
    env.DB.prepare(`DELETE FROM past_months`),
    env.DB.prepare(`DELETE FROM expenses WHERE backfill_month IS NOT NULL`),
    env.DB.prepare(`DELETE FROM royalty_statements WHERE fixed = 1`),
  ]);
});

describe('Backfill', () => {
  it('is for the Super Admin', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.send('PUT', `/backfill/months/${M}`, month())).status).toBe(403);
    expect((await desk.get('/backfill/status')).status).toBe(403);
    expect((await desk.get(`/daily-summaries/${M}-02`)).status).toBe(403);
  });

  it('adds Daily Summaries to the Income Statement, and saving again replaces the month', async () => {
    type Statement = { current: { revenue: { label: string; amount: number }[]; costs: { label: string; amount: number }[]; pending: { label: string }[] } };
    const statement = async () => (await json<Statement>(await admin.get(`/finance/income-statement?from=${YEAR}-01-01&to=${YEAR}-12-31`))).current;
    const line = (rows: { label: string; amount: number }[], label: string) => rows.find((r) => r.label === label)?.amount ?? 0;

    expect((await admin.send('PUT', `/backfill/months/${M}`, month())).status).toBe(200);
    expect((await admin.send('PUT', `/backfill/months/${M}`, month())).status).toBe(200);
    const s = await statement();
    expect(line(s.revenue, 'Services (after discounts)') + line(s.revenue, 'Vouchers sold')).toBe(received);
    expect(line(s.costs, 'Therapist commission')).toBe(700_000);
    expect(line(s.costs, 'Receptionist pay')).toBe(2_000_000);
    expect(line(s.costs, 'Electricity')).toBe(800_000);
    expect(line(s.costs, 'Government contributions (shop share)')).toBe(300_000);
    // Payable Royalty is not a cost yet; the daily Laundry never adds on top.
    expect(line(s.costs, 'Royalty')).toBe(0);
    expect(line(s.costs, 'Laundry')).toBe(0);

    const status = await json<{ months: { month: string; days: number; received: number }[] }>(await admin.get('/backfill/status'));
    expect(status.months).toEqual([{ month: M, days: 2, received }]);
  });

  it('keeps an imported Royalty fixed until it is marked paid', async () => {
    expect((await admin.send('PUT', `/backfill/months/${M}`, month())).status).toBe(200);
    expect((await admin.post(`/royalty/${M}/compute`)).status).toBe(409);
    const row = await env.DB.prepare(`SELECT amount, status FROM royalty_statements WHERE month = ?`).bind(M).first();
    expect(row).toMatchObject({ amount: 60_000, status: 'draft' });
    const pending = await env.DB.prepare(`SELECT status FROM expenses WHERE royalty_month = ?`).bind(M).first();
    expect(pending).toMatchObject({ status: 'pending' });
    expect((await admin.post(`/royalty/${M}/confirm`)).status).toBe(200);
    expect(await env.DB.prepare(`SELECT status FROM expenses WHERE royalty_month = ?`).bind(M).first()).toMatchObject({ status: 'confirmed' });

    // A month already paid comes in confirmed.
    await admin.send('PUT', `/backfill/months/${M}`, month({ royalty: { serviceSales: 2_000_000, voucherSales: 0, grossSales: 2_000_000, bp: 300, amount: 60_000, paid: true } }));
    expect(await env.DB.prepare(`SELECT status FROM royalty_statements WHERE month = ?`).bind(M).first()).toMatchObject({ status: 'confirmed' });
  });

  it('counts Daily Summaries toward 2551Q as money received', async () => {
    await admin.send('PUT', `/backfill/months/${M}`, month());
    const res = await json<{ grossSales: { total: number; vouchers: number } }>(await admin.get(`/finance/percentage-tax?quarter=${YEAR}-Q1`));
    expect(res.grossSales.total).toBeGreaterThanOrEqual(received);
    expect(res.grossSales.vouchers).toBeGreaterThanOrEqual(300_000);
  });

  it('shows on the Daily sales report, marked as summary only', async () => {
    await admin.send('PUT', `/backfill/months/${M}`, month());
    const { report } = await json<{ report: { rows: { date: string; source: string | null; guests: number; rejects: number; commission: number }[] } }>(await admin.get(`/reports/daily-sales?from=${M}-02&to=${M}-02`));
    expect(report.rows).toEqual([expect.objectContaining({ date: `${M}-02`, source: 'Summary only', guests: 12, rejects: 1, commission: 350_000 })]);
    const guests = await json<{ report: { rows: { guests: number }[] } }>(await admin.get(`/reports/guests?from=${M}-02&to=${M}-03`));
    expect(guests.report.rows.map((r) => r.guests)).toEqual([12, 12]);
  });

  it('refuses a day with real sales, and one day can be saved and removed by hand', async () => {
    const { date: _date, ...fields } = day('05');
    const { id: staffId } = await json<{ id: string }>(await admin.post('/settings/staff', { ...PERSON, firstName: 'Sale', lastName: 'Day', displayName: 'Sale', kind: 'therapist', therapistClass: 'regular', qualification: 'experience' }));
    const booking = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) SELECT ?, ?, 'walk_in', 'done', id, 60, 'x' FROM services LIMIT 1`).bind(booking, `${M}-09`),
      env.DB.prepare(`INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at) SELECT ?, ?, ?, 'paid', id, ?, 1, 'none', 1, 1, 3000, 0, 'x' FROM services LIMIT 1`).bind(crypto.randomUUID(), booking, `${M}-09`, staffId),
    ]);
    expect((await admin.send('PUT', `/daily-summaries/${M}-09`, fields)).status).toBe(409);
    expect((await admin.send('PUT', `/backfill/months/${M}`, month({ days: [day('09')] }))).status).toBe(409);

    expect((await admin.send('PUT', `/daily-summaries/${M}-05`, fields)).status).toBe(200);
    expect((await json<{ summary: { guests: number } }>(await admin.get(`/daily-summaries/${M}-05`))).summary.guests).toBe(12);
    expect((await admin.send('DELETE', `/daily-summaries/${M}-05`, {})).status).toBe(200);
    expect((await json<{ summary: null }>(await admin.get(`/daily-summaries/${M}-05`))).summary).toBeNull();
  });
});

describe('Past Payslips', () => {
  const slip = { weekStart: '2026-10-25', weekEnd: '2026-10-31', paidOn: '2026-11-04', dailyRate: 69_200, daysWorked: 7, basic: 484_400, overtimeHours: 58, overtimePay: 6_307, premiumPay: 20_760, lateUndertime: 5_046, sss: 21_250, hdmf: 5_000, phic: 10_563, caRepayment: 50_000, gross: 506_421, net: 419_608, caBalance: 500_000, days: [{ date: '2026-10-25', worked: true, timeIn: '14:00', timeOut: '23:10', hours: 9.17, lateHours: 0, overtimeHours: 0.17, note: null }] };

  it('shows them to the Super Admin and the person they belong to, and to nobody else', async () => {
    const desk = await loggedIn('receptionist');
    const other = await loggedIn('receptionist');
    const me = await json<{ user: { id: string } }>(await desk.get('/auth/me'));
    const { id: staffId } = await json<{ id: string }>(await admin.post('/settings/staff', { ...PERSON, firstName: 'Marie', lastName: 'Test', displayName: 'Marie', kind: 'receptionist', dailyRate: 69_200 }));
    await env.DB.prepare(`UPDATE staff SET user_id = ? WHERE id = ?`).bind(me.user.id, staffId).run();

    expect((await admin.send('PUT', '/backfill/past-payslips', { staffId, payslips: [slip] })).status).toBe(200);
    expect((await admin.send('PUT', '/backfill/past-payslips', { staffId, payslips: [{ ...slip, net: 419_609 }] })).status).toBe(200);

    const pay = await json<{ pastPayslips: { id: string; net: number }[] }>(await desk.get('/me/pay'));
    expect(pay.pastPayslips).toHaveLength(1);
    expect(pay.pastPayslips[0]!.net).toBe(419_609);
    const { id } = pay.pastPayslips[0]!;
    const mine = await json<{ payslip: { fullName: string; days: unknown[] } }>(await desk.get(`/past-payslips/${id}`));
    expect(mine.payslip.fullName).toBe('Marie Test');
    expect(mine.payslip.days).toHaveLength(1);
    expect((await admin.get(`/past-payslips/${id}`)).status).toBe(200);
    expect((await other.get(`/past-payslips/${id}`)).status).toBe(404);
    expect((await other.get('/past-payslips')).status).toBe(403);
  });
});
