import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { addMinutes, businessDayOf, effectiveOn, roomFits, serviceSpanFrom, TOP_UP_PARTS, TOP_UP_STEP_MIN, topUpPrice, topUpRule, type Centavos, type TopUpPart } from '@spa/domain';
import { bookings, bookingTopUps, rooms, sales, servicePrices, services, staff, therapistChanges } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { frontDeskState, type BookingRow } from '../lib/front-desk';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { requireAuth, requireCapability } from '../auth/middleware';
import { reservedClash } from './bookings';

const guard = [requireAuth, requireCapability('bookings.manage')] as const;
const reason = z.string().trim().min(3, 'Give a short reason.').max(300);

const topUpBody = z.object({ steps: z.number().int().min(1).max(8).default(1), part: z.enum(TOP_UP_PARTS).nullable().default(null) });
const changeServiceBody = z.object({ serviceId: z.string().min(1), reason });
const changeTherapistBody = z.object({ therapistId: z.string().min(1), reason, guestNamed: z.boolean().default(false) });

type Service = typeof services.$inferSelect;

/** A Booking still open to change: under way, or finished but not paid. */
async function changeable(c: Context<AuthedEnv>): Promise<BookingRow | Response> {
  const db = c.var.db;
  const booking = await db.select().from(bookings).where(eq(bookings.id, c.req.param('id')!)).get();
  if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
  if (booking.status !== 'in_service' && booking.status !== 'done') return fail(c, 409, 'not_started', 'This can only be done once the service has started.');
  const paid = await db.select({ id: sales.id }).from(sales).where(and(eq(sales.bookingId, booking.id), eq(sales.status, 'paid'))).get();
  if (paid) return fail(c, 409, 'already_paid', 'This guest has already been checked out.');
  return booking;
}

/** The Added Service waiting to follow this Booking, if any. */
const followOn = (c: Context<AuthedEnv>, id: string) =>
  c.var.db.select().from(bookings).where(and(eq(bookings.parentBookingId, id), eq(bookings.status, 'waiting'))).get();

/**
 * Why this Service can't run for `durationMin` from its start: its Therapist's
 * reservation comes first, counting what follows in the same Room with them.
 */
async function runsIntoReservation(c: Context<AuthedEnv>, booking: BookingRow, durationMin: number, therapistId: string, next: BookingRow | undefined) {
  const extra = next?.therapistId === booking.therapistId ? next.durationMin : 0;
  return reservedClash(c, therapistId, serviceSpanFrom(booking.startedAt!, durationMin + extra), booking.id);
}

async function priceBook(c: Context<AuthedEnv>, day: string) {
  const all = await c.var.db.select().from(servicePrices);
  return (serviceId: string) => effectiveOn(all.filter((p) => p.serviceId === serviceId), day)?.regularPrice as Centavos | undefined;
}

async function serviceOf(c: Context<AuthedEnv>, id: string): Promise<Service | undefined> {
  return c.var.db.select().from(services).where(eq(services.id, id)).get();
}

export const serviceChangeRoutes = new Hono<AuthedEnv>()
  /** What a Top-up on this Booking would cost. */
  .get('/bookings/:id/top-up-options', ...guard, async (c) => {
    const booking = await changeable(c);
    if (booking instanceof Response) return booking;
    const service = (await serviceOf(c, booking.serviceId))!;
    const rule = topUpRule(service);
    if (!rule) return c.json({ eligible: false, price: null, parts: [] });
    const priceOf = await priceBook(c, booking.businessDay);
    const regular = priceOf(service.id) ?? (0 as Centavos);
    if (rule.kind === 'pick_part') {
      return c.json({ eligible: true, price: null, parts: TOP_UP_PARTS.map((part) => ({ part, price: topUpPrice(rule, regular, part, priceOf) })) });
    }
    return c.json({ eligible: true, price: topUpPrice(rule, regular, null, priceOf), parts: [] });
  })

  .post('/bookings/:id/top-up', ...guard, zValidator('json', topUpBody, invalidInput), async (c) => {
    const db = c.var.db;
    const booking = await changeable(c);
    if (booking instanceof Response) return booking;
    const service = (await serviceOf(c, booking.serviceId))!;
    const rule = topUpRule(service);
    if (!rule) return fail(c, 409, 'combo', 'A combo can’t be topped up. Add a service instead.');
    const input = c.req.valid('json');
    const part: TopUpPart | null = rule.kind === 'pick_part' ? input.part : null;
    if (rule.kind === 'pick_part' && !part) return fail(c, 400, 'part_required', 'Choose head, back or foot.');
    const priceOf = await priceBook(c, booking.businessDay);
    const price = topUpPrice(rule, priceOf(service.id) ?? (0 as Centavos), part, priceOf);
    if (price === null) return fail(c, 409, 'no_price', 'That 30-minute price is not set. Ask the Super Admin.');

    const durationMin = booking.durationMin + input.steps * TOP_UP_STEP_MIN;
    const running = booking.status === 'in_service';
    const next = running ? await followOn(c, booking.id) : undefined;
    if (running) {
      const blocked = await runsIntoReservation(c, booking, durationMin, booking.therapistId!, next);
      if (blocked) return fail(c, 409, 'therapist_reserved', blocked);
    }
    const now = nowIso();
    const rows = Array.from({ length: input.steps }, () => ({ id: crypto.randomUUID(), bookingId: booking.id, minutes: TOP_UP_STEP_MIN, price, part, createdAt: now, createdBy: c.var.user.id }));
    await db.batch([
      db.insert(bookingTopUps).values(rows),
      db.update(bookings).set({ durationMin }).where(eq(bookings.id, booking.id)),
      ...(next ? [db.update(bookings).set({ scheduledAt: addMinutes(booking.startedAt!, durationMin) }).where(eq(bookings.id, next.id))] : []),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.top_up', entity: 'booking', entityId: booking.id, after: { steps: input.steps, price, part } }),
    ]);
    return c.json({ durationMin }, 201);
  })

  /** A Service Change: the sale becomes the new Service at its full price, and any Top-ups go with the old one. */
  .post('/bookings/:id/change-service', ...guard, zValidator('json', changeServiceBody, invalidInput), async (c) => {
    const db = c.var.db;
    const booking = await changeable(c);
    if (booking instanceof Response) return booking;
    const input = c.req.valid('json');
    if (input.serviceId === booking.serviceId) return fail(c, 400, 'same_service', 'That is already the service.');
    const service = await serviceOf(c, input.serviceId);
    if (!service || !service.active) return fail(c, 400, 'unknown_service', 'Pick a service that is offered.');
    const room = await db.select().from(rooms).where(eq(rooms.id, booking.roomId!)).get();
    if (!room || !roomFits(room, service, booking.flexMode)) return fail(c, 400, 'room_unsuitable', 'The recliner is for foot services only.');

    const running = booking.status === 'in_service';
    const next = running ? await followOn(c, booking.id) : undefined;
    if (running && service.durationMin > booking.durationMin) {
      const blocked = await runsIntoReservation(c, booking, service.durationMin, booking.therapistId!, next);
      if (blocked) return fail(c, 409, 'therapist_reserved', blocked);
    }
    await db.batch([
      db.delete(bookingTopUps).where(eq(bookingTopUps.bookingId, booking.id)),
      db.update(bookings).set({ serviceId: service.id, durationMin: service.durationMin }).where(eq(bookings.id, booking.id)),
      ...(next ? [db.update(bookings).set({ scheduledAt: addMinutes(booking.startedAt!, service.durationMin) }).where(eq(bookings.id, next.id))] : []),
      auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'booking.change_service',
        entity: 'booking',
        entityId: booking.id,
        before: { serviceId: booking.serviceId, durationMin: booking.durationMin },
        after: { serviceId: service.id, durationMin: service.durationMin },
        reason: input.reason,
      }),
    ]);
    return c.json({ ok: true });
  })

  /** A Therapist Change: the clock runs on, the new Therapist earns it all, and the replaced one keeps their place. */
  .post('/bookings/:id/change-therapist', ...guard, zValidator('json', changeTherapistBody, invalidInput), async (c) => {
    const db = c.var.db;
    const booking = await changeable(c);
    if (booking instanceof Response) return booking;
    if (booking.status !== 'in_service') return fail(c, 409, 'not_in_service', 'The therapist can only be changed while the service is going.');
    const input = c.req.valid('json');
    if (input.therapistId === booking.therapistId) return fail(c, 400, 'same_therapist', 'That is already the therapist.');
    const now = nowIso();
    const state = await frontDeskState(db, businessDayOf(new Date(now)), now);
    const onDuty = state.rotation.find((r) => r.staffId === input.therapistId);
    if (!onDuty) return fail(c, 409, 'not_on_duty', 'That therapist is not clocked in.');
    if (onDuty.status !== 'free') return fail(c, 409, 'therapist_busy', 'That therapist is with another guest.');
    const person = await db.select({ displayName: staff.displayName }).from(staff).where(eq(staff.id, input.therapistId)).get();

    const next = await followOn(c, booking.id);
    const blocked = await runsIntoReservation(c, booking, booking.durationMin, input.therapistId, next);
    if (blocked) return fail(c, 409, 'therapist_reserved', blocked);

    const minutesServed = Math.max(0, Math.round((new Date(now).getTime() - new Date(booking.startedAt!).getTime()) / 60_000));
    const requestedTherapistId = input.guestNamed ? input.therapistId : booking.requestedTherapistId;
    const change = db
      .update(bookings)
      .set({ therapistId: input.therapistId, requestedTherapistId })
      .where(and(eq(bookings.id, booking.id), inArray(bookings.status, ['in_service'])));
    try {
      await db.batch([
        change,
        ...(next?.therapistId === booking.therapistId ? [db.update(bookings).set({ therapistId: input.therapistId, requestedTherapistId }).where(eq(bookings.id, next.id))] : []),
        db.insert(therapistChanges).values({
          id: crypto.randomUUID(),
          bookingId: booking.id,
          fromTherapistId: booking.therapistId!,
          toTherapistId: input.therapistId,
          minutesServed,
          reason: input.reason,
          changedAt: now,
          changedBy: c.var.user.id,
        }),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'booking.change_therapist', entity: 'booking', entityId: booking.id, before: { therapistId: booking.therapistId }, after: { therapistId: input.therapistId }, reason: input.reason }),
      ]);
    } catch (err) {
      // The partial unique index catches a race between two front-desk screens.
      if (err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${String(err.cause ?? '')}`)) {
        return fail(c, 409, 'therapist_busy', `${person?.displayName ?? 'That therapist'} was just taken.`);
      }
      throw err;
    }
    return c.json({ ok: true });
  });
