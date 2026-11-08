import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Day = {
  times: { id: string; clockIn: string; clockOut: string }[];
  sales: { id: string; regularPrice: number; amountDue: number; commissionAmount: number; catchUp: boolean }[];
  expenses: { id: string }[];
  cashAdvances: { id: string }[];
  totals: { guests: number; sales: number; commission: number; expenses: number };
};

const person = async (admin: Client, displayName: string, extra: Record<string, unknown>) =>
  (await json<{ id: string }>(await admin.post('/settings/staff', { ...PERSON, firstName: displayName, lastName: 'Test', displayName, ...extra }))).id;

let admin: Client;
let t: string;
const day = async (d: string) => json<Day>(await admin.get(`/catch-up/${d}`));

beforeAll(async () => {
  admin = await loggedIn('super_admin');
  t = await person(admin, 'Catch', { kind: 'therapist', therapistClass: 'regular' });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('Nov 2–8 entry', () => {
  it('is for the Super Admin, and only those dates', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.get('/catch-up/2026-11-03')).status).toBe(403);
    expect((await admin.get('/catch-up/2026-11-09')).status).toBe(404);
  });

  it('prices a sale like checkout, with the Nov 2 Holiday rate and the Set-aside', async () => {
    const res = await admin.post('/catch-up/2026-11-02/sales', { time: '15:00', serviceId: 'aroma-90', therapistId: t });
    expect(res.status).toBe(201);
    // (₱700 − ₱50) at the 50% Holiday rate.
    expect(await json(res)).toMatchObject({ amountDue: 70000, commissionAmount: 32500 });
    const d = await day('2026-11-02');
    expect(d.sales).toHaveLength(1);
    expect(d.sales[0]).toMatchObject({ regularPrice: 70000, catchUp: true });
  });

  it('uses the ordinary rate on other days and applies Discounts and GCash', async () => {
    const senior = await admin.post('/catch-up/2026-11-03/sales', { time: '16:00', serviceId: 'thai-60', therapistId: t, statutory: 'senior', method: 'gcash' });
    expect(await json(senior)).toMatchObject({ amountDue: 40000, commissionAmount: 15000 });
    const happy = await admin.post('/catch-up/2026-11-03/sales', { time: '15:30', serviceId: 'swedish-60', therapistId: t, promoId: 'happy-hours' });
    expect(await json(happy)).toMatchObject({ amountDue: 45000, commissionAmount: 15000 });
    const late = await admin.post('/catch-up/2026-11-03/sales', { time: '20:00', serviceId: 'swedish-60', therapistId: t, promoId: 'happy-hours' });
    expect(late.status).toBe(409);
    expect((await day('2026-11-03')).totals).toMatchObject({ guests: 2, sales: 85000, commission: 30000 });
    // The refused line leaves nothing behind.
    const rows = await env.DB.prepare(`SELECT count(*) n FROM bookings WHERE business_day = '2026-11-03'`).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('closes the day without a cash count, so nothing blocks the Front Desk', async () => {
    const row = await env.DB.prepare(`SELECT closed_at, counted_cash FROM business_days WHERE date = '2026-11-03'`).first<{ closed_at: string | null; counted_cash: number | null }>();
    expect(row?.closed_at).toBeTruthy();
    expect(row?.counted_cash).toBeNull();
  });

  it('removes a sale it entered', async () => {
    const { id } = await json<{ id: string }>(await admin.post('/catch-up/2026-11-04/sales', { time: '15:00', serviceId: 'thai-60', therapistId: t }));
    expect((await admin.send('DELETE', `/catch-up/2026-11-04/sales/${id}`)).status).toBe(200);
    expect((await day('2026-11-04')).sales).toHaveLength(0);
    const rows = await env.DB.prepare(`SELECT count(*) n FROM bookings WHERE business_day = '2026-11-04'`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('keeps time records, past midnight too, already reviewed', async () => {
    const res = await admin.post('/catch-up/2026-11-05/time-records', { staffId: t, clockIn: '14:00', clockOut: '00:30' });
    expect(res.status).toBe(201);
    expect((await day('2026-11-05')).times[0]).toMatchObject({ clockIn: '14:00', clockOut: '00:30' });
    const row = await env.DB.prepare(`SELECT clock_in, clock_out, reviewed_at FROM dtr WHERE staff_id = ? AND business_day = '2026-11-05'`).bind(t).first<{ clock_in: string; clock_out: string; reviewed_at: string }>();
    expect(row?.clock_out).toBe('2026-11-05T16:30:00.000Z');
    expect(row?.reviewed_at).toBeTruthy();
    expect((await admin.post('/catch-up/2026-11-05/time-records', { staffId: t, clockIn: '18:00', clockOut: '14:00' })).status).toBe(400);
  });

  it('records Expenses and Cash Advances against that week, without touching Sales Cash', async () => {
    const { categories } = await json<{ categories: { id: string }[] }>(await admin.get('/catch-up/2026-11-06'));
    expect((await admin.post('/catch-up/2026-11-06/expenses', { categoryId: categories[0]!.id, description: 'Rice', amount: 15000 })).status).toBe(201);
    expect((await day('2026-11-06')).totals.expenses).toBe(15000);
    const res = await admin.post('/catch-up/2026-11-06/cash-advances', { staffId: t, amount: 50000 });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(`SELECT against_week_start w, cash_out_id c FROM cash_advances WHERE staff_id = ?`).bind(t).first<{ w: string; c: string | null }>();
    expect(row).toEqual({ w: '2026-11-02', c: null });
  });

  it('is go-live from Nov 2, so the week needs no Commission typed in', async () => {
    const row = await env.DB.prepare(`SELECT value_json v FROM pay_rules WHERE key = 'go_live_date'`).first<{ v: string }>();
    expect(JSON.parse(row!.v)).toBe('2026-11-02');
  });

  it('generates that week’s Payroll for the Therapist from what was entered', async () => {
    // The week has to be over.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T06:00:00Z') });
    admin = await loggedIn('super_admin');
    const res = await admin.post('/payroll/weeks/2026-11-02/generate', { kind: 'therapist' });
    expect(res.status).toBe(200);
    const { payrolls } = await json<{ payrolls: { staffId: string; gross: number; commissionBefore: number; lines: unknown }[] }>(await admin.get('/payroll/weeks/2026-11-02'));
    // ₱325 + ₱150 + ₱150, nothing typed in by hand.
    expect(payrolls.find((p) => p.staffId === t)).toMatchObject({ gross: 62500, commissionBefore: 0 });
  });

  it('pays the Receptionist the special-day premium on Nov 2', async () => {
    const desk = await person(admin, 'Front', { kind: 'receptionist', therapistClass: null, dailyRate: 69200 });
    expect((await admin.post('/catch-up/2026-11-02/time-records', { staffId: desk, clockIn: '14:00', clockOut: '23:00' })).status).toBe(201);
    expect((await admin.post('/catch-up/2026-11-03/time-records', { staffId: desk, clockIn: '14:00', clockOut: '23:00' })).status).toBe(201);
    expect((await admin.post('/payroll/weeks/2026-11-01/generate', { kind: 'receptionist' })).status).toBe(200);
    const { payrolls } = await json<{ payrolls: { staffId: string; gross: number }[] }>(await admin.get('/payroll/weeks/2026-11-01'));
    // ₱692 at 130% plus ₱692 ordinary.
    expect(payrolls.find((p) => p.staffId === desk)).toMatchObject({ gross: 89960 + 69200 });
  });
});
