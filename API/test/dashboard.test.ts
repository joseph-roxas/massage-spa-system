import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Dash = {
  month: string;
  current: boolean;
  top: { sales: number; expenses: number; profit: number; profitForecast: number | null; cashIn: number; cashOut: number; averageSale: number };
  days: { date: string; sales: number; expenses: number }[];
  government: { employee: number; employer: number; total: number; noBasis: number };
  tax: { quarter: string; forecast: number };
  royalty: { status: string; amount: number; owing: { months: number; total: number } };
  electricity: { month: string; amount: number }[];
  guests: { total: number; turnedAway: number; noShows: number; cancelled: number; noShowGuests: { name: string; count: number }[]; cancelReasons: { date: string; guest: string | null; reason: string | null }[] };
  topTherapists: { name: string; amount: number }[];
  topServices: { name: string; amount: number }[];
  consumables: { status: string };
  birthdays: { name: string; day: number }[];
};

const today = () => businessDayOf(new Date());
const dash = async (c: Client, month = today().slice(0, 7)) => json<Dash>(await c.get(`/dashboard?month=${month}`));

let n = 0;
async function therapist(admin: Client, fields: Record<string, unknown> = {}) {
  const name = `B${++n}`;
  const res = await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass: 'regular', ...fields });
  expect(res.status).toBe(201);
  return { id: (await json<{ id: string }>(res)).id, name };
}

async function sale(staffId: string, day: string, amount: number, commission: number) {
  const now = new Date().toISOString();
  const booking = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?)`).bind(booking, day, now),
    env.DB.prepare(
      `INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at) VALUES (?, ?, ?, 'paid', 'swedish-60', ?, ?, 'none', ?, ?, 3000, ?, ?)`,
    ).bind(crypto.randomUUID(), booking, day, staffId, amount, amount, amount, commission, now),
  ]);
}

const expense = (categoryId: string, date: string, amount: number, status = 'confirmed') =>
  env.DB.prepare(`INSERT INTO expenses (id, category_id, date, amount, description, status, created_at) VALUES (?, ?, ?, ?, 'Test', ?, ?)`)
    .bind(crypto.randomUUID(), categoryId, date, amount, status, new Date().toISOString())
    .run();

let admin: Client;

beforeEach(async () => {
  admin = await loggedIn('super_admin');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM rejects`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM expenses`),
    env.DB.prepare(`DELETE FROM royalty_statements`),
    env.DB.prepare(`DELETE FROM daily_summaries`),
    env.DB.prepare(`UPDATE staff SET active = 0`),
  ]);
});

describe('Dashboard', () => {
  it('is for the Super Admin', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.get('/dashboard')).status).toBe(403);
  });

  it('adds up the month and forecasts the current one', async () => {
    const t = await therapist(admin);
    const day = today();
    await sale(t.id, day, 100_000, 30_000);
    await expense('electricity', day, 20_000);
    await expense('electricity', day, 99_000, 'pending');

    const d = await dash(admin);
    expect(d.top).toMatchObject({ sales: 100_000, expenses: 50_000, profit: 50_000, averageSale: 100_000 });
    expect(d.guests.total).toBe(1);
    expect(d.days.find((x) => x.date === day)).toEqual({ date: day, sales: 100_000, expenses: 50_000 });
    expect(d.days.at(-1)?.date).toBe(day);
    expect(d.electricity.at(-1)).toEqual({ month: day.slice(0, 7), amount: 20_000 });
    expect(d.topTherapists).toEqual([expect.objectContaining({ name: t.name, amount: 100_000 })]);
    expect(d.topServices[0]?.amount).toBe(100_000);
    expect(d.consumables.status).toBe('building');
  });

  it('has no forecast for a finished month', async () => {
    const [y, m] = today().split('-').map(Number) as [number, number];
    const month = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    const d = await dash(admin, month);
    expect(d).toMatchObject({ month, current: false, top: { profitForecast: null } });
    expect(d.days.length).toBeGreaterThanOrEqual(28);
  });

  it('refuses a month that has not started', async () => {
    const [y, m] = today().split('-').map(Number) as [number, number];
    const month = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    expect((await admin.get(`/dashboard?month=${month}`)).status).toBe(400);
  });

  it('counts Daily Summaries in Guests and Sales', async () => {
    const day = today();
    await env.DB.prepare(`INSERT INTO daily_summaries (date, cash, gcash, oil, voucher, foc, commission, guests, therapists, rejects, laundry, expenses, updated_at) VALUES (?, 500000, 100000, 0, 0, 0, 180000, 12, 4, 3, 0, 0, ?)`)
      .bind(day, new Date().toISOString())
      .run();
    const d = await dash(admin);
    expect(d.top.sales).toBe(600_000);
    expect(d.guests).toMatchObject({ total: 12, turnedAway: 3 });
    expect(d.top.cashIn).toBe(600_000);
  });

  it('counts No-shows, cancellations and Rejects, with who and why', async () => {
    const day = today();
    const now = new Date().toISOString();
    const booking = (d: string, status: string, guest: string | null, reason: string | null = null, parent: string | null = null) =>
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, guest_name, cancel_reason, parent_booking_id, created_at) VALUES (?, ?, 'scheduled', ?, 'swedish-60', 60, ?, ?, ?, ?)`).bind(crypto.randomUUID(), d, status, guest, reason, parent, now);
    const added = crypto.randomUUID();
    await env.DB.batch([
      booking('2020-01-05', 'no_show', 'Ana Reyes'),
      booking(day, 'no_show', 'Ana Reyes'),
      booking(day, 'no_show', 'Ben Cruz'),
      booking(day, 'no_show', null),
      booking(day, 'cancelled', 'Cora Lim', 'Called to cancel'),
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?)`).bind(added, day, now),
      booking(day, 'cancelled', 'Dan Sy', 'Changed their mind', added),
      env.DB.prepare(`INSERT INTO rejects (id, business_day, reason, created_at) VALUES (?, ?, 'Full', ?)`).bind(crypto.randomUUID(), day, now),
    ]);
    const { guests } = await dash(admin);
    expect(guests).toMatchObject({ noShows: 3, cancelled: 1, turnedAway: 1 });
    expect(guests.noShowGuests).toEqual([{ name: 'Ana Reyes', count: 2 }, { name: 'Ben Cruz', count: 1 }]);
    expect(guests.cancelReasons).toEqual([{ date: day, guest: 'Cora Lim', reason: 'Called to cancel' }]);
  });

  it('shows the month’s Royalty as unpaid until confirmed, and adds up what is owing', async () => {
    const month = today().slice(0, 7);
    const row = (m: string, amount: number, status: string) =>
      env.DB.prepare(`INSERT INTO royalty_statements (month, month_start, month_end, service_sales, voucher_sales, gross_sales, bp, amount, status, computed_at) VALUES (?, ?, ?, 0, 0, 0, 300, ?, ?, ?)`)
        .bind(m, `${m}-01`, `${m}-28`, amount, status, new Date().toISOString())
        .run();
    expect((await dash(admin)).royalty).toMatchObject({ status: 'forecast', owing: { months: 0, total: 0 } });
    await row('2020-01', 10_000, 'draft');
    await row(month, 20_000, 'draft');
    expect((await dash(admin)).royalty).toEqual({ status: 'not_paid', amount: 20_000, owing: { months: 2, total: 30_000 } });
  });

  it('counts both shares for enrolled staff, leaving out Not Enrolled', async () => {
    await therapist(admin, { contributionBase: 800_000, sssNo: '1', phicNo: '2', pagibigNo: '3' });
    const one = (await dash(admin)).government;
    expect(one.total).toBe(one.employee + one.employer);
    expect(one.total).toBeGreaterThan(0);

    await therapist(admin, { contributionBase: 800_000, sssNo: '1', phicNo: '2', pagibigNo: '3', notEnrolled: true });
    expect((await dash(admin)).government.total).toBe(one.total);

    await therapist(admin);
    expect((await dash(admin)).government.noBasis).toBe(1);
  });

  it('lists birthdays in the month', async () => {
    const month = today().slice(5, 7);
    const t = await therapist(admin, { birthdate: `1995-${month}-09` });
    expect((await dash(admin)).birthdays).toEqual([{ name: t.name, day: 9 }]);
  });
});
