import { drizzle } from 'drizzle-orm/d1';
import { tidyGuestNames } from '../src/lib/guest-names';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf } from '@spa/domain';
import { loggedIn, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Listed = { id: string; name: string; phone: string | null; statutoryIdMasked: string | null; visits: number; lastVisit: string | null; isRegular: boolean };
type Detail = { guest: Listed & { statutoryType: string | null; statutoryIdNo: string | null; avgDaysBetween: number | null }; visits: { day: string; serviceName: string; roomName: string | null }[]; vouchers: { day: string; total: number }[] };

const daysAgo = (n: number) => {
  const d = new Date(`${businessDayOf(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** A checked-out Booking for `guestId` on a past closed day. */
async function pastVisit(guestId: string, day: string, status: 'paid' | 'voided' = 'paid') {
  const now = new Date().toISOString();
  const booking = crypto.randomUUID();
  const therapist = (await env.DB.prepare(`SELECT id FROM staff WHERE kind = 'therapist' LIMIT 1`).first<{ id: string }>())!.id;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO business_days (date, opened_at, closed_at) VALUES (?, ?, ?)`).bind(day, now, now),
    env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, guest_id, service_id, duration_min, room_id, created_at) VALUES (?, ?, 'walk_in', 'done', ?, 'swedish-60', 60, 5, ?)`).bind(
      booking,
      day,
      guestId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at)
       VALUES (?, ?, ?, ?, 'swedish-60', ?, 50000, 'none', 50000, 50000, 3000, 15000, ?)`,
    ).bind(crypto.randomUUID(), booking, day, status, therapist, now),
  ]);
}

const list = async (c: Client, q = '') => (await json<{ guests: Listed[] }>(await c.get(`/guests${q ? `?q=${encodeURIComponent(q)}` : ''}`))).guests;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM payments`),
    env.DB.prepare(`DELETE FROM sale_addons`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM voucher_payments`),
    env.DB.prepare(`UPDATE vouchers SET voucher_sale_id = NULL`),
    env.DB.prepare(`DELETE FROM voucher_sales`),
    env.DB.prepare(`DELETE FROM guests`),
    env.DB.prepare(`DELETE FROM business_days`),
  ]);
});

describe('Guest Records', () => {
  it('are saved or picked at booking, and the booking copies the record', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    // Make sure a therapist exists for the visit rows.
    await admin.post('/settings/staff', { gender: 'female', birthdate: '1995-05-01', hireDate: '2026-01-05', firstName: 'G', lastName: 'T', displayName: 'G', kind: 'therapist', therapistClass: 'regular' });

    const first = await json<{ id: string; guestId: string }>(
      await desk.post('/bookings', { kind: 'scheduled', serviceId: 'swedish-60', guestName: 'Lorna Diaz', guestPhone: '0917 555 0101', saveGuest: true, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    expect(first.guestId).toBeTruthy();
    // Without saveGuest, a typed name stays just a name.
    const plain = await json<{ guestId: string | null }>(await desk.post('/bookings', { kind: 'walk_in', serviceId: 'swedish-60', guestName: 'Someone' }));
    expect(plain.guestId).toBeNull();

    expect(await list(desk, '0917')).toEqual([expect.objectContaining({ id: first.guestId, name: 'Lorna Diaz', visits: 0, isRegular: false })]);
    const picked = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId: 'foot-60', guestId: first.guestId, guestName: 'typed over' }));
    const row = await env.DB.prepare(`SELECT guest_id, guest_name, guest_phone FROM bookings WHERE id = ?`).bind(picked.id).first();
    expect(row).toEqual({ guest_id: first.guestId, guest_name: 'Lorna Diaz', guest_phone: '0917 555 0101' });
    expect((await desk.post('/bookings', { kind: 'walk_in', serviceId: 'foot-60', guestId: 'nobody' })).status).toBe(400);

    // A walk-in who gives a name only at the counter is linked later.
    const later = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId: 'foot-60' }));
    expect((await desk.send('PUT', `/bookings/${later.id}/guest`, { guestId: first.guestId })).status).toBe(200);
    expect((await env.DB.prepare(`SELECT guest_id FROM bookings WHERE id = ?`).bind(later.id).first<{ guest_id: string }>())!.guest_id).toBe(first.guestId);
  });

  it('count Visits by Business Day and flag Regulars by the rule in Settings', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    await admin.post('/settings/staff', { gender: 'female', birthdate: '1995-05-01', hireDate: '2026-01-05', firstName: 'G', lastName: 'T', displayName: 'G', kind: 'therapist', therapistClass: 'regular' });
    const { id } = await json<{ id: string }>(await desk.post('/guests', { name: 'Ramon Cruz' }));
    await pastVisit(id, daysAgo(40));
    await pastVisit(id, daysAgo(20));
    await pastVisit(id, daysAgo(20)); // two Services the same day: one Visit
    await pastVisit(id, daysAgo(10), 'voided'); // not checked out
    expect((await list(desk, 'Ramon'))[0]).toMatchObject({ visits: 2, lastVisit: daysAgo(20), isRegular: false });

    await pastVisit(id, daysAgo(2));
    const d = await json<Detail>(await desk.get(`/guests/${id}`));
    expect(d.guest).toMatchObject({ visits: 3, isRegular: true, avgDaysBetween: 19 });
    expect(d.visits.map((v) => v.day)).toEqual([daysAgo(2), daysAgo(20), daysAgo(20), daysAgo(40)]);
    // The Room each visit was in, e.g. to trace a lost item.
    expect(d.visits[0]!.roomName).toBe('Room 5');

    // Only the Super Admin changes the rule.
    expect((await desk.send('PUT', '/settings/pay-rules/regular_guest_rule', { value: { visits: 4, days: 90 } })).status).toBe(403);
    expect((await admin.send('PUT', '/settings/pay-rules/regular_guest_rule', { value: { visits: 4, days: 90 } })).status).toBe(200);
    expect((await list(desk, 'Ramon'))[0]!.isRegular).toBe(false);
    await admin.send('PUT', '/settings/pay-rules/regular_guest_rule', { value: { visits: 3, days: 90 } });
  });

  it('keep a saved SC/PWD ID, masked in lists', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.post('/guests', { name: 'Lola Reyes', statutoryType: 'senior' })).status).toBe(400);
    const { id } = await json<{ id: string }>(await desk.post('/guests', { name: 'Lola Reyes', statutoryType: 'senior', statutoryIdNo: 'SC-2019 004821' }));
    expect((await list(desk, 'Lola'))[0]).toMatchObject({ statutoryIdMasked: '••••4821' });
    expect((await list(desk, 'Lola'))[0]).not.toHaveProperty('statutoryIdNo');
    expect((await json<Detail>(await desk.get(`/guests/${id}`))).guest).toMatchObject({ statutoryType: 'senior', statutoryIdNo: 'SC-2019 004821' });
    expect((await desk.send('PATCH', `/guests/${id}`, { statutoryType: 'pwd', statutoryIdNo: 'PWD-77' })).status).toBe(200);
    expect((await json<Detail>(await desk.get(`/guests/${id}`))).guest.statutoryIdNo).toBe('PWD-77');
  });

  it('are merged by the Super Admin only, moving Visits and Voucher purchases', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    await admin.post('/settings/staff', { gender: 'female', birthdate: '1995-05-01', hireDate: '2026-01-05', firstName: 'G', lastName: 'T', displayName: 'G', kind: 'therapist', therapistClass: 'regular' });
    const keep = (await json<{ id: string }>(await desk.post('/guests', { name: 'Ana Lim' }))).id;
    const dup = (await json<{ id: string }>(await desk.post('/guests', { name: 'Anna Lim', phone: '0918', statutoryType: 'pwd', statutoryIdNo: 'PWD-1' }))).id;
    await pastVisit(dup, daysAgo(5));
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO voucher_sales (id, business_day, service_id, guest_id, buyer_name, qty_paid, qty_free, unit_price, total, created_at) VALUES (?, ?, 'swedish-60', ?, 'Anna Lim', 1, 0, 50000, 50000, ?)`,
    )
      .bind(crypto.randomUUID(), daysAgo(5), dup, now)
      .run();

    expect((await desk.post(`/guests/${dup}/merge`, { intoId: keep })).status).toBe(403);
    expect((await admin.post(`/guests/${dup}/merge`, { intoId: keep })).status).toBe(200);
    const d = await json<Detail>(await desk.get(`/guests/${keep}`));
    expect(d.guest).toMatchObject({ visits: 1, phone: '0918', statutoryIdNo: 'PWD-1' });
    expect(d.vouchers).toHaveLength(1);
    expect((await list(desk, 'Lim')).map((g) => g.id)).toEqual([keep]);
    // A merged record can't be picked any more.
    expect((await desk.post('/bookings', { kind: 'walk_in', serviceId: 'foot-60', guestId: dup })).status).toBe(400);
  });
});

describe('Guest names', () => {
  it('are capitalized when saved, and the ones saved before are tidied once', async () => {
    const admin = await loggedIn('super_admin');
    const { id: saved } = await json<{ id: string }>(await admin.post('/guests', { name: "maria DELA cruz's" }));
    expect((await json<{ guest: { name: string } }>(await admin.get(`/guests/${saved}`))).guest.name).toBe("Maria Dela Cruz's");

    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO guests (id, name, created_at) VALUES (?, 'old LOWER name', '2026-11-01T00:00:00Z')`).bind(id),
      env.DB.prepare(`UPDATE app_meta SET value = 'to_tidy' WHERE key = 'guest_names'`),
    ]);
    expect(await tidyGuestNames(drizzle(env.DB))).toBeGreaterThan(0);
    const row = await env.DB.prepare(`SELECT name FROM guests WHERE id = ?`).bind(id).first<{ name: string }>();
    expect(row?.name).toBe('Old Lower Name');
    // Done once: a second run changes nothing.
    await env.DB.prepare(`UPDATE guests SET name = 'typed again' WHERE id = ?`).bind(id).run();
    expect(await tidyGuestNames(drizzle(env.DB))).toBe(0);
  });
});
