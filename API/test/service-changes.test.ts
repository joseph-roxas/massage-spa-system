import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf } from '@spa/domain';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Board = { next: string | null; rotation: { staffId: string; status: string }[]; bookings: { id: string; serviceId: string; durationMin: number; therapistId: string | null; endsAt: string | null; topUpMin: number }[] };
type Sale = { bookingId: string; therapistId: string; serviceId: string; regularPrice: number; topUpsTotal: number; setAside: number; amountDue: number; commissionAmount: number };

let n = 0;
async function therapist(admin: Client, therapistClass: 'regular' | 'lmt' = 'regular'): Promise<string> {
  const name = `C${++n}`;
  const { id } = await json<{ id: string }>(await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass, ...(therapistClass === 'lmt' ? { qualification: 'doh' } : {}) }));
  await admin.post(`/settings/staff/${id}/pin`, { pin: '1234' });
  await admin.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' });
  return id;
}

let room = 0;
async function inService(desk: Client, t: string, serviceId = 'swedish-60'): Promise<string> {
  const { id } = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId }));
  const res = await desk.post(`/bookings/${id}/start`, { therapistId: t, roomId: (room++ % 7) + 1, flexMode: null, overrideReason: 'test picks the therapist' });
  expect(res.status).toBe(200);
  return id;
}

const today = () => businessDayOf(new Date());
const board = (c: Client) => c.get('/front-desk').then((r) => json<Board>(r));
const line = (b: Board, id: string) => b.bookings.find((x) => x.id === id)!;
async function checkout(desk: Client, id: string, body: Record<string, unknown> = {}, amount?: number): Promise<Sale> {
  await desk.post(`/bookings/${id}/done`);
  const quote = await json<{ amountDue: number }>(await desk.post('/sales/quote', { bookingId: id, ...('statutory' in body ? { statutory: 'senior' } : {}) }));
  const due = amount ?? quote.amountDue;
  const res = await desk.post('/sales', { bookingId: id, ...body, payments: due ? [{ method: 'cash', amount: due }] : [] });
  expect(res.status).toBe(201);
  const { sales } = await json<{ sales: Sale[] }>(await desk.get(`/sales?day=${today()}`));
  return sales.find((s) => s.bookingId === id)!;
}

beforeEach(async () => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE dtr SET clock_out = ? WHERE clock_out IS NULL`).bind(now),
    env.DB.prepare(`UPDATE bookings SET status = 'done', done_at = ? WHERE status = 'in_service'`).bind(now),
    env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE status IN ('waiting', 'scheduled')`),
  ]);
});

describe('Top-up', () => {
  it('lengthens the same Booking, more than once, and adds to the one sale', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const id = await inService(desk, t);
    expect((await desk.post(`/bookings/${id}/top-up`, {})).status).toBe(201);
    expect((await desk.post(`/bookings/${id}/top-up`, { steps: 2 })).status).toBe(201);
    const b = line(await board(desk), id);
    expect(b).toMatchObject({ durationMin: 150, topUpMin: 90, therapistId: t });
    // ₱500 + 3 × ₱250; 30% of the lot.
    expect(await checkout(desk, id)).toMatchObject({ regularPrice: 125000, topUpsTotal: 75000, amountDue: 125000, commissionAmount: 37500 });
  });

  it('asks which massage on a 1.5-hour Service, and takes the Set-aside only once', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const id = await inService(desk, t, 'aroma-90');
    expect((await desk.post(`/bookings/${id}/top-up`, {})).status).toBe(400);
    const options = await json<{ parts: { part: string; price: number }[] }>(await desk.get(`/bookings/${id}/top-up-options`));
    expect(options.parts).toEqual([{ part: 'head', price: 25000, hourPrice: null, steps: 0 }, { part: 'back', price: 25000, hourPrice: 45000, steps: 0 }, { part: 'foot', price: 25000, hourPrice: 45000, steps: 0 }]);
    expect((await desk.post(`/bookings/${id}/top-up`, { part: 'head' })).status).toBe(201);
    // (₱700 + ₱250 − ₱50) × 30%.
    expect(await checkout(desk, id)).toMatchObject({ regularPrice: 95000, setAside: 5000, commissionAmount: 27000 });
  });

  it('costs the set 30-minute price on Foot Massage at either length', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const id = await inService(desk, t, 'foot-60');
    expect((await json<{ price: number }>(await desk.get(`/bookings/${id}/top-up-options`))).price).toBe(25000);
  });

  it('is refused on a Combo and when it would run into a reservation', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const combo = await inService(desk, t, 'c1');
    expect((await desk.post(`/bookings/${combo}/top-up`, {})).status).toBe(409);
    await desk.post(`/bookings/${combo}/done`);
    const id = await inService(desk, t);
    // Reserved from 90 − 30 = 60 minutes from now, just when this hour ends.
    await desk.post('/bookings', { kind: 'scheduled', serviceId: 'swedish-60', guestName: 'Next', requestedTherapistId: t, scheduledAt: new Date(Date.now() + 91 * 60_000).toISOString() });
    const res = await desk.post(`/bookings/${id}/top-up`, {});
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toBe('therapist_reserved');
  });

  it('can be added at checkout, and a Voucher leaves it for the Guest to pay', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const id = await inService(desk, t);
    await desk.post(`/bookings/${id}/done`);
    expect((await desk.post(`/bookings/${id}/top-up`, {})).status).toBe(201);
    const q = await json<{ regularPrice: number; topUpsTotal: number; amountDue: number }>(await desk.post('/sales/quote', { bookingId: id, promoId: null }));
    expect(q).toMatchObject({ regularPrice: 50000, topUpsTotal: 25000, amountDue: 75000 });
  });
});

describe('an Added Service', () => {
  const rewind = (id: string, minutes: number) => env.DB.prepare(`UPDATE bookings SET started_at = ? WHERE id = ?`).bind(new Date(Date.now() - minutes * 60_000).toISOString(), id).run();
  type Row = Board['bookings'][number] & { status: string; startedAt: string | null; doneAt: string | null };
  const row = async (desk: Client, id: string) => line(await board(desk), id) as Row;

  it('starts by itself when the time is up and the Therapist is the same', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const first = await inService(desk, t);
    const { id: next } = await json<{ id: string }>(await desk.post(`/bookings/${first}/add-service`, { serviceId: 'ventosa-90' }));
    expect((await row(desk, next)).status).toBe('waiting');
    await rewind(first, 61);
    const before = await row(desk, first);
    expect(before).toMatchObject({ status: 'done' });
    const after = await row(desk, next);
    expect(after).toMatchObject({ status: 'in_service', therapistId: t });
    // It counts from when the first one ended, not from when someone looked.
    expect(after.startedAt).toBe(before.doneAt);
  });

  it('waits while time is left, and for a Top-up that adds more', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const first = await inService(desk, t);
    const { id: next } = await json<{ id: string }>(await desk.post(`/bookings/${first}/add-service`, { serviceId: 'thai-60' }));
    await desk.post(`/bookings/${first}/top-up`, {});
    await rewind(first, 61);
    expect((await row(desk, next)).status).toBe('waiting');
    await rewind(first, 91);
    expect((await row(desk, next)).status).toBe('in_service');
  });

  it('waits for the desk when another Therapist takes it', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const first = await inService(desk, a);
    const { id: next } = await json<{ id: string }>(await desk.post(`/bookings/${first}/add-service`, { serviceId: 'thai-60', therapistId: b }));
    await rewind(first, 61);
    expect((await row(desk, first)).status).toBe('in_service');
    expect((await row(desk, next)).status).toBe('waiting');
  });

  it('can be anything after a foot massage on the recliner, which becomes a floor bed', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const { id: first } = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId: 'foot-60' }));
    expect((await desk.post(`/bookings/${first}/start`, { therapistId: t, roomId: 8, flexMode: 'recliner', overrideReason: 'test' })).status).toBe(200);
    const res = await desk.post(`/bookings/${first}/add-service`, { serviceId: 'ventosa-90' });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const flex = (b: string) => env.DB.prepare(`SELECT flex_mode f FROM bookings WHERE id = ?`).bind(b).first<{ f: string }>();
    expect(await flex(id)).toEqual({ f: 'floor' });
    expect(await flex(first)).toEqual({ f: 'recliner' });
  });
});

describe('a longer time from the start', () => {
  const newBooking = (desk: Client, body: Record<string, unknown>) => desk.post('/bookings', { kind: 'walk_in', ...body });

  it('books 1.5 hours of Foot Massage as the menu price plus one Top-up', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const res = await newBooking(desk, { serviceId: 'foot-60', extraSteps: 1 });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    expect(line(await board(desk), id)).toMatchObject({ durationMin: 90, topUpMin: 30 });
    expect((await desk.post(`/bookings/${id}/start`, { therapistId: t, roomId: 3, flexMode: null, overrideReason: 'test' })).status).toBe(200);
    expect(await checkout(desk, id)).toMatchObject({ regularPrice: 70000, topUpsTotal: 25000, commissionAmount: 21000 });
  });

  it('charges a full extra hour at the 1-hour price, booked at once or added in halves', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const atOnce = await json<{ id: string }>(await newBooking(desk, { serviceId: 'foot-60', extraSteps: 2 }));
    expect((await desk.post(`/bookings/${atOnce.id}/start`, { therapistId: t, roomId: 4, flexMode: null, overrideReason: 'test' })).status).toBe(200);
    expect(await checkout(desk, atOnce.id)).toMatchObject({ regularPrice: 90000, topUpsTotal: 45000 });

    const halves = await inService(desk, t, 'foot-60');
    await desk.post(`/bookings/${halves}/top-up`, {});
    await desk.post(`/bookings/${halves}/top-up`, {});
    expect(await checkout(desk, halves)).toMatchObject({ regularPrice: 90000, topUpsTotal: 45000 });

    const more = await inService(desk, t, 'foot-60');
    await desk.post(`/bookings/${more}/top-up`, { steps: 3 });
    expect(await checkout(desk, more)).toMatchObject({ regularPrice: 115000, topUpsTotal: 70000 });
  });

  it('stays at the menu time by default, refuses a Combo, and asks which massage on 1.5-hour Services', async () => {
    const desk = await loggedIn('receptionist');
    const { id } = await json<{ id: string }>(await newBooking(desk, { serviceId: 'swedish-60' }));
    expect(line(await board(desk), id)).toMatchObject({ durationMin: 60, topUpMin: 0 });
    expect((await newBooking(desk, { serviceId: 'c1', extraSteps: 1 })).status).toBe(409);
    expect((await newBooking(desk, { serviceId: 'aroma-90', extraSteps: 1 })).status).toBe(400);
    expect((await newBooking(desk, { serviceId: 'aroma-90', extraSteps: 1, topUpPart: 'foot' })).status).toBe(201);
  });

  it('counts the longer time against a reservation', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    // Reserved from 90 minutes from now: a 1-hour walk-in fits, 2 hours doesn't.
    await desk.post('/bookings', { kind: 'scheduled', serviceId: 'swedish-60', guestName: 'Next', requestedTherapistId: t, scheduledAt: new Date(Date.now() + 121 * 60_000).toISOString() });
    expect((await newBooking(desk, { serviceId: 'swedish-60', requestedTherapistId: t })).status).toBe(201);
    expect((await newBooking(desk, { serviceId: 'swedish-60', requestedTherapistId: t, extraSteps: 2 })).status).toBe(409);
  });

  it('clears the added time if the Service is changed before it starts', async () => {
    const desk = await loggedIn('receptionist');
    const { id } = await json<{ id: string }>(await newBooking(desk, { serviceId: 'foot-60', extraSteps: 1 }));
    expect((await desk.send('PATCH', `/bookings/${id}`, { serviceId: 'thai-60' })).status).toBe(200);
    expect(line(await board(desk), id)).toMatchObject({ serviceId: 'thai-60', durationMin: 60, topUpMin: 0 });
  });
});

describe('Service Change', () => {
  it('charges only the new Service, from the original start, and clears Top-ups', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const id = await inService(desk, t, 'thai-60');
    await desk.post(`/bookings/${id}/top-up`, {});
    expect((await desk.post(`/bookings/${id}/change-service`, { serviceId: 'c1' })).status).toBe(400); // needs a reason
    expect((await desk.post(`/bookings/${id}/change-service`, { serviceId: 'thai-60', reason: 'nothing changes' })).status).toBe(400);
    expect((await desk.post(`/bookings/${id}/change-service`, { serviceId: 'aroma-90', reason: 'Guest prefers aroma' })).status).toBe(200);
    expect(line(await board(desk), id)).toMatchObject({ serviceId: 'aroma-90', durationMin: 90, topUpMin: 0 });
    expect(await checkout(desk, id)).toMatchObject({ serviceId: 'aroma-90', regularPrice: 70000, topUpsTotal: 0, setAside: 5000, commissionAmount: 19500 });
  });

  it('works before payment, but not after', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const id = await inService(desk, t, 'c1');
    await desk.post(`/bookings/${id}/done`);
    expect((await desk.post(`/bookings/${id}/change-service`, { serviceId: 'thai-60', reason: 'Emergency, cut short' })).status).toBe(200);
    expect(await checkout(desk, id)).toMatchObject({ regularPrice: 50000, commissionAmount: 15000 });
    expect((await desk.post(`/bookings/${id}/change-service`, { serviceId: 'swedish-60', reason: 'too late' })).status).toBe(409);
  });
});

describe('Therapist Change', () => {
  it('gives the whole Commission to the new Therapist at their rate and keeps the replaced one’s place', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const c = await therapist(admin, 'lmt');
    const id = await inService(desk, a);
    await env.DB.prepare(`UPDATE bookings SET started_at = ? WHERE id = ?`).bind(new Date(Date.now() - 30 * 60_000).toISOString(), id).run();

    expect((await desk.post(`/bookings/${id}/change-therapist`, { therapistId: c })).status).toBe(400);
    expect((await desk.post(`/bookings/${id}/change-therapist`, { therapistId: c, reason: 'Too strong' })).status).toBe(200);
    const state = await board(desk);
    expect(line(state, id).therapistId).toBe(c);
    // a is free again and still ahead of b.
    expect(state.next).toBe(a);
    expect(state.rotation.find((r) => r.staffId === a)?.status).toBe('free');

    const row = await env.DB.prepare(`SELECT from_therapist_id f, to_therapist_id t, minutes_served m, reason r FROM therapist_changes WHERE booking_id = ?`).bind(id).first<{ f: string; t: string; m: number; r: string }>();
    expect(row).toMatchObject({ f: a, t: c, m: 30, r: 'Too strong' });
    expect(await checkout(desk, id)).toMatchObject({ therapistId: c, commissionAmount: 20000 });
    expect(b).toBeTruthy();
  });

  it('shows in the reports, with subtotals per Therapist', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const id = await inService(desk, a);
    await desk.post(`/bookings/${id}/change-therapist`, { therapistId: b, reason: 'Pressure hurt the shoulder' });
    await checkout(desk, id);
    await checkout(desk, await inService(desk, a, 'aroma-90'));
    const range = `from=${today()}&to=${today()}`;
    type Report = { rows: Record<string, unknown>[]; totals: Record<string, unknown> };
    const changes = (await json<{ report: Report }>(await desk.get(`/reports/therapist-changes?${range}`))).report;
    expect(changes.rows.filter((r) => r.reason === 'Pressure hurt the shoulder')).toHaveLength(1);

    const one = (await json<{ report: Report }>(await desk.get(`/reports/therapist-detail?${range}&therapist=${b}`))).report;
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ regular: 50000, commission: 15000 });
    expect(String(one.rows[0]!.note)).toMatch(/Took over from .*Pressure hurt the shoulder/);

    const all = (await json<{ report: Report }>(await desk.get(`/reports/therapist-detail?${range}`))).report;
    expect(all.rows.filter((r) => r.rowKind !== 'subtotal').find((r) => r.commission === 19500)).toMatchObject({ regular: 70000, setAside: 5000 });
    expect(all.rows.some((r) => r.rowKind === 'subtotal')).toBe(true);
    const sum = all.rows.filter((r) => r.rowKind !== 'subtotal').reduce((s, r) => s + Number(r.commission), 0);
    expect(all.totals.commission).toBe(sum);
  });

  it('costs the new Therapist a place unless the Guest named them', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const c = await therapist(admin);
    const id = await inService(desk, a);
    await desk.post(`/bookings/${id}/change-therapist`, { therapistId: b, reason: 'Too strong' });
    await desk.post(`/bookings/${id}/done`);
    expect((await board(desk)).rotation.map((r) => r.staffId)).toEqual([a, c, b]);

    const named = await inService(desk, a);
    await desk.post(`/bookings/${named}/change-therapist`, { therapistId: c, reason: 'Guest asked for C', guestNamed: true });
    await desk.post(`/bookings/${named}/done`);
    expect((await board(desk)).rotation.map((r) => r.staffId)).toEqual([a, c, b]);
  });

  it('refuses a busy, off-duty or reserved Therapist, and a finished Service', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const c = await therapist(admin);
    const id = await inService(desk, a);
    await inService(desk, b);
    expect((await desk.post(`/bookings/${id}/change-therapist`, { therapistId: b, reason: 'Too strong' })).status).toBe(409);
    await desk.post('/bookings', { kind: 'scheduled', serviceId: 'swedish-60', guestName: 'Next', requestedTherapistId: c, scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    const reserved = await desk.post(`/bookings/${id}/change-therapist`, { therapistId: c, reason: 'Too strong' });
    expect((await json<{ error: string }>(reserved)).error).toBe('therapist_reserved');
    await desk.post(`/bookings/${id}/done`);
    expect((await desk.post(`/bookings/${id}/change-therapist`, { therapistId: c, reason: 'Too late' })).status).toBe(409);
  });
});
