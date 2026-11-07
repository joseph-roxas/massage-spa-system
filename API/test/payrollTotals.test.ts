import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Totals = {
  from: string;
  to: string;
  people: { displayName: string; kind: string; gross: number; gov: number; net: number; notEnrolled: boolean; civilStatus: string | null }[];
  months: { month: string; therapists: number; receptionist: number; total: number }[];
  business: { name: string | null; tin: string | null };
};
const totals = async (c: Client, period: string, date: string) => json<Totals>(await c.get(`/payroll/totals?period=${period}&date=${date}`));

let admin: Client;
let t: string;
let r: string;

async function person(name: string, kind: string, fields: Record<string, unknown> = {}) {
  const res = await admin.post('/settings/staff', { ...PERSON, hireDate: '2025-01-06', firstName: name, lastName: 'Test', displayName: name, kind, civilStatus: 'single', ...(kind === 'therapist' ? { therapistClass: 'regular' } : { dailyRate: 69_200 }), ...fields });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

const week = (staffId: string, start: string, gross: number, net: number) =>
  env.DB.prepare(`INSERT INTO past_therapist_weeks (id, week_start, staff_id, gross, days_worked, net, created_at) VALUES (?, ?, ?, ?, 5, ?, ?)`).bind(crypto.randomUUID(), start, staffId, gross, net, new Date().toISOString());
const slip = (staffId: string, start: string, end: string, gross: number, net: number) =>
  env.DB.prepare(
    `INSERT INTO past_payslips (id, staff_id, week_start, week_end, daily_rate, days_worked, basic, overtime_hours, overtime_pay, premium_pay, late_undertime, sss, hdmf, phic, ca_repayment, gross, net, days_json, created_at) VALUES (?, ?, ?, ?, 0, 6, ?, 0, 0, 0, 0, 10000, 5000, 5000, 0, ?, ?, '[]', ?)`,
  ).bind(crypto.randomUUID(), staffId, start, end, gross, gross, net, new Date().toISOString());

beforeEach(async () => {
  admin = await loggedIn('super_admin');
  await env.DB.batch([env.DB.prepare(`DELETE FROM past_therapist_weeks`), env.DB.prepare(`DELETE FROM past_payslips`), env.DB.prepare(`DELETE FROM payroll_adjustments`), env.DB.prepare(`DELETE FROM deduction_ledger`), env.DB.prepare(`DELETE FROM payrolls`)]);
  await env.DB.prepare(`UPDATE pay_rules SET value_json = '"2026-11-08"' WHERE key = 'go_live_date'`).run();
  t = await person(`T${crypto.randomUUID().slice(0, 6)}`, 'therapist');
  r = await person(`R${crypto.randomUUID().slice(0, 6)}`, 'receptionist');
});

describe('Payroll totals', () => {
  it('are for the Super Admin', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.get('/payroll/totals?period=month')).status).toBe(403);
  });

  it('count a Pay Week in the month with most of its days, Therapists and Receptionist together', async () => {
    await env.DB.batch([
      week(t, '2026-08-31', 100_000, 79_550), // mostly September
      week(t, '2026-09-21', 200_000, 179_550),
      week(t, '2026-09-28', 400_000, 379_550), // Sep 28 to Oct 4: mostly October
      slip(r, '2026-08-30', '2026-09-05', 500_000, 480_000),
      slip(r, '2026-09-27', '2026-10-03', 600_000, 580_000), // Sep 27 to Oct 3: mostly September
    ]);
    const sep = await totals(admin, 'month', '2026-09-15');
    expect(sep).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(sep.people.find((p) => p.kind === 'therapist')).toMatchObject({ gross: 300_000, gov: 40_900, net: 259_100 });
    expect(sep.people.find((p) => p.kind === 'receptionist')).toMatchObject({ gross: 1_100_000, gov: 40_000, net: 1_060_000 });
    expect(sep.months).toEqual([expect.objectContaining({ month: '2026-09', therapists: 300_000, receptionist: 1_100_000, total: 1_400_000 })]);

    const year = await totals(admin, 'year', '2026-09-15');
    expect(year.months.map((m) => [m.month, m.total])).toEqual([['2026-09', 1_400_000], ['2026-10', 400_000]]);

    const oneWeek = await totals(admin, 'week', '2026-09-02');
    expect(oneWeek).toMatchObject({ from: '2026-08-31', to: '2026-09-06' });
    expect(oneWeek.people.map((p) => p.gross).sort()).toEqual([100_000, 500_000]);
  });

  it('leaves out a recorded week nobody earned in', async () => {
    await env.DB.batch([week(t, '2026-01-05', 0, -20_450)]);
    expect((await totals(admin, 'month', '2026-01-05')).people).toEqual([]);
  });

  it('don’t count the first Pay Week’s Commission before Go-live twice', async () => {
    await env.DB.batch([week(t, '2026-11-02', 100_000, 100_000)]);
    expect((await totals(admin, 'month', '2026-11-05')).people).toEqual([]);
  });

  it('carry the business’s TIN and address for printing, which stay private', async () => {
    await admin.send('PUT', '/branding', { businessName: 'Test Spa', logo: null, tin: '123-456', address: 'Cebu' });
    expect((await totals(admin, 'month', '2026-09-15')).business).toMatchObject({ name: 'Test Spa', tin: '123-456' });
    expect(await json(await admin.get('/branding'))).toEqual({ businessName: 'Test Spa', logo: null });
    expect(await json(await admin.get('/branding/details'))).toEqual({ tin: '123-456', address: 'Cebu' });
    const desk = await loggedIn('receptionist');
    expect((await desk.get('/branding/details')).status).toBe(403);
  });
});

describe('Past Therapist Payrolls', () => {
  it('the Receptionist can open weeks before go-live, read only, from the records', async () => {
    await env.DB.batch([week(t, '2026-09-14', 100_000, 79_550)]);
    const desk = await loggedIn('receptionist');
    const res = await desk.get('/payroll/weeks/2026-09-14');
    expect(res.status).toBe(200);
    const body = await json<{ fromRecords: { gross: number; net: number }[]; payrolls: unknown[] }>(res);
    expect(body.payrolls).toEqual([]);
    expect(body.fromRecords).toEqual([expect.objectContaining({ gross: 100_000, net: 79_550 })]);
  });
});
