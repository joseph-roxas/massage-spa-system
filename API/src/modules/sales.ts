import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  can,
  commissionFor,
  commissionRateOn,
  bundleUse,
  compactSerial,
  effectiveOn,
  paymentProblem,
  promoProblem,
  quoteSale,
  redemptionIsFree,
  redemptionProblem,
  splitPayments,
  stayOf,
  toManila,
  type Centavos,
  type PaymentLine,
  type Quote,
} from '@spa/domain';
import { bookings, commissionRates, holidays, PAYMENT_METHODS, payments, promos, sales, servicePrices, serviceSetAsides, services, staff, vouchers, voucherSales } from '@spa/db';
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
  /** The Promo picked at checkout, or null for none; left out, the best that applies. */
  promoId: z.string().min(1).nullish(),
  complimentary: z.boolean().default(false),
  voucherSerial: z.string().trim().max(40).nullable().default(null),
});

const checkout = z.object({
  bookingId: z.string().min(1),
  statutory: z
    .object({ kind: z.enum(['senior', 'pwd']), idNumber: z.string().trim().min(3, 'Enter the ID number.').max(40) })
    .nullable()
    .default(null),
  promoId: z.string().min(1).nullish(),
  /** Super Admin only. */
  complimentaryReason: z.string().trim().min(3, 'Give a short reason.').max(300).nullable().default(null),
  voucherSerial: z.string().trim().max(40).nullable().default(null),
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

/** A whole stay: one checkout line per Service, one payment for all. */
const stayBody = z.object({
  items: z.array(checkout).min(1).max(8),
  payments: z.array(payment).max(4),
  bookletInvoiceNo: z.string().trim().max(30).nullable().optional(),
});

type PriceInput = z.infer<typeof quoteBody>;

type VoucherBundle = {
  buyerName: string | null;
  buyerPhone: string | null;
  soldOn: string | null;
  qtyPaid: number | null;
  vouchers: { serial: string; redeemedAt: string | null; free: boolean }[];
  /** This Redemption is a Real FOC. */
  thisIsFree: boolean;
};

type Priced = {
  booking: typeof bookings.$inferSelect;
  quote: Quote;
  setAside: number;
  commission: { bp: number; amount: Centavos };
  isHoliday: boolean;
  voucher: typeof vouchers.$inferSelect | null;
  /** The Voucher's Bundle, so checkout can see who bought it, when, and how many are used. */
  voucherBundle: VoucherBundle | null;
  /** Every running Promo, with why it doesn't cover this Service (null if it does). */
  promoChoices: { id: string; name: string; percentBp: number; problem: string | null }[];
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
  let voucher: typeof vouchers.$inferSelect | null = null;
  let voucherBundle: VoucherBundle | null = null;
  if (input.voucherSerial) {
    voucher =
      (await db
        .select()
        .from(vouchers)
        .where(sql`replace(${vouchers.serial}, '-', '') = ${compactSerial(input.voucherSerial)}`)
        .get()) ?? null;
    const problem = redemptionProblem(voucher, booking.serviceId);
    if (problem) return fail(c, 409, 'voucher_unusable', problem);
    voucherBundle = await bundleOf(c, voucher!);
  }
  const day = booking.businessDay;
  const [prices, setAsides, allPromos, therapist, holiday, rates] = await Promise.all([
    db.select().from(servicePrices).where(eq(servicePrices.serviceId, booking.serviceId)),
    db.select().from(serviceSetAsides).where(eq(serviceSetAsides.serviceId, booking.serviceId)),
    db
      .select({ promo: promos, serviceName: services.name })
      .from(promos)
      .innerJoin(services, eq(services.id, promos.serviceId))
      .where(eq(promos.active, true)),
    db.select().from(staff).where(eq(staff.id, booking.therapistId)).get(),
    db.select().from(holidays).where(eq(holidays.date, day)).get(),
    db.select().from(commissionRates),
  ]);
  const regular = effectiveOn(prices, day);
  if (!regular) return fail(c, 409, 'no_price', 'This service has no price for that day. Ask the Super Admin to set one.');
  const setAside = effectiveOn(setAsides, day)?.amount ?? 0;

  const rate = commissionRateOn(rates, therapist?.therapistClass ?? 'regular', day);
  if (!rate) return fail(c, 409, 'no_commission_rate', 'No Commission rate is set for this therapist. Ask the Super Admin.');
  const isHoliday = !!holiday?.raisesCommission;
  const started = toManila(new Date(booking.startedAt));
  const startedService = { serviceId: booking.serviceId, startDate: started.date, startTime: started.time };
  const promoChoices = allPromos.map(({ promo, serviceName }) => ({
    id: promo.id,
    name: promo.name,
    percentBp: promo.percentBp,
    problem: promoProblem({ ...promo, serviceName }, startedService),
  }));
  if (input.promoId) {
    const picked = promoChoices.find((p) => p.id === input.promoId);
    if (!picked) return fail(c, 409, 'promo_unusable', 'That Promo is not running.');
    if (picked.problem) return fail(c, 409, 'promo_unusable', `${picked.name}: ${picked.problem}.`);
  }

  return {
    booking,
    quote: quoteSale({
      serviceId: booking.serviceId,
      regularPrice: regular.regularPrice as Centavos,
      startDate: started.date,
      startTime: started.time,
      promos: allPromos.map((p) => p.promo),
      promoId: input.promoId,
      statutory: input.statutory,
      complimentary: input.complimentary,
      voucher: voucher && { serial: voucher.serial, isFree: voucherBundle!.thisIsFree },
    }),
    setAside,
    commission: commissionFor(regular.regularPrice as Centavos, rate, isHoliday, setAside),
    isHoliday,
    voucher,
    voucherBundle,
    promoChoices,
  };
}

/** The Bundle a Voucher was sold in (or its paper record), and whether redeeming it now is a Real FOC. */
async function bundleOf(c: Context<AuthedEnv>, voucher: typeof vouchers.$inferSelect): Promise<VoucherBundle> {
  const db = c.var.db;
  const sale = voucher.voucherSaleId ? await db.select().from(voucherSales).where(eq(voucherSales.id, voucher.voucherSaleId)).get() : undefined;
  const siblings = sale ? await db.select().from(vouchers).where(eq(vouchers.voucherSaleId, sale.id)).orderBy(asc(vouchers.serial)) : [voucher];
  const redeemedBefore = siblings.filter((v) => v.status === 'redeemed').length;
  return {
    buyerName: sale?.buyerName ?? voucher.importedBuyer,
    buyerPhone: sale?.buyerPhone ?? null,
    soldOn: sale?.businessDay ?? voucher.importedSoldOn,
    qtyPaid: sale?.qtyPaid ?? null,
    vouchers: bundleUse(
      sale?.qtyPaid ?? (voucher.isFree ? 0 : 1),
      siblings.map((v) => ({ serial: v.serial, redeemedAt: v.redeemedAt })),
    ),
    thisIsFree: redemptionIsFree({ imported: !sale, isFree: voucher.isFree, qtyPaid: sale?.qtyPaid ?? null, redeemedBefore }),
  };
}

type CheckoutInput = z.infer<typeof checkout>;

/** Prices one checkout line the way the quote did. */
const priceFor = (c: Context<AuthedEnv>, input: CheckoutInput) =>
  price(c, {
    bookingId: input.bookingId,
    statutory: input.statutory?.kind ?? null,
    promoId: input.promoId,
    complimentary: !!input.complimentaryReason,
    voucherSerial: input.voucherSerial,
  });

/** Everything one Sale writes: the Sale, its payments, the Voucher it redeems. */
function saleStatements(c: Context<AuthedEnv>, input: CheckoutInput, priced: Priced, lines: readonly PaymentLine[], bookletInvoiceNo: string | null, now: string) {
  const db = c.var.db;
  const { booking, quote, commission } = priced;
  const id = crypto.randomUUID();
  const discountRef =
    quote.discount.type === 'promo'
      ? quote.discount.promoId
      : quote.discount.type === 'senior' || quote.discount.type === 'pwd'
        ? input.statutory!.idNumber
        : quote.discount.type === 'voucher'
          ? priced.voucher!.serial
          : null;
  const statements = [
    db.insert(sales).values({
      id,
      bookingId: booking.id,
      businessDay: booking.businessDay,
      serviceId: booking.serviceId,
      therapistId: booking.therapistId!,
      regularPrice: quote.regularPrice,
      setAside: priced.setAside,
      discountType: quote.discount.type,
      discountRef,
      discountBp: quote.discount.bp,
      discountAmount: quote.discount.amount,
      serviceAmount: quote.serviceAmount,
      amountDue: quote.amountDue,
      focKind: quote.focKind,
      commissionBp: commission.bp,
      commissionAmount: commission.amount,
      isHoliday: priced.isHoliday,
      bookletInvoiceNo,
      reason: input.complimentaryReason,
      createdAt: now,
      createdBy: c.var.user.id,
    }),
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
    // Single use is also enforced by sales_one_per_voucher, should two desks race.
    ...(priced.voucher
      ? [
          db
            .update(vouchers)
            .set({ status: 'redeemed', redeemedSaleId: id, redeemedAt: now })
            .where(and(eq(vouchers.id, priced.voucher.id), eq(vouchers.status, 'unused'))),
        ]
      : []),
    ...(input.complimentaryReason
      ? [auditInsert(db, { actorUserId: c.var.user.id, action: 'sale.complimentary', entity: 'sale', entityId: id, reason: input.complimentaryReason })]
      : []),
  ];
  return { id, statements };
}

/** Turns a failed checkout write into the reason the desk sees. */
function checkoutConflict(c: Context<AuthedEnv>, err: unknown, withVoucher: boolean) {
  if (!isUniqueViolation(err)) throw err;
  return withVoucher && /discount_ref/.test(`${(err as Error).message} ${String((err as Error).cause ?? '')}`)
    ? fail(c, 409, 'voucher_unusable', 'This voucher has already been used.')
    : fail(c, 409, 'already_paid', 'This guest has already been checked out.');
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${String(err.cause ?? '')}`);

export const salesRoutes = new Hono<AuthedEnv>()
  .use(requireAuth, requireCapability('sales.manage'))

  /** The price breakdown checkout would record, without recording it. */
  .post('/quote', zValidator('json', quoteBody, invalidInput), async (c) => {
    const priced = await price(c, c.req.valid('json'));
    if (priced instanceof Response) return priced;
    return c.json({ ...priced.quote, promos: priced.promoChoices, voucherBundle: priced.voucherBundle });
  })

  .post('/', zValidator('json', sale, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const priced = await priceFor(c, input);
    if (priced instanceof Response) return priced;
    const { booking, quote } = priced;
    const blocked = await openDayFor(c, booking.businessDay);
    if (blocked) return blocked;

    const lines = input.payments.map((p) => ({ ...p, amount: p.amount as Centavos }));
    const problem = paymentProblem(quote.amountDue, lines);
    if (problem) return fail(c, 400, 'payment_mismatch', problem);

    const { id, statements } = saleStatements(c, input, priced, lines, input.bookletInvoiceNo || null, nowIso());
    try {
      await c.var.db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    } catch (err) {
      return checkoutConflict(c, err, !!priced.voucher);
    }
    return c.json({ id, amountDue: quote.amountDue }, 201);
  })

  /**
   * Checks out a Guest's whole stay (a Booking and its Added Services) with one
   * payment: each Service still gets its own Sale, Discount and Commission.
   */
  .post('/stay', zValidator('json', stayBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    if (new Set(input.items.map((i) => i.bookingId)).size !== input.items.length) return fail(c, 400, 'duplicate_booking', 'A service is listed twice.');
    const priced: Priced[] = [];
    for (const item of input.items) {
      const p = await priceFor(c, item);
      if (p instanceof Response) return p;
      priced.push(p);
    }
    const first = priced[0]!.booking;
    const dayRows = await db.select().from(bookings).where(eq(bookings.businessDay, first.businessDay));
    const stay = stayOf(dayRows, first.id).filter((b) => b.status !== 'cancelled' && b.status !== 'no_show');
    const paidIds = new Set(
      (await db.select({ bookingId: sales.bookingId }).from(sales).where(and(eq(sales.businessDay, first.businessDay), eq(sales.status, 'paid')))).map((s) => s.bookingId),
    );
    const owing = stay.filter((b) => !paidIds.has(b.id));
    if (owing.some((b) => b.status !== 'done')) return fail(c, 409, 'stay_unfinished', 'A service in this stay is not done yet. Check out once it ends.');
    const wanted = new Set(owing.map((b) => b.id));
    if (input.items.length !== wanted.size || input.items.some((i) => !wanted.has(i.bookingId))) {
      return fail(c, 400, 'not_the_stay', 'Check out every service of this stay together.');
    }
    const blocked = await openDayFor(c, first.businessDay);
    if (blocked) return blocked;

    const lines = input.payments.map((p) => ({ ...p, amount: p.amount as Centavos }));
    const dues = priced.map((p) => p.quote.amountDue);
    const total = dues.reduce((s, d) => s + d, 0) as Centavos;
    const problem = paymentProblem(total, lines);
    if (problem) return fail(c, 400, 'payment_mismatch', problem);
    const split = splitPayments(dues, lines);

    const now = nowIso();
    const written = input.items.map((item, i) => saleStatements(c, item, priced[i]!, split[i]!, input.bookletInvoiceNo || null, now));
    const statements = written.flatMap((w) => w.statements);
    try {
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    } catch (err) {
      return checkoutConflict(c, err, priced.some((p) => p.voucher));
    }
    return c.json({ ids: written.map((w) => w.id), amountDue: total }, 201);
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
      // The Voucher can be used again once its checkout is voided.
      ...(row.discountType === 'voucher'
        ? [db.update(vouchers).set({ status: 'unused', redeemedSaleId: null, redeemedAt: null }).where(eq(vouchers.redeemedSaleId, row.id))]
        : []),
    ]);
    return c.json({ ok: true });
  })

  .get('/', zValidator('query', z.object({ day: isoDate }), invalidInput), async (c) => {
    const db = c.var.db;
    const { day } = c.req.valid('query');
    const [rows, pays] = await Promise.all([
      db.select().from(sales).where(eq(sales.businessDay, day)).orderBy(asc(sales.createdAt)),
      db.select().from(payments).where(eq(payments.businessDay, day)),
    ]);
    return c.json({
      sales: rows.map((s) => ({
        ...s,
        payments: pays.filter((p) => p.saleId === s.id),
      })),
    });
  });
