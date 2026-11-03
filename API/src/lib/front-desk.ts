import { and, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { addMinutes, computeRotation, nextInRotation, type ServiceTurn, type Span } from '@spa/domain';
import { bookings, dtr, rooms, staff } from '@spa/db';

export type BookingRow = typeof bookings.$inferSelect;

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

/**
 * Everything the front desk needs to decide who and where: the Rotation built
 * from today's DTR and Services, which Rooms are taken, and which therapists
 * are held for Guests who asked for them.
 */
export async function frontDeskState(db: DrizzleD1Database, day: string, now: string) {
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

  const rotation = computeRotation(
    therapists.map((t) => ({ staffId: t.id, shifts: entries.filter((e) => e.staffId === t.id) })),
    turns,
  );

  const occupiedRoomIds = new Set(dayBookings.filter((b) => b.status === 'in_service' && b.roomId).map((b) => b.roomId!));

  // A Guest waiting for (or booked with) a Requested Therapist holds that therapist.
  const heldSpans = new Map<string, Span[]>();
  for (const b of dayBookings) {
    if (!b.requestedTherapistId || (b.status !== 'scheduled' && b.status !== 'waiting')) continue;
    const span = bookingSpan(b, now);
    if (span) heldSpans.set(b.requestedTherapistId, [...(heldSpans.get(b.requestedTherapistId) ?? []), span]);
  }

  return { therapists, rotation, next: nextInRotation(rotation), dayBookings, rooms: allRooms, occupiedRoomIds, heldSpans };
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
