import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { addMinutes, businessDayOf, computeRotation, GRACE_PERIOD_MIN, nextInRotation, RESERVED_LEAD_MIN, type ServiceTurn, type Span } from '@spa/domain';
import { bookings, dtr, rooms, staff } from '@spa/db';
import { auditInsert } from './audit';

export type BookingRow = typeof bookings.$inferSelect;

/** A Scheduled Booking naming its Therapist, not started yet: that Therapist is kept for it. */
export function isNamedReservation(b: BookingRow): boolean {
  return b.kind === 'scheduled' && !!b.requestedTherapistId && !!b.scheduledAt && (b.status === 'scheduled' || b.status === 'waiting');
}

/** Scheduled Bookings whose Grace Period has run out close by themselves as No-shows. */
export async function closeMissedBookings(db: DrizzleD1Database, now: string): Promise<void> {
  const missed = await db
    .update(bookings)
    .set({ status: 'no_show' })
    .where(and(eq(bookings.status, 'scheduled'), isNotNull(bookings.scheduledAt), lte(bookings.scheduledAt, addMinutes(now, -GRACE_PERIOD_MIN))))
    .returning({ id: bookings.id });
  await Promise.all(missed.map((b) => auditInsert(db, { actorUserId: null, action: 'booking.no_show_auto', entity: 'booking', entityId: b.id })));
}

/**
 * When a Service's time is up and the same Therapist has an Added Service
 * waiting after it, that one starts by itself, from the moment the first ended.
 */
export async function startFollowingServices(db: DrizzleD1Database, now: string): Promise<void> {
  // Round again in case the one just started has run out too, e.g. no one had the board open.
  for (let round = 0; round < 8; round++) {
    const waiting = await db.select().from(bookings).where(and(eq(bookings.status, 'waiting'), isNotNull(bookings.parentBookingId), isNotNull(bookings.therapistId)));
    if (!waiting.length) return;
    const parents = await db.select().from(bookings).where(and(eq(bookings.status, 'in_service'), inArray(bookings.id, waiting.map((w) => w.parentBookingId!))));
    let started = 0;
    for (const child of waiting) {
      const parent = parents.find((p) => p.id === child.parentBookingId);
      if (!parent?.startedAt || parent.therapistId !== child.therapistId) continue;
      const endedAt = addMinutes(parent.startedAt, parent.durationMin);
      if (endedAt > now) continue;
      await db.batch([
        db.update(bookings).set({ status: 'done', doneAt: endedAt }).where(and(eq(bookings.id, parent.id), eq(bookings.status, 'in_service'))),
        db.update(bookings).set({ status: 'in_service', startedAt: endedAt, businessDay: businessDayOf(new Date(endedAt)) }).where(and(eq(bookings.id, child.id), eq(bookings.status, 'waiting'))),
        auditInsert(db, { actorUserId: null, action: 'booking.follow_on_auto', entity: 'booking', entityId: child.id, after: { startedAt: endedAt, after: parent.id } }),
      ]);
      started++;
    }
    if (!started) return;
  }
}

/** When a Booking will occupy its therapist, for clash checks. Null once finished or called off. */
export function bookingSpan(b: BookingRow, now: string): Span | null {
  switch (b.status) {
    case 'in_service':
      return { start: b.startedAt!, end: addMinutes(b.startedAt!, b.durationMin) };
    case 'scheduled': {
      const start = b.scheduledAt ?? now;
      return { start, end: addMinutes(start, b.durationMin) };
    }
    case 'waiting': {
      // Waiting means "as soon as possible": count from now, or the booked time if that is later.
      const start = b.scheduledAt && b.scheduledAt > now ? b.scheduledAt : now;
      return { start, end: addMinutes(start, b.durationMin) };
    }
    default:
      return null;
  }
}

/** How long a Booking keeps a Therapist it names: a reservation from 30 minutes before. */
export function holdSpan(b: BookingRow, now: string): Span | null {
  const span = bookingSpan(b, now);
  return span && isNamedReservation(b) ? { start: addMinutes(b.scheduledAt!, -RESERVED_LEAD_MIN), end: span.end } : span;
}

/**
 * Everything the front desk needs to decide who and where: the Rotation built
 * from today's DTR and Services, which Rooms are taken, and which therapists
 * are held for Guests who asked for them.
 */
export async function frontDeskState(db: DrizzleD1Database, day: string, now: string) {
  await closeMissedBookings(db, now);
  await startFollowingServices(db, now);
  const [therapists, entries, dayBookings, allRooms] = await Promise.all([
    db
      .select({ id: staff.id, displayName: staff.displayName, therapistClass: staff.therapistClass, isOnCall: staff.isOnCall })
      .from(staff)
      .where(and(eq(staff.kind, 'therapist'), eq(staff.active, true))),
    db.select().from(dtr).where(eq(dtr.businessDay, day)),
    db.select().from(bookings).where(eq(bookings.businessDay, day)),
    db.select().from(rooms),
  ]);

  const turns: ServiceTurn[] = dayBookings
    .filter((b) => b.therapistId && b.startedAt && (b.status === 'in_service' || b.status === 'done'))
    .map((b) => ({
      staffId: b.therapistId!,
      requested: b.requestedTherapistId === b.therapistId,
      startedAt: b.startedAt!,
      doneAt: b.doneAt,
    }));

  // Who each reservation keeps, and from when.
  const reservations = dayBookings.filter(isNamedReservation).map((b) => ({ bookingId: b.id, therapistId: b.requestedTherapistId!, scheduledAt: b.scheduledAt!, span: holdSpan(b, now)! }));
  const reservedFor = (staffId: string) =>
    reservations
      .filter((r) => r.therapistId === staffId && r.span.start <= now)
      .map((r) => r.scheduledAt)
      .sort()[0] ?? null;

  const rotation = computeRotation(
    // A Therapist on a Relief Shift is running the front desk, not in the Rotation.
    therapists.map((t) => ({ staffId: t.id, isLmt: t.therapistClass === 'lmt', shifts: entries.filter((e) => e.staffId === t.id && !e.isRelief) })),
    turns,
  ).map((r) => ({ ...r, reservedFor: reservedFor(r.staffId) }));

  const occupiedRoomIds = new Set(dayBookings.filter((b) => b.status === 'in_service' && b.roomId).map((b) => b.roomId!));

  // A Guest waiting for (or booked with) a Requested Therapist holds that therapist.
  const heldSpans = new Map<string, Span[]>();
  for (const b of dayBookings) {
    if (!b.requestedTherapistId || (b.status !== 'scheduled' && b.status !== 'waiting')) continue;
    const span = holdSpan(b, now);
    if (span) heldSpans.set(b.requestedTherapistId, [...(heldSpans.get(b.requestedTherapistId) ?? []), span]);
  }

  // Who is running the front desk on a Relief Shift right now.
  const relieving = entries.filter((e) => e.isRelief && !e.clockOut).map((e) => e.staffId);

  return { therapists, rotation, next: nextInRotation(rotation), dayBookings, rooms: allRooms, occupiedRoomIds, heldSpans, reservations, relieving };
}

/** Each Therapist's reserved time, leaving out one Guest's own reservation. */
export function reservedSpansExcept(reservations: readonly { bookingId: string; therapistId: string; span: Span }[], bookingId: string): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const r of reservations) if (r.bookingId !== bookingId) out.set(r.therapistId, [...(out.get(r.therapistId) ?? []), r.span]);
  return out;
}

/** A therapist's Bookings that could clash with a new one: held for them by request, or in progress. */
export async function activeBookingsFor(db: DrizzleD1Database, therapistId: string) {
  return db
    .select()
    .from(bookings)
    .where(
      or(
        and(inArray(bookings.status, ['scheduled', 'waiting']), eq(bookings.requestedTherapistId, therapistId)),
        and(eq(bookings.status, 'in_service'), eq(bookings.therapistId, therapistId)),
      ),
    );
}
