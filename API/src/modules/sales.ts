import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  can,
  commissionFor,
  commissionRateOn,
  effectiveOn,
  paymentProblem,
  quoteSale,
  toManila,
  type Centavos,
  type Quote,
} from '@spa/domain';
import { addons, bookings, commissionRates, holidays, PAYMENT_METHODS, payments, promos, saleAddons, sales, servicePrices, staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor, requireOpenDay } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { centavos, isoDate } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

/** What changes the price: lenient, so the screen can re-price while the ID number is still being typed. */
const quoteBody = z.object({
  bookingId: z.string().min(1),
  statutory: z.enum(['senior', 'pwd']).nullable().default(null),
  addonIds: z.array(z.string().min(1)).max(10).default([]),
  complimentary: z.boolean().default(false),
});

const checkout = z.object({
  bookingId: z.string().min(1),
  statutory: z
    .object({ kind: z.enum(['senior', 'pwd']), idNumber: z.string().trim().min(3, 'Enter the ID number.').max(40) })
    .nullable()
    .default(null),
  addonIds: z.array(z.string().min(1)).max(10).default([]),
  /** Super Admin only. */
  complimentaryReason: z.string().trim().min(3, 'Give a short reason.').max(300).nullable().default(null),
});

const payment = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: centavos,
  gcashRef: z.string().trim().max(40).nullable().optional(),
});

const sale = checkout.extend({
  payments: z.array(payment).max(4),
  bookletInvoiceNo: z.string().trim().max(30).nullable().optional(),
});

type PriceInput = z.infer<typeof quoteBody>;

type Priced = {
  booking: typeof bookings.$inferSelect;
  quote: Quote;
  addonLines: { id: string; name: string; price: number }[];
  commission: { bp: number; amount: Centavos };
  isHoliday: boolean;
};

/** Prices a finished Booking from the catalogue in force on its Business Day. */
async function price(c: Context<AuthedEnv>, input: PriceInput): Promise<Priced | Response> {
  const db = c.var.db;
  const booking = await db.select().from(bookings).where(eq(bookings.id, input.bookingId)).get();
  if (!booking) return fail(c, 404, 'not_found', 'Booking not found.');
  if (booking.status !== 'done' || !booking.therapistId || !booking.startedAt) {
    return fail(c, 409, 'not_done', 'Check out a service once it is done.');
  }
  const paid = await db
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.bookingId, booking.id), eq(sales.status, 'paid')))
    .get();
  if (paid) return fail(c, 409, 'already_paid', 'This guest has already been checked out.');
  if (input.complimentary && !can(c.var.user.role, 'sales.complimentary')) {
    return fail(c, 403, 'forbidden', 'Only the Super Admin can give a Complimentary Service.');
  }
  const day = booking.businessDay;
  const [prices, allPromos, chosenAddons, therapist, holiday, rates] = await Promise.all([
    db.select().from(servicePrices).where(eq(servicePrices.serviceId, booking.serviceId)),
    db.select().from(promos),
    input.addonIds.length ? db.select().from(addons).where(inArray(addons.id, input.addonIds)) : Promise.resolve([]),
    db.select().from(staff).where(eq(staff.id, booking.therapistId)).get(),
    db.select().from(holidays).where(eq(holidays.date, day)).get(),
    db.select().from(commissionRates),
  ]);
  const regular = effectiveOn(prices, day);
  if (!regular) return fail(c, 409, 'no_price', 'This service has no price for that day. Ask the Super Admin to set one.');
  const addonLines = input.addonIds.map((id) => chosenAddons.find((a) => a.id === id));
  if (addonLines.some((a) => !a || !a.active)) return fail(c, 400, 'unknown_addon', 'Pick add-ons that are offered.');

  const rate = commissionRateOn(rates, therapist?.therapistClass ?? 'regular', day);
  if (!rate) return fail(c, 409, 'no_commission_rate', 'No Commission rate is set for this therapist. Ask the Super Admin.');
  const isHoliday = !!holiday?.raisesCommission;
  const started = toManila(new Date(booking.startedAt));

  return {
    booking,
    quote: quoteSale({
      serviceId: booking.serviceId,
      regularPrice: regular.regularPrice as Centavos,
      startDate: started.date,
      startTime: started.time,
      promos: allPromos,
      statutory: input.statutory,
      complimentary: input.complimentary,
      addonPrices: addonLines.map((a) => a!.price as Centavos),
    }),
    addonLines: addonLines.map((a) => ({ id: a!.id, name: a!.name, price: a!.price })),
    commission: commissionFor(regular.regularPrice as Centavos, rate, isHoliday),
    isHoliday,
  };
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${String(err.cause ?? '')}`);

export const salesRoutes = new Hono<AuthedEnv>()
  .use(requireAuth, requireCapability('sales.manage'))

  /** The price breakdown checkout would record, without recording it. */
  .post('/quote', zValidator('json', quoteBody, invalidInput), async (c) => {
    const priced = await price(c, c.req.valid('json'));
    if (priced instanceof Response) return priced;
    return c.json({ ...priced.quote, addons: priced.addonLines });
  })

  .post('/', zValidator('json', sale, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const priced = await price(c, {
      bookingId: input.bookingId,
      statutory: input.statutory?.kind ?? null,
      addonIds: input.addonIds,
      complimentary: !!input.complimentaryReason,
    });
    if (priced instanceof Response) return priced;
    const { booking, quote, commission } = priced;
    const blocked = await openDayFor(c, booking.businessDay);
    if (blocked) return blocked;

    const lines = input.payments.map((p) => ({ ...p, amount: p.amount as Centavos }));
    const problem = paymentProblem(quote.amountDue, lines);
    if (problem) return fail(c, 400, 'payment_mismatch', problem);

    const db = c.var.db;
    const id = crypto.randomUUID();
    const now = nowIso();
    const discountRef =
      quote.discount.type === 'promo' ? quote.discount.promoId : quote.discount.type === 'senior' || quote.discount.type === 'pwd' ? input.statutory!.idNumber : null;
    try {
      await db.batch([
        db.insert(sales).values({
          id,
          bookingId: booking.id,
          businessDay: booking.businessDay,
          serviceId: booking.serviceId,
          therapistId: booking.therapistId!,
          regularPrice: quote.regularPrice,
          discountType: quote.discount.type,
          discountRef,
          discountBp: quote.discount.bp,
          discountAmount: quote.discount.amount,
          serviceAmount: quote.serviceAmount,
          addonsTotal: quote.addonsTotal,
          amountDue: quote.amountDue,
          focKind: quote.focKind,
          commissionBp: commission.bp,
          commissionAmount: commission.amount,
          isHoliday: priced.isHoliday,
          bookletInvoiceNo: input.bookletInvoiceNo || null,
          reason: input.complimentaryReason,
          createdAt: now,
          createdBy: c.var.user.id,
        }),
        ...priced.addonLines.map((a) =>
          db.insert(saleAddons).values({ id: crypto.randomUUID(), saleId: id, addonId: a.id, name: a.name, price: a.price }),
        ),
        ...lines.map((p) =>
          db.insert(payments).values({
            id: crypto.randomUUID(),
            saleId: id,
            businessDay: booking.businessDay,
            method: p.method,
            amount: p.amount,
            gcashRef: p.method === 'gcash' ? p.gcashRef!.trim() : null,
            createdAt: now,
          }),
        ),
        ...(input.complimentaryReason
          ? [auditInsert(db, { actorUserId: c.var.user.id, action: 'sale.complimentary', entity: 'sale', entityId: id, reason: input.complimentaryReason })]
          : []),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(c, 409, 'already_paid', 'This guest has already been checked out.');
      throw err;
    }
    return c.json({ id, amountDue: quote.amountDue }, 201);
  })

  /** A mistaken checkout is voided (never deleted) and can be redone while the day is open. */
  .post('/:id/void', zValidator('json', z.object({ reason: z.string().trim().min(3, 'Give a short reason.').max(300) }), invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(sales).where(eq(sales.id, c.req.param('id'))).get();
    if (!row || row.status !== 'paid') return fail(c, 404, 'not_found', 'Sale not found.');
    const blocked = await requireOpenDay(c, row.businessDay);
    if (blocked) return blocked;
    const { reason } = c.req.valid('json');
    await db.batch([
      db.update(sales).set({ status: 'voided', voidReason: reason, voidedBy: c.var.user.id }).where(and(eq(sales.id, row.id), eq(sales.status, 'paid'))),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'sale.void', entity: 'sale', entityId: row.id, before: row, reason }),
    ]);
    return c.json({ ok: true });
  })

  .get('/', zValidator('query', z.object({ day: isoDate }), invalidInput), async (c) => {
    const db = c.var.db;
    const { day } = c.req.valid('query');
    const [rows, pays, extras] = await Promise.all([
      db.select().from(sales).where(eq(sales.businessDay, day)).orderBy(asc(sales.createdAt)),
      db.select().from(payments).where(eq(payments.businessDay, day)),
      db
        .select({ saleId: saleAddons.saleId, name: saleAddons.name, price: saleAddons.price })
        .from(saleAddons)
        .innerJoin(sales, eq(sales.id, saleAddons.saleId))
        .where(eq(sales.businessDay, day)),
    ]);
    return c.json({
      sales: rows.map((s) => ({
        ...s,
        payments: pays.filter((p) => p.saleId === s.id),
        addons: extras.filter((a) => a.saleId === s.id),
      })),
    });
  });
