import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, REPORTS } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Report = { columns: { key: string }[]; rows: Record<string, string | number | null>[]; totals: Record<string, string | number | null> };
const today = () => businessDayOf(new Date());

let n = 0;
async function therapist(admin: Client): Promise<{ id: string; name: string }> {
  const name = `R${++n}-${crypto.randomUUID().slice(0, 4)}`;
  const { id } = await json<{ id: string }>(await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass: 'regular' }));
  await admin.post(`/settings/staff/${id}/pin`, { pin: '1234' });
  await admin.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' });
  return { id, name };
}

async function served(desk: Client, therapistId: string, serviceId = 'thai-60'): Promise<string> {
  const { id } = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId }));
  const s = await json<{ room: { roomId: number; flexMode: string | null } }>(await desk.get(`/bookings/${id}/suggest`));
  await desk.post(`/bookings/${id}/start`, { therapistId, roomId: s.room.roomId, flexMode: s.room.flexMode, overrideReason: 'test picks the therapist' });
  await desk.post(`/bookings/${id}/done`);
  return id;
}

const report = async (c: Client, name: string, from = today(), to = today()) => c.get(`/reports/${name}?from=${from}&to=${to}`);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`UPDATE dtr SET clock_out = ? WHERE clock_out IS NULL`).bind(new Date().toISOString()),
    env.DB.prepare(`DELETE FROM payments`),
    env.DB.prepare(`DELETE FROM sale_addons`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM cash_outs`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM business_days`),
  ]);
});

describe('reports', () => {
  it('adds up a day of sales, per therapist and by FOC', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    // Thai ₱500 paid cash; Thai ₱500 Senior → ₱400 by GCash.
    const b1 = await served(desk, t.id);
    expect((await desk.post('/sales', { bookingId: b1, payments: [{ method: 'cash', amount: 50000 }] })).status).toBe(201);
    const b2 = await served(desk, t.id);
    expect((await desk.post('/sales', { bookingId: b2, statutory: { kind: 'senior', idNumber: 'SC-1' }, payments: [{ method: 'gcash', amount: 40000, gcashRef: '123' }] })).status).toBe(201);
    await desk.post('/cash-outs', { category: 'petty_cash', amount: 10000, purpose: 'Rice' });

    const daily = (await json<{ report: Report }>(await report(desk, 'daily-sales'))).report;
    expect(daily.rows).toEqual([
      expect.objectContaining({ date: today(), guests: 2, regular: 100000, discounts: 10000, services: 90000, setAside: 0, cash: 50000, gcash: 40000, cashOuts: 10000, commission: 30000 }),
    ]);

    const people = (await json<{ report: Report }>(await report(admin, 'therapist-sales'))).report;
    expect(people.rows.find((r) => r.name === t.name)).toMatchObject({ days: 1, services: 2, regular: 100000, paid: 90000, commission: 30000, focs: 0 });

    const focs = (await json<{ report: Report }>(await report(admin, 'foc'))).report;
    expect(focs.rows).toEqual([expect.objectContaining({ group: 'Senior Citizen (20%)', count: 1, discount: 10000, paid: 40000 })]);

    const times = (await json<{ report: Report }>(await report(admin, 'service-times'))).report;
    expect(times.totals.total).toBe(2);

    const g = (await json<{ report: Report }>(await report(desk, 'guests'))).report;
    expect(g.rows[0]).toMatchObject({ guests: 2, walkIns: 2, scheduled: 0 });
  });

  it('gives the Receptionist today’s sales and guests only', async () => {
    const desk = await loggedIn('receptionist');
    expect((await report(desk, 'daily-sales')).status).toBe(200);
    expect((await report(desk, 'daily-sales', '2026-01-01', today())).status).toBe(403);
    expect((await report(desk, 'therapist-sales')).status).toBe(403);
    expect((await report(desk, 'expenses')).status).toBe(403);
  });

  it('runs every report for the Super Admin over a range, and refuses bad ranges', async () => {
    const admin = await loggedIn('super_admin');
    for (const name of REPORTS) expect((await report(admin, name, '2026-01-01', today())).status, name).toBe(200);
    expect((await report(admin, 'daily-sales', today(), '2026-01-01')).status).toBe(400);
    expect((await report(admin, 'daily-sales', '2020-01-01', today())).status).toBe(400);
    expect((await report(admin, 'nope')).status).toBe(404);
  });
});
