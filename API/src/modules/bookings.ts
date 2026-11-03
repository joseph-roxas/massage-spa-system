import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { addMinutes, businessDayOf, overlaps, roomFits, suggestRoom, suggestTherapist } from '@spa/domain';
import { bookings, FLEX_MODES, services, staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { activeBookingsFor, bookingSpan, frontDeskState, type BookingRow } from '../lib/front-desk';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { requireAuth, requireCapability } from '../auth/middleware';

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional();

const bookingFields = z.object({
  serviceId: z.string().min(1),
  guestName: optionalText(80),
  guestPhone: optionalText(30),
  requestedTherapistId: z.string().min(1).nullable().optional(),
  notes: optionalText(300),
});

const newBooking = z.discriminatedUnion('kind', [
  bookingFields.extend({ kind: z.literal('walk_in') }),
  bookingFields.extend({ kind: z.literal('scheduled'), scheduledAt: instant }),
]);

const editBooking = bookingFields.partial().extend({ scheduledAt: instant.optional() });

const startBody = z.object({
  therapistId: z.string().min(1),
  roomId: z.number().int(),
  flexMode: z.enum(FLEX_MODES).nullable(),
  portableTable: z.boolean().default(false),
  overrideReason: z.string().trim().max(200).optional(),
});

const reasonBody = z.object({ reason: z.string().trim().min(3, 'Give a short reason.').max(300) });

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${String(err.cause ?? '')}`);
}

async function loadBooking(c: Context<AuthedEnv>): Promise<BookingRow | undefined> {
  return c.var.db.select().from(bookings).where(eq(bookings.id, c.req.param('id')!)).get();
}

/** Problem with holding `therapistId` for a Guest over `span`, ignoring `selfId`. */
async function requestClash(c: Context<AuthedEnv>, therapistId: string, span: { start: string; end: string }, selfId?: string) {
  const person = await c.var.db.select().from(staff).where(eq(staff.id, therapistId)).get();
  if (!person || person.kind !== 'therapist' || !person.active) return 'Pick an active therapist.';
  const now = nowIso();
  const others = (await activeBookingsFor(c.var.db, therapistId)).filter((b) => b.id !== selfId);
  for (const b of others) {
    const s = bookingSpan(b, now);
    if (s && overlaps(s, span)) return `${person.displayName} is already booked for that time.`;
  }
  return null;
}

// Mounted at the API root, so the guards are scoped to these paths.
const guard = [requireAuth, requireCapability('bookings.manage')] as const;

export const bookingRoutes = new Hono<AuthedEnv>()
  .use('/front-desk', ...guard)
  .use('/bookings', ...guard)
  .use('/bookings/*', ...guard)

  /** Everything the Front Desk board shows, in one call. */
  .get('/front-desk', async (c) => {
    const now = nowIso();
    const day = businessDayOf(new Date(now));
    const state = await frontDeskState(c.var.db, day, now);
    const [svc, people] = await Promise.all([
      c.var.db.select({ id: services.id, code: services.code, name: services.name }).from(services),
      c.var.db.select({ id: staff.id, displayName: staff.displayName }).from(staff),
    ]);
    const svcById = new Map(svc.map((s) => [s.id, s]));
    const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.displayName ?? null) : null);
    const list = state.dayBookings
      .map((b) => ({
        ...b,
        serviceCode: svcById.get(b.serviceId)?.code ?? '',
        serviceName: svcById.get(b.serviceId)?.name ?? '',
        therapistName: nameOf(b.therapistId),
        requestedTherapistName: nameOf(b.requestedTherapistId),
        endsAt: b.startedAt ? addMinutes(b.startedAt, b.durationMin) : null,
      }))
      .sort((a, b) => (a.startedAt ?? a.scheduledAt ?? a.createdAt).localeCompare(b.startedAt ?? b.scheduledAt ?? b.createdAt));
    const byId = new Map(state.therapists.map((t) => [t.id, t]));
    return c.json({
      day,
      now,
      next: state.next?.staffId ?? null,
      rotation: state.rotation.map((r) => ({ ...r, ...byId.get(r.staffId)! })),
      rooms: state.rooms
        .sort((a, b) => a.id - b.id)
        .map((r) => ({ ...r, booking: list.find((b) => b.status === 'in_service' && b.roomId === r.id) ?? null })),
      bookings: list,
    });
  })

  .post('/bookings', zValidator('json', newBooking, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const service = await db.select().from(services).where(eq(services.id, input.serviceId)).get();
    if (!service || !service.active) return fail(c, 400, 'unknown_service', 'Pick a service that is offered.');
    const now = nowIso();
    const scheduledAt = input.kind === 'scheduled' ? input.scheduledAt : null;
    if (scheduledAt && scheduledAt < addMinutes(now, -30)) {
      return fail(c, 400, 'in_past', 'A scheduled booking cannot be in the past.');
    }
    if (input.requestedTherapistId) {
      const start = scheduledAt ?? now;
      const clash = await requestClash(c, input.requestedTherapistId, { start, end: addMinutes(start, service.durationMin) });
      // A walk-in may wait for a busy Requested Therapist; a scheduled time must be free.
      if (clash && input.kind === 'scheduled') return fail(c, 409, 'therapist_booked', clash);
    }
    const id = crypto.randomUUID();
    await db.insert(bookings).values({
      id,
      businessDay: businessDayOf(new Date(scheduledAt ?? now)),
      kind: input.kind,
      status: input.kind === 'scheduled' ? 'scheduled' : 'waiting',
      guestName: input.guestName ?? null,
      guestPhone: input.guestPhone ?? null,
      serviceId: service.id,
      durationMin: service.durationMin,
      scheduledAt,
      requestedTherapistId: input.requestedTherapistId ?? null,
      notes: input.notes ?? null,
      createdAt: now,
      createdBy: c.var.user.id,
    });
    return c.json({ id }, 201);
  })

  .patch('/bookings/:id', zValidator('json', editBooking, invalidInput), async (c) => {
    const db = c.var.db;
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status !== 'scheduled' && booking.status !== 'waiting') {
      return fail(c, 409, 'started', 'Only bookings that have not started can be changed.');
    }
    const input = c.req.valid('json');
    const changes: Partial<BookingRow> = {};
    if (input.guestName !== undefined) changes.guestName = input.guestName;
    if (input.guestPhone !== undefined) changes.guestPhone = input.guestPhone;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (input.requestedTherapistId !== undefined) changes.requestedTherapistId = input.requestedTherapistId;
    if (input.serviceId && input.serviceId !== booking.serviceId) {
      const service = await db.select().from(services).where(eq(services.id, input.serviceId)).get();
      if (!service || !service.active) return fail(c, 400, 'unknown_service', 'Pick a service that is offered.');
      changes.serviceId = service.id;
      changes.durationMin = service.durationMin;
    }
    if (input.scheduledAt && booking.kind === 'scheduled') {
      changes.scheduledAt = input.scheduledAt;
      changes.businessDay = businessDayOf(new Date(input.scheduledAt));
    }
    const merged = { ...booking, ...changes };
    if (merged.requestedTherapistId && merged.status === 'scheduled') {
      const span = bookingSpan(merged, nowIso())!;
      const clash = await requestClash(c, merged.requestedTherapistId, span, booking.id);
      if (clash) return fail(c, 409, 'therapist_booked', clash);
    }
    await db.batch([
      db.update(bookings).set(changes).where(eq(bookings.id, booking.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.update', entity: 'booking', entityId: booking.id, before: booking, after: changes }),
    ]);
    return c.json({ ok: true });
  })

  /** Who and where the system would put this Guest right now. */
  .get('/bookings/:id/suggest', async (c) => {
    const db = c.var.db;
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    const service = (await db.select().from(services).where(eq(services.id, booking.serviceId)).get())!;
    const now = nowIso();
    const state = await frontDeskState(db, businessDayOf(new Date(now)), now);
    const span = { start: now, end: addMinutes(now, booking.durationMin) };
    // This Guest's own hold must not block their own therapist.
    const held = new Map(state.heldSpans);
    if (booking.requestedTherapistId) held.delete(booking.requestedTherapistId);
    return c.json({
      therapist: suggestTherapist(state.rotation, { span }, { requestedId: booking.requestedTherapistId, heldSpans: held }),
      room: suggestRoom(state.rooms, state.occupiedRoomIds, service),
    });
  })

  .post('/bookings/:id/start', zValidator('json', startBody, invalidInput), async (c) => {
    const db = c.var.db;
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status !== 'scheduled' && booking.status !== 'waiting') {
      return fail(c, 409, 'not_startable', 'This booking has already started or was called off.');
    }
    const input = c.req.valid('json');
    const now = nowIso();
    const state = await frontDeskState(db, businessDayOf(new Date(now)), now);

    const onDuty = state.rotation.find((r) => r.staffId === input.therapistId);
    if (!onDuty) return fail(c, 409, 'not_on_duty', 'That therapist is not clocked in.');
    if (onDuty.status !== 'free') return fail(c, 409, 'therapist_busy', 'That therapist is with another guest.');

    const room = state.rooms.find((r) => r.id === input.roomId);
    const service = (await db.select().from(services).where(eq(services.id, booking.serviceId)).get())!;
    if (!room || !roomFits(room, service, input.flexMode)) {
      return fail(c, 400, 'room_unsuitable', room?.isFlex ? 'The recliner is for foot services only.' : 'Pick a room that is in use.');
    }
    if (state.occupiedRoomIds.has(room.id)) return fail(c, 409, 'room_taken', `${room.name} is taken.`);

    const held = new Map(state.heldSpans);
    if (booking.requestedTherapistId) held.delete(booking.requestedTherapistId);
    const suggested = suggestTherapist(
      state.rotation,
      { span: { start: now, end: addMinutes(now, booking.durationMin) } },
      { requestedId: booking.requestedTherapistId, heldSpans: held },
    );
    const overriding = suggested?.staffId !== input.therapistId;
    if (overriding && (input.overrideReason ?? '').length < 3) {
      return fail(c, 400, 'reason_required', 'This isn’t the suggested therapist. Give a short reason.');
    }

    try {
      const res = await db
        .update(bookings)
        .set({
          status: 'in_service',
          therapistId: input.therapistId,
          roomId: room.id,
          flexMode: room.isFlex ? input.flexMode : null,
          portableTable: input.portableTable,
          overrideReason: overriding ? input.overrideReason! : null,
          startedAt: now,
          // An early arrival for tomorrow's booking still counts toward today.
          businessDay: businessDayOf(new Date(now)),
        })
        .where(and(eq(bookings.id, booking.id), inArray(bookings.status, ['scheduled', 'waiting'])))
        .returning({ id: bookings.id });
      if (res.length === 0) return fail(c, 409, 'not_startable', 'Someone else just started this booking.');
    } catch (err) {
      // The partial unique indexes catch a race between two front-desk screens.
      if (isUniqueViolation(err)) return fail(c, 409, 'double_booked', 'That room or therapist was just taken.');
      throw err;
    }
    if (overriding) {
      await auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'booking.override',
        entity: 'booking',
        entityId: booking.id,
        before: { suggested: suggested?.staffId ?? null },
        after: { therapistId: input.therapistId },
        reason: input.overrideReason,
      });
    }
    return c.json({ ok: true });
  })

  .post('/bookings/:id/done', async (c) => {
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status !== 'in_service') return fail(c, 409, 'not_in_service', 'Only a service in progress can be marked done.');
    await c.var.db
      .update(bookings)
      .set({ status: 'done', doneAt: nowIso() })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'in_service')));
    return c.json({ ok: true });
  })

  .post('/bookings/:id/arrived', async (c) => {
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status !== 'scheduled') return fail(c, 409, 'not_scheduled', 'Only a scheduled booking can arrive.');
    await c.var.db.update(bookings).set({ status: 'waiting' }).where(eq(bookings.id, booking.id));
    return c.json({ ok: true });
  })

  .post('/bookings/:id/cancel', zValidator('json', reasonBody, invalidInput), async (c) => {
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status !== 'scheduled' && booking.status !== 'waiting') {
      return fail(c, 409, 'started', 'Only bookings that have not started can be cancelled.');
    }
    const { reason } = c.req.valid('json');
    const db = c.var.db;
    await db.batch([
      db.update(bookings).set({ status: 'cancelled', cancelReason: reason }).where(eq(bookings.id, booking.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.cancel', entity: 'booking', entityId: booking.id, reason }),
    ]);
    return c.json({ ok: true });
  })

  .post('/bookings/:id/no-show', async (c) => {
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status !== 'scheduled') return fail(c, 409, 'not_scheduled', 'Only a scheduled booking can be a no-show.');
    const db = c.var.db;
    await db.batch([
      db.update(bookings).set({ status: 'no_show' }).where(eq(bookings.id, booking.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.no_show', entity: 'booking', entityId: booking.id }),
    ]);
    return c.json({ ok: true });
  })

  /** Bookings for any day, e.g. tomorrow's appointments. */
  .get('/bookings', zValidator('query', z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), invalidInput), async (c) => {
    const rows = await c.var.db
      .select()
      .from(bookings)
      .where(eq(bookings.businessDay, c.req.valid('query').day))
      .orderBy(asc(bookings.scheduledAt), asc(bookings.createdAt));
    return c.json({ bookings: rows });
  });
