import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Board = {
  next: string | null;
  rotation: { staffId: string; status: string; reservedFor: string | null }[];
  rooms: { id: number; booking: { id: string } | null }[];
  bookings: { id: string; status: string; therapistId: string | null; roomId: number | null }[];
};
type Suggestion = { therapist: { staffId: string; reason: string } | null; room: { roomId: number; flexMode: string | null } | null };

let n = 0;
async function therapist(admin: Client): Promise<string> {
  const name = `T${++n}`;
  const { id } = await json<{ id: string }>(
    await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass: 'regular' }),
  );
  await admin.post(`/settings/staff/${id}/pin`, { pin: '1234' });
  await admin.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' });
  return id;
}

async function walkIn(desk: Client, serviceId = 'swedish-60', requestedTherapistId: string | null = null): Promise<string> {
  const res = await desk.post('/bookings', { kind: 'walk_in', serviceId, requestedTherapistId });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/** Start with whatever the system suggests. */
async function startSuggested(desk: Client, id: string) {
  const s = await json<Suggestion>(await desk.get(`/bookings/${id}/suggest`));
  const res = await desk.post(`/bookings/${id}/start`, {
    therapistId: s.therapist!.staffId,
    roomId: s.room!.roomId,
    flexMode: s.room!.flexMode,
  });
  expect(res.status).toBe(200);
  return s;
}

const board = (c: Client) => c.get('/front-desk').then((r) => json<Board>(r));

beforeEach(async () => {
  // Each test runs its own shift.
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE dtr SET clock_out = ? WHERE clock_out IS NULL`).bind(now),
    env.DB.prepare(`UPDATE bookings SET status = 'done', done_at = ? WHERE status = 'in_service'`).bind(now),
    env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE status IN ('waiting', 'scheduled')`),
  ]);
});

describe('a shift at the front desk', () => {
  it('runs walk-ins through the Rotation and rooms', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const c = await therapist(admin);

    // Guest 1 → a (first to arrive), Room 1.
    const g1 = await walkIn(desk);
    const s1 = await startSuggested(desk, g1);
    expect(s1).toMatchObject({ therapist: { staffId: a, reason: 'rotation' }, room: { roomId: 1, flexMode: null } });

    // Guest 2 → b, Room 2. A foot massage → c on the Flex Room recliner.
    const g2 = await walkIn(desk);
    expect((await startSuggested(desk, g2)).therapist?.staffId).toBe(b);
    const g3 = await walkIn(desk, 'foot-60');
    expect(await startSuggested(desk, g3)).toMatchObject({ therapist: { staffId: c }, room: { roomId: 8, flexMode: 'recliner' } });

    // Everyone busy: no one to suggest.
    const g4 = await walkIn(desk);
    expect((await json<Suggestion>(await desk.get(`/bookings/${g4}/suggest`))).therapist).toBeNull();

    // b finishes first → back of the line; a is still busy, so b takes guest 4.
    expect((await desk.post(`/bookings/${g2}/done`)).status).toBe(200);
    let state = await board(desk);
    expect(state.rotation.map((r) => r.staffId)).toEqual([a, c, b]);
    expect(state.next).toBe(b);
    expect((await startSuggested(desk, g4)).therapist?.staffId).toBe(b);

    // Room 2 was freed and reused; Room 1 is still busy.
    state = await board(desk);
    expect(state.rooms.find((r) => r.id === 1)?.booking?.id).toBe(g1);
    expect(state.rooms.find((r) => r.id === 2)?.booking?.id).toBe(g4);
  });

  it('keeps a Requested Therapist in place and makes others wait for them', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);

    // A Guest asks for b, who is second in line.
    const g1 = await walkIn(desk, 'swedish-60', b);
    expect((await startSuggested(desk, g1)).therapist).toEqual({ staffId: b, reason: 'requested' });
    await desk.post(`/bookings/${g1}/done`);

    // b served out of turn, so the order is unchanged: a, then b.
    const state = await board(desk);
    expect(state.rotation.map((r) => r.staffId)).toEqual([a, b]);
    expect(state.next).toBe(a);
  });

  it('holds a Requested Therapist for a waiting Guest', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);

    await walkIn(desk, 'swedish-60', a); // waiting for a
    const other = await walkIn(desk);
    // a is first in line but held, so the next un-requested Guest goes to b.
    expect((await json<Suggestion>(await desk.get(`/bookings/${other}/suggest`))).therapist?.staffId).toBe(b);
  });
});

describe('no double-booking', () => {
  it('refuses a taken room, a busy therapist, and an off-duty therapist', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const g1 = await walkIn(desk);
    await desk.post(`/bookings/${g1}/start`, { therapistId: a, roomId: 1, flexMode: null });

    const g2 = await walkIn(desk);
    expect((await desk.post(`/bookings/${g2}/start`, { therapistId: b, roomId: 1, flexMode: null })).status).toBe(409);
    expect((await desk.post(`/bookings/${g2}/start`, { therapistId: a, roomId: 2, flexMode: null, overrideReason: 'test' })).status).toBe(409);

    await admin.post('/clock/punch', { staffId: b, pin: '1234', action: 'out' });
    expect((await desk.post(`/bookings/${g2}/start`, { therapistId: b, roomId: 2, flexMode: null })).status).toBe(409);
  });

  it('keeps non-foot services off the recliner', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const g = await walkIn(desk);
    const res = await desk.post(`/bookings/${g}/start`, { therapistId: a, roomId: 8, flexMode: 'recliner' });
    expect(res.status).toBe(400);
    expect((await desk.post(`/bookings/${g}/start`, { therapistId: a, roomId: 8, flexMode: 'floor' })).status).toBe(200);
  });

  it('needs a reason to skip the suggested therapist, and logs it', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    await therapist(admin);
    const b = await therapist(admin);
    const g = await walkIn(desk);
    expect((await desk.post(`/bookings/${g}/start`, { therapistId: b, roomId: 1, flexMode: null })).status).toBe(400);
    expect(
      (await desk.post(`/bookings/${g}/start`, { therapistId: b, roomId: 1, flexMode: null, overrideReason: 'Guest prefers a female therapist' })).status,
    ).toBe(200);
    const row = await env.DB.prepare(`SELECT reason FROM audit_log WHERE action = 'booking.override' AND entity_id = ?`).bind(g).first<{ reason: string }>();
    expect(row?.reason).toBe('Guest prefers a female therapist');
  });

  it('refuses two scheduled Bookings with the same Requested Therapist at once', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const half = new Date(Date.now() + 3.5 * 3_600_000).toISOString();
    const tooSoon = new Date(Date.now() + 4 * 3_600_000).toISOString();
    const after = new Date(Date.now() + 4.5 * 3_600_000).toISOString();
    const book = (scheduledAt: string) =>
      desk.post('/bookings', { kind: 'scheduled', serviceId: 'swedish-60', requestedTherapistId: a, scheduledAt, guestName: 'Ms. Cruz' });
    expect((await book(at)).status).toBe(201);
    expect((await book(half)).status).toBe(409);
    // The next reservation keeps them from 30 minutes before it.
    expect((await book(tooSoon)).status).toBe(409);
    expect((await book(after)).status).toBe(201);
  });
});

describe('a named reservation', () => {
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const reserve = async (desk: Client, a: string, minutes: number) =>
    (await json<{ id: string }>(await desk.post('/bookings', { kind: 'scheduled', serviceId: 'swedish-60', requestedTherapistId: a, scheduledAt: inMinutes(minutes), guestName: 'Ms. Reyes' }))).id;
  const walkInFor = (desk: Client, serviceId: string, a: string) => desk.post('/bookings', { kind: 'walk_in', serviceId, requestedTherapistId: a });

  it('refuses a walk-in that would run past 30 minutes before it, and allows one that ends in time', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    await reserve(desk, a, 61);
    const long = await walkInFor(desk, 'swedish-60', a);
    expect(long.status).toBe(409);
    expect((await json<{ error: string }>(long)).error).toBe('therapist_reserved');
    const short = await walkInFor(desk, 'foot-30', a);
    expect(short.status).toBe(201);
    const { id } = await json<{ id: string }>(short);
    expect(await startSuggested(desk, id)).toMatchObject({ therapist: { staffId: a, reason: 'requested' } });
    // No extensions: an Added Service runs past it, and "add anyway" doesn't help.
    const more = await desk.post(`/bookings/${id}/add-service`, { serviceId: 'foot-30', confirm: true });
    expect(more.status).toBe(409);
    expect((await json<{ error: string }>(more)).error).toBe('therapist_reserved');
  });

  it('skips the Therapist in the Rotation without costing their place, and cannot be overridden', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    await reserve(desk, a, 60);
    const g = await walkIn(desk);
    expect((await json<Suggestion>(await desk.get(`/bookings/${g}/suggest`))).therapist?.staffId).toBe(b);
    expect((await desk.post(`/bookings/${g}/start`, { therapistId: a, roomId: 1, flexMode: null, overrideReason: 'Guest prefers them' })).status).toBe(409);
    expect((await board(desk)).rotation.map((r) => r.staffId)).toEqual([a, b]);
  });

  it('marks the Therapist Reserved from 30 minutes before and takes them out of Next', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const b = await therapist(admin);
    const later = await reserve(desk, a, 45);
    let state = await board(desk);
    expect(state.rotation.find((r) => r.staffId === a)?.reservedFor).toBeNull();
    expect(state.next).toBe(a);
    await env.DB.prepare(`UPDATE bookings SET scheduled_at = ? WHERE id = ?`).bind(inMinutes(20), later).run();
    state = await board(desk);
    expect(state.rotation.find((r) => r.staffId === a)?.reservedFor).toBeTruthy();
    expect(state.next).toBe(b);
    // Their own Guest can still be started.
    expect(await startSuggested(desk, later)).toMatchObject({ therapist: { staffId: a, reason: 'requested' } });
  });

  it('is changed only when the Guest asks, with a reason; the Super Admin needs only the reason', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const id = await reserve(desk, a, 120);
    expect((await desk.post(`/bookings/${id}/cancel`, { reason: 'Slow day' })).status).toBe(403);
    expect((await desk.send('PATCH', `/bookings/${id}`, { scheduledAt: inMinutes(180), reason: 'Slow day' })).status).toBe(403);
    expect((await desk.send('PATCH', `/bookings/${id}`, { scheduledAt: inMinutes(180), guestAsked: true })).status).toBe(400);
    expect((await desk.send('PATCH', `/bookings/${id}`, { scheduledAt: inMinutes(180), guestAsked: true, reason: 'Guest is running late' })).status).toBe(200);
    expect((await desk.post(`/bookings/${id}/no-show`)).status).toBe(409);
    expect((await admin.post(`/bookings/${id}/cancel`, { reason: 'Therapist is sick' })).status).toBe(200);
  });

  it('closes as a No-show 15 minutes after its time, freeing the Therapist', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const a = await therapist(admin);
    const late = await reserve(desk, a, 60);
    const onTime = await reserve(desk, a, 240);
    const unnamed = await json<{ id: string }>(await desk.post('/bookings', { kind: 'scheduled', serviceId: 'thai-60', scheduledAt: inMinutes(30) }));
    await env.DB.batch([
      env.DB.prepare(`UPDATE bookings SET scheduled_at = ? WHERE id IN (?, ?)`).bind(inMinutes(-16), late, unnamed.id),
    ]);
    const state = await board(desk);
    const status = (id: string) => state.bookings.find((b) => b.id === id)?.status;
    expect(status(late)).toBe('no_show');
    expect(status(unnamed.id)).toBe('no_show');
    expect(status(onTime)).toBe('scheduled');
    expect(state.rotation.find((r) => r.staffId === a)?.reservedFor).toBeNull();
    expect(state.next).toBe(a);
    const row = await env.DB.prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action = 'booking.no_show_auto'`).bind(late).first();
    expect(row).toBeTruthy();
  });
});

describe('booking lifecycle', () => {
  it('handles arrival, cancellation and no-shows', async () => {
    const desk = await loggedIn('receptionist');
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const make = async () =>
      (await json<{ id: string }>(await desk.post('/bookings', { kind: 'scheduled', serviceId: 'thai-60', scheduledAt: later }))).id;

    const arrived = await make();
    expect((await desk.post(`/bookings/${arrived}/arrived`)).status).toBe(200);
    expect((await desk.post(`/bookings/${arrived}/no-show`)).status).toBe(409);

    const cancelled = await make();
    expect((await desk.post(`/bookings/${cancelled}/cancel`, { reason: '' })).status).toBe(400);
    expect((await desk.post(`/bookings/${cancelled}/cancel`, { reason: 'Guest called to cancel' })).status).toBe(200);

    const missed = await make();
    expect((await desk.post(`/bookings/${missed}/no-show`)).status).toBe(200);
  });

  it('only marks a service in progress as done', async () => {
    const desk = await loggedIn('receptionist');
    const g = await walkIn(desk);
    expect((await desk.post(`/bookings/${g}/done`)).status).toBe(409);
  });

  it('is front-desk only', async () => {
    const { client } = await import('./helpers');
    expect((await client().get('/front-desk')).status).toBe(401);
    expect((await client().get('/health')).status).toBe(200);
  });
});

describe('Late Entry', () => {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  /** A Therapist whose time record starts `m` minutes ago, as if they clocked in before the desk was there. */
  async function clockedInAgo(admin: Client, m: number): Promise<string> {
    const name = `L${++n}`;
    const { id } = await json<{ id: string }>(
      await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass: 'regular' }),
    );
    expect((await admin.post('/dtr', { staffId: id, clockIn: minsAgo(m), clockOut: null, reason: 'Clocked in on paper' })).status).toBe(201);
    return id;
  }
  const late = (therapistId: string, roomId: number, startedAt: string, finishedAt: string | null) => ({
    serviceId: 'swedish-60',
    guestName: 'Paper guest',
    therapistId,
    roomId,
    startedAt,
    finishedAt,
  });

  it('records a guest served before the desk arrived, with the real times, marked for the owner', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await clockedInAgo(admin, 50);

    const res = await desk.post('/bookings/late', late(t, 3, minsAgo(40), minsAgo(10)));
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const row = await env.DB.prepare(`SELECT status, entered_late, started_at, done_at, therapist_id FROM bookings WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'done', entered_late: 1, therapist_id: t });

    // It took the Therapist's Rotation turn, and waits for checkout like any finished Service.
    const b = await board(desk);
    expect(b.bookings.find((x) => x.id === id)).toMatchObject({ status: 'done' });

    // The owner sees it until it is checked.
    expect((await desk.get('/bookings/late')).status).toBe(403);
    const list = await json<{ entries: { id: string }[] }>(await admin.get('/bookings/late'));
    expect(list.entries.map((e) => e.id)).toContain(id);
    const attention = await json<{ items: { key: string }[] }>(await admin.get('/attention'));
    expect(attention.items.map((i) => i.key)).toContain('late-entries');
    expect((await admin.post('/bookings/late/checked', { ids: [id] })).status).toBe(200);
    expect((await json<{ entries: { id: string }[] }>(await admin.get('/bookings/late'))).entries.map((e) => e.id)).not.toContain(id);
  });

  it('refuses a time the Therapist was not clocked in, or was already with a guest, or the room was in use', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await clockedInAgo(admin, 50);
    const other = await clockedInAgo(admin, 50);

    const before = await desk.post('/bookings/late', late(t, 4, minsAgo(55), minsAgo(5)));
    expect(before.status).toBe(409);
    expect((await json<{ error: string }>(before)).error).toBe('not_clocked_in');
    expect((await desk.post('/bookings/late', late(t, 4, new Date(Date.now() + 600_000).toISOString(), null))).status).toBe(400);

    expect((await desk.post('/bookings/late', late(t, 4, minsAgo(45), minsAgo(20)))).status).toBe(201);
    const busy = await desk.post('/bookings/late', late(t, 5, minsAgo(30), minsAgo(5)));
    expect((await json<{ error: string }>(busy)).error).toBe('therapist_busy');
    const taken = await desk.post('/bookings/late', late(other, 4, minsAgo(30), minsAgo(5)));
    expect((await json<{ error: string }>(taken)).error).toBe('room_taken');

    // Still under way: no finish time, so it is in service now.
    const now = await desk.post('/bookings/late', late(other, 5, minsAgo(15), null));
    expect(now.status).toBe(201);
    const { id } = await json<{ id: string }>(now);
    expect((await board(desk)).bookings.find((x) => x.id === id)).toMatchObject({ status: 'in_service', therapistId: other, roomId: 5 });
  });
});
