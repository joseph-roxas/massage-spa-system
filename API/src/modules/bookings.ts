import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { addMinutes, businessDayOf, isBirthday, overlaps, roomFits, stayOf, suggestRoom, suggestTherapist } from '@spa/domain';
import { bookings, businessDays, FLEX_MODES, rooms, sales, services, staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor, openDays } from '../lib/business-days';
import { activeBookingsFor, bookingSpan, frontDeskState, type BookingRow } from '../lib/front-desk';
import { resolveGuest, visitStatsFor } from '../lib/guests';
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
  /** A picked Guest Record; its name and phone are copied onto the Booking. */
  guestId: z.string().min(1).nullable().optional(),
  /** Save the typed name (and phone) as a new Guest Record. */
  saveGuest: z.boolean().optional(),
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

const addServiceBody = z.object({
  serviceId: z.string().min(1),
  /** Who performs it; the same Therapist when left out. */
  therapistId: z.string().min(1).optional(),
  /** Go ahead although it runs into someone's next Booking. */
  confirm: z.boolean().default(false),
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
    const [svc, people, daySales, dayRow, unclosed] = await Promise.all([
      c.var.db.select({ id: services.id, code: services.code, name: services.name }).from(services),
      c.var.db.select({ id: staff.id, displayName: staff.displayName, birthdate: staff.birthdate, active: staff.active }).from(staff),
      c.var.db
        .select({ id: sales.id, bookingId: sales.bookingId, amountDue: sales.amountDue, discountType: sales.discountType })
        .from(sales)
        .where(and(eq(sales.businessDay, day), eq(sales.status, 'paid'))),
      c.var.db.select().from(businessDays).where(eq(businessDays.date, day)).get(),
      openDays(c.var.db),
    ]);
    const svcById = new Map(svc.map((s) => [s.id, s]));
    const guestIds = [...new Set(state.dayBookings.map((b) => b.guestId).filter((g): g is string => !!g))];
    const guestStats = guestIds.length ? await visitStatsFor(c.var.db, guestIds) : new Map();
    const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.displayName ?? null) : null);
    const list = state.dayBookings
      .map((b) => ({
        ...b,
        serviceCode: svcById.get(b.serviceId)?.code ?? '',
        serviceName: svcById.get(b.serviceId)?.name ?? '',
        therapistName: nameOf(b.therapistId),
        requestedTherapistName: nameOf(b.requestedTherapistId),
        endsAt: b.startedAt ? addMinutes(b.startedAt, b.durationMin) : null,
        sale: daySales.find((x) => x.bookingId === b.id) ?? null,
        guestVisits: b.guestId ? (guestStats.get(b.guestId)?.visits ?? 0) : null,
        guestIsRegular: b.guestId ? (guestStats.get(b.guestId)?.isRegular ?? false) : false,
      }))
      .sort((a, b) => (a.startedAt ?? a.scheduledAt ?? a.createdAt).localeCompare(b.startedAt ?? b.scheduledAt ?? b.createdAt));
    const byId = new Map(state.therapists.map((t) => [t.id, t]));
    return c.json({
      day,
      now,
      businessDay: dayRow ?? null,
      unclosed: unclosed.filter((d) => d.date < day).map((d) => d.date),
      next: state.next?.staffId ?? null,
      // Staff celebrating today, for the Front Desk banner.
      birthdays: people.filter((p) => p.active && isBirthday(p.birthdate, day)).map((p) => p.displayName),
      // Running the front desk on a Relief Shift now.
      relieving: state.relieving.map((id) => nameOf(id)).filter(Boolean),
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
    // A walk-in is today's activity; a booking for later opens nothing yet.
    if (input.kind === 'walk_in') {
      const blocked = await openDayFor(c, businessDayOf(new Date(now)));
      if (blocked) return blocked;
    }
    const guest = await resolveGuest(db, { guestId: input.guestId, saveGuest: input.saveGuest, name: input.guestName ?? null, phone: input.guestPhone ?? null }, c.var.user.id);
    if (!guest.ok) return fail(c, 400, 'unknown_guest', guest.problem);
    const id = crypto.randomUUID();
    const row = {
      id,
      businessDay: businessDayOf(new Date(scheduledAt ?? now)),
      kind: input.kind,
      status: input.kind === 'scheduled' ? ('scheduled' as const) : ('waiting' as const),
      guestId: guest.guestId,
      guestName: guest.name,
      guestPhone: guest.phone,
      serviceId: service.id,
      durationMin: service.durationMin,
      scheduledAt,
      requestedTherapistId: input.requestedTherapistId ?? null,
      notes: input.notes ?? null,
      createdAt: now,
      createdBy: c.var.user.id,
    };
    if (guest.insert) await db.batch([guest.insert, db.insert(bookings).values(row)]);
    else await db.insert(bookings).values(row);
    return c.json({ id, guestId: guest.guestId }, 201);
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
    let newGuest = null;
    if (input.guestId !== undefined || input.saveGuest) {
      const guest = await resolveGuest(
        db,
        { guestId: input.guestId, saveGuest: input.saveGuest, name: changes.guestName ?? booking.guestName, phone: changes.guestPhone ?? booking.guestPhone },
        c.var.user.id,
      );
      if (!guest.ok) return fail(c, 400, 'unknown_guest', guest.problem);
      Object.assign(changes, { guestId: guest.guestId, guestName: guest.name, guestPhone: guest.phone });
      newGuest = guest.insert;
    }
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
    // The new Guest Record goes in first so the Booking can point at it.
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.update', entity: 'booking', entityId: booking.id, before: booking, after: changes }),
      ...(newGuest ? [newGuest] : []),
      db.update(bookings).set(changes).where(eq(bookings.id, booking.id)),
    ]);
    return c.json({ ok: true });
  })

  /** Links a Guest Record at any point before or after checkout, e.g. a walk-in who gives their name at the counter. */
  .put('/bookings/:id/guest', zValidator('json', z.object({ guestId: z.string().min(1).nullable(), saveGuest: z.boolean().optional(), guestName: optionalText(80), guestPhone: optionalText(30) }), invalidInput), async (c) => {
    const db = c.var.db;
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status === 'cancelled' || booking.status === 'no_show') return fail(c, 409, 'not_served', 'This booking was not served.');
    const input = c.req.valid('json');
    const guest = await resolveGuest(
      db,
      { guestId: input.guestId, saveGuest: input.saveGuest, name: input.guestName ?? booking.guestName, phone: input.guestPhone ?? booking.guestPhone },
      c.var.user.id,
    );
    if (!guest.ok) return fail(c, 400, 'unknown_guest', guest.problem);
    const changes = { guestId: guest.guestId, guestName: guest.name, guestPhone: guest.phone };
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.guest', entity: 'booking', entityId: booking.id, before: { guestId: booking.guestId }, after: changes }),
      ...(guest.insert ? [guest.insert] : []),
      db.update(bookings).set(changes).where(eq(bookings.id, booking.id)),
    ]);
    return c.json({ guestId: guest.guestId });
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
    const blocked = await openDayFor(c, businessDayOf(new Date(now)));
    if (blocked) return blocked;
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

  /**
   * An Added Service: the Guest asks for another Service partway through. It
   * follows this one in the same Room and starts by itself when this one is done.
   */
  .post('/bookings/:id/add-service', zValidator('json', addServiceBody, invalidInput), async (c) => {
    const db = c.var.db;
    const parent = await loadBooking(c);
    if (!parent) return fail(c, 404, 'not_found', 'Booking not found.');
    if (parent.status !== 'in_service' || !parent.startedAt || !parent.roomId) return fail(c, 409, 'not_in_service', 'Add a service while the guest is still in the room.');
    const input = c.req.valid('json');
    const next = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.parentBookingId, parent.id), inArray(bookings.status, ['scheduled', 'waiting', 'in_service'])))
      .get();
    if (next) return fail(c, 409, 'already_added', 'A service is already added after this one. Add to that one instead.');
    const [service, room] = await Promise.all([
      db.select().from(services).where(eq(services.id, input.serviceId)).get(),
      db.select().from(rooms).where(eq(rooms.id, parent.roomId)).get(),
    ]);
    if (!service || !service.active) return fail(c, 400, 'unknown_service', 'Pick a service that is offered.');
    if (!room || !roomFits(room, service, parent.flexMode)) return fail(c, 400, 'room_unsuitable', 'The recliner is for foot services only.');
    const therapistId = input.therapistId ?? parent.therapistId!;
    const start = addMinutes(parent.startedAt, parent.durationMin);
    const span = { start, end: addMinutes(start, service.durationMin) };
    if (therapistId !== parent.therapistId) {
      const now = nowIso();
      const state = await frontDeskState(db, businessDayOf(new Date(now)), now);
      if (!state.rotation.some((r) => r.staffId === therapistId)) return fail(c, 409, 'not_on_duty', 'That therapist is not clocked in.');
    }
    // Running into someone's next Booking is allowed once the desk has seen it.
    const clash = await requestClash(c, therapistId, span, parent.id);
    if (clash && !input.confirm) return fail(c, 409, 'clash', `${clash} Add it anyway, or move the later booking.`);
    const id = crypto.randomUUID();
    const row = {
      id,
      businessDay: parent.businessDay,
      kind: 'walk_in' as const,
      status: 'waiting' as const,
      guestId: parent.guestId,
      guestName: parent.guestName,
      guestPhone: parent.guestPhone,
      serviceId: service.id,
      durationMin: service.durationMin,
      // When it is expected to start, so clash checks see it.
      scheduledAt: start,
      // The same Therapist keeps the Guest as they were (requested or not); another one takes them as a Rotation turn.
      requestedTherapistId: therapistId === parent.therapistId ? parent.requestedTherapistId : null,
      therapistId,
      roomId: parent.roomId,
      flexMode: parent.flexMode,
      portableTable: parent.portableTable,
      parentBookingId: parent.id,
      createdAt: nowIso(),
      createdBy: c.var.user.id,
    };
    await db.batch([
      db.insert(bookings).values(row),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.add_service', entity: 'booking', entityId: id, after: row, reason: clash ?? undefined }),
    ]);
    return c.json({ id }, 201);
  })

  /** Ends a service. An Added Service waiting after it starts straight away in the same Room. */
  .post('/bookings/:id/done', async (c) => {
    const db = c.var.db;
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    if (booking.status !== 'in_service') return fail(c, 409, 'not_in_service', 'Only a service in progress can be marked done.');
    const now = nowIso();
    const finish = db
      .update(bookings)
      .set({ status: 'done', doneAt: now })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'in_service')));
    const next = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.parentBookingId, booking.id), eq(bookings.status, 'waiting')))
      .get();
    if (next?.therapistId) {
      const start = db
        .update(bookings)
        .set({ status: 'in_service', startedAt: now, businessDay: businessDayOf(new Date(now)) })
        .where(and(eq(bookings.id, next.id), eq(bookings.status, 'waiting')));
      try {
        await db.batch([finish, start]);
        return c.json({ ok: true, startedNext: next.id });
      } catch (err) {
        // Its therapist is busy with someone else: it waits to be started from the list.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    await finish;
    return c.json({ ok: true, startedNext: null });
  })

  /** A Guest's whole stay (the first Booking and its Added Services), for checking out together. */
  .get('/bookings/:id/stay', async (c) => {
    const db = c.var.db;
    const booking = await loadBooking(c);
    if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
    const [dayRows, svc, people, paid] = await Promise.all([
      db.select().from(bookings).where(eq(bookings.businessDay, booking.businessDay)),
      db.select({ id: services.id, name: services.name }).from(services),
      db.select({ id: staff.id, displayName: staff.displayName }).from(staff),
      db.select({ bookingId: sales.bookingId }).from(sales).where(and(eq(sales.businessDay, booking.businessDay), eq(sales.status, 'paid'))),
    ]);
    const paidIds = new Set(paid.map((p) => p.bookingId));
    const stay = stayOf(dayRows, booking.id).filter((b) => b.status !== 'cancelled' && b.status !== 'no_show');
    return c.json({
      bookings: stay.map((b) => ({
        id: b.id,
        status: b.status,
        serviceId: b.serviceId,
        serviceName: svc.find((s) => s.id === b.serviceId)?.name ?? b.serviceId,
        therapistName: people.find((p) => p.id === b.therapistId)?.displayName ?? null,
        startedAt: b.startedAt,
        paid: paidIds.has(b.id),
      })),
    });
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
