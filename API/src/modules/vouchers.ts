import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, between, desc, eq, gte, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import {
  bundleUse,
  businessDayOf,
  cardSerial,
  compactSerial,
  effectiveOn,
  MAX_CARD_RANGE,
  parseCardNumbers,
  paymentProblem,
  voucherOrder,
  type Centavos,
} from '@spa/domain';
import { PAYMENT_METHODS, servicePrices, services, VOUCHER_STATUSES, voucherEndorsements, voucherPayments, vouchers, voucherSales } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor, requireOpenDay } from '../lib/business-days';
import { resolveGuest } from '../lib/guests';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { centavos, isoDate, todayInManila } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

const sellBody = z.object({
  serviceId: z.string().min(1),
  /** Vouchers paid for; every five earn a free one. */
  qty: z.number().int().min(1).max(50),
  /** Every card handed over, paid and free, each picked by the Receptionist. */
  serials: z.array(z.string().trim().min(3).max(40)).min(1).max(60),
  buyerName: z.string().trim().min(2, 'Enter the buyer’s name.').max(120),
  buyerPhone: z.string().trim().max(30).optional(),
  /** The buyer's Guest Record, picked; or `saveGuest` to make one from the typed name. */
  guestId: z.string().min(1).nullable().optional(),
  saveGuest: z.boolean().optional(),
  payments: z
    .array(z.object({ method: z.enum(PAYMENT_METHODS), amount: centavos, gcashRef: z.string().trim().max(40).nullable().optional() }))
    .min(1)
    .max(4),
});

const endorseBody = z
  .object({
    serviceId: z.string().min(1),
    fromNo: z.number().int().min(1).max(9999),
    toNo: z.number().int().min(1).max(9999),
    endorsedOn: isoDate,
    note: z.string().trim().max(300).optional(),
  })
  .refine((e) => e.toNo >= e.fromNo, { message: 'The last card number must not be before the first.', path: ['toNo'] })
  .refine((e) => e.toNo - e.fromNo < MAX_CARD_RANGE, { message: `At most ${MAX_CARD_RANGE} cards at a time.`, path: ['toNo'] });

/** Go-live count: cards at the shop not sold yet, or paper Vouchers sold before the system, still unused or already used. */
const importBody = z.object({
  serviceId: z.string().min(1),
  /** Card numbers and ranges, e.g. "271-320, 330". */
  numbers: z.string().trim().min(1).max(2000),
  state: z.enum(['in_shop', 'unused', 'used_before_golive']),
  isFree: z.boolean().default(false),
  buyerName: z.string().trim().max(120).optional(),
  soldOn: isoDate.optional(),
  /** Used Before Go-live only, if known. */
  usedOn: isoDate.optional(),
  note: z.string().trim().max(300).optional(),
});

const markUsedBody = z.object({ usedOn: isoDate.optional(), note: z.string().trim().max(300).optional() });

const reasonBody = z.object({ reason: z.string().trim().min(3, 'Give a short reason.').max(300) });

/** Matches a serial however it was typed: "ntl-sm 0271", "NTLSM0271". */
const serialIs = (typed: string) => sql`replace(${vouchers.serial}, '-', '') = ${compactSerial(typed)}`;

/** Card numbers already in the system for a Service, or covered by an Endorsement not yet received. */
async function cardsTaken(db: AuthedEnv['Variables']['db'], serviceId: string, numbers: number[]): Promise<number[]> {
  const lo = numbers[0]!;
  const hi = numbers[numbers.length - 1]!;
  const wanted = new Set(numbers);
  const [existing, pending] = await Promise.all([
    db
      .select({ n: vouchers.cardNo })
      .from(vouchers)
      .where(and(eq(vouchers.serviceId, serviceId), between(vouchers.cardNo, lo, hi))),
    db
      .select({ fromNo: voucherEndorsements.fromNo, toNo: voucherEndorsements.toNo })
      .from(voucherEndorsements)
      .where(
        and(eq(voucherEndorsements.serviceId, serviceId), isNull(voucherEndorsements.receivedAt), lte(voucherEndorsements.fromNo, hi), gte(voucherEndorsements.toNo, lo)),
      ),
  ]);
  const taken = new Set(existing.map((r) => r.n!).filter((n) => wanted.has(n)));
  for (const p of pending) for (let n = p.fromNo; n <= p.toNo; n++) if (wanted.has(n)) taken.add(n);
  return [...taken].sort((a, b) => a - b);
}

const inRange = (numbers: number[]) => between(vouchers.cardNo, Math.min(...numbers), Math.max(...numbers));

const listCards = (prefix: string, ns: number[]) =>
  ns.length > 6 ? `${ns.slice(0, 6).map((n) => cardSerial(prefix, n)).join(', ')} and ${ns.length - 6} more` : ns.map((n) => cardSerial(prefix, n)).join(', ');

export const voucherRoutes = new Hono<AuthedEnv>()
  .use('/voucher-sales', requireAuth, requireCapability('sales.manage'))
  .use('/voucher-sales/*', requireAuth, requireCapability('sales.manage'))
  .use('/vouchers', requireAuth, requireCapability('sales.manage'))
  .use('/vouchers/*', requireAuth, requireCapability('sales.manage'))
  .use('/voucher-endorsements', requireAuth, requireCapability('sales.manage'))
  .use('/voucher-endorsements/*', requireAuth, requireCapability('sales.manage'))

  /** Sells the cards the Receptionist picked, at today's Regular Price; every five paid earn a free one. */
  .post('/voucher-sales', zValidator('json', sellBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const day = businessDayOf(new Date());
    const service = await db.select().from(services).where(eq(services.id, input.serviceId)).get();
    if (!service?.active || !service.voucherEligible) return fail(c, 400, 'not_voucher_service', 'That service is not sold as a voucher.');
    const regular = effectiveOn(await db.select().from(servicePrices).where(eq(servicePrices.serviceId, service.id)), day);
    if (!regular) return fail(c, 409, 'no_price', 'This service has no price today. Ask the Super Admin to set one.');
    const blocked = await openDayFor(c, day);
    if (blocked) return blocked;

    const order = voucherOrder(regular.regularPrice as Centavos, input.qty);
    const picked = [...new Set(input.serials.map(compactSerial))];
    if (picked.length !== input.serials.length) return fail(c, 400, 'duplicate_serial', 'The same card is picked twice.');
    if (picked.length !== order.paid + order.free) {
      return fail(c, 400, 'wrong_card_count', `Pick ${order.paid + order.free} cards: ${order.paid} paid${order.free ? ` and ${order.free} free` : ''}.`);
    }
    const cards = await db
      .select()
      .from(vouchers)
      .where(inArray(sql`replace(${vouchers.serial}, '-', '')`, picked));
    for (const typed of picked) {
      const card = cards.find((v) => compactSerial(v.serial) === typed);
      if (!card) return fail(c, 409, 'unknown_serial', `No voucher card ${typed} has been received at the shop.`);
      if (card.serviceId !== service.id) return fail(c, 409, 'wrong_service', `${card.serial} is for a different service.`);
      if (card.status !== 'in_shop') return fail(c, 409, 'card_not_in_shop', `${card.serial} has already been sold or cancelled.`);
    }
    const lines = input.payments.map((p) => ({ ...p, amount: p.amount as Centavos }));
    const problem = paymentProblem(order.total, lines);
    if (problem) return fail(c, 400, 'payment_mismatch', problem);

    const guest = await resolveGuest(db, { guestId: input.guestId, saveGuest: input.saveGuest, name: input.buyerName, phone: input.buyerPhone || null }, c.var.user.id);
    if (!guest.ok) return fail(c, 400, 'unknown_guest', guest.problem);
    const id = crypto.randomUUID();
    const now = nowIso();
    // A new Guest Record goes in first so the sale can point at it.
    if (guest.insert) await guest.insert;
    await db.batch([
      db.insert(voucherSales).values({
        id,
        businessDay: day,
        serviceId: service.id,
        guestId: guest.guestId,
        buyerName: guest.name ?? input.buyerName,
        buyerPhone: guest.phone,
        qtyPaid: order.paid,
        qtyFree: order.free,
        unitPrice: regular.regularPrice,
        total: order.total,
        createdAt: now,
        createdBy: c.var.user.id,
      }),
      db
        .update(vouchers)
        .set({ status: 'unused', voucherSaleId: id })
        .where(
          and(
            inArray(
              vouchers.id,
              cards.map((v) => v.id),
            ),
            eq(vouchers.status, 'in_shop'),
          ),
        ),
      ...lines.map((p) =>
        db.insert(voucherPayments).values({
          id: crypto.randomUUID(),
          voucherSaleId: id,
          businessDay: day,
          method: p.method,
          amount: p.amount,
          gcashRef: p.method === 'gcash' ? p.gcashRef!.trim() : null,
          createdAt: now,
        }),
      ),
    ]);
    return c.json({ id, total: order.total, serials: cards.map((v) => v.serial).sort() }, 201);
  })

  /** Voucher sales for double-checking: by date range, and by buyer or serial. Each shows how many are used and when. */
  .get(
    '/voucher-sales',
    zValidator('query', z.object({ from: isoDate, to: isoDate, q: z.string().trim().max(60).optional() }), invalidInput),
    async (c) => {
      const db = c.var.db;
      const { from, to, q } = c.req.valid('query');
      const bySerial = q
        ? db
            .select({ id: vouchers.voucherSaleId })
            .from(vouchers)
            .where(like(sql`replace(${vouchers.serial}, '-', '')`, `%${compactSerial(q)}%`))
        : undefined;
      const rows = await db
        .select({ sale: voucherSales, serviceName: services.name })
        .from(voucherSales)
        .innerJoin(services, eq(services.id, voucherSales.serviceId))
        .where(
          and(
            gte(voucherSales.businessDay, from),
            lte(voucherSales.businessDay, to),
            q && bySerial ? or(like(voucherSales.buyerName, `%${q}%`), like(voucherSales.buyerPhone, `%${q}%`), inArray(voucherSales.id, bySerial)) : undefined,
          ),
        )
        .orderBy(desc(voucherSales.createdAt))
        .limit(200);
      const ids = rows.map((r) => r.sale.id);
      const issued: (typeof vouchers.$inferSelect)[] = [];
      const pays: (typeof voucherPayments.$inferSelect)[] = [];
      // D1 binds at most 100 values per query.
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const [v, p] = await Promise.all([
          db.select().from(vouchers).where(inArray(vouchers.voucherSaleId, chunk)).orderBy(asc(vouchers.serial)),
          db.select().from(voucherPayments).where(inArray(voucherPayments.voucherSaleId, chunk)),
        ]);
        issued.push(...v);
        pays.push(...p);
      }
      return c.json({
        voucherSales: rows.map((r) => {
          const mine = issued.filter((v) => v.voucherSaleId === r.sale.id);
          return {
            ...r.sale,
            serviceName: r.serviceName,
            used: mine.filter((v) => v.status === 'redeemed').length,
            vouchers: bundleUse(
              r.sale.qtyPaid,
              mine.map((v) => ({ serial: v.serial, status: v.status, redeemedAt: v.redeemedAt })),
            ),
            payments: pays.filter((p) => p.voucherSaleId === r.sale.id),
          };
        }),
      });
    },
  )

  /** A mistaken Voucher sale is cancelled while the day is open and none of its Vouchers is used; its cards go back to the shop. */
  .post('/voucher-sales/:id/void', zValidator('json', reasonBody, invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(voucherSales).where(eq(voucherSales.id, c.req.param('id'))).get();
    if (!row || row.status !== 'paid') return fail(c, 404, 'not_found', 'Voucher sale not found.');
    const blocked = await requireOpenDay(c, row.businessDay);
    if (blocked) return blocked;
    const used = await db
      .select({ serial: vouchers.serial })
      .from(vouchers)
      .where(and(eq(vouchers.voucherSaleId, row.id), eq(vouchers.status, 'redeemed')))
      .get();
    if (used) return fail(c, 409, 'voucher_used', `Voucher ${used.serial} has already been used, so this sale cannot be cancelled.`);
    const { reason } = c.req.valid('json');
    await db.batch([
      db.update(voucherSales).set({ status: 'voided', voidReason: reason, voidedBy: c.var.user.id }).where(eq(voucherSales.id, row.id)),
      // Numbered cards are unsold again; serials from before numbered cards stop working.
      db
        .update(vouchers)
        .set({ status: sql`case when ${vouchers.cardNo} is null then 'voided' else 'in_shop' end`, voucherSaleId: null })
        .where(eq(vouchers.voucherSaleId, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher_sale.void', entity: 'voucher_sale', entityId: row.id, before: row, reason }),
    ]);
    return c.json({ ok: true });
  })

  .get(
    '/vouchers',
    zValidator(
      'query',
      z.object({ q: z.string().trim().max(40).optional(), status: z.enum(VOUCHER_STATUSES).optional(), serviceId: z.string().min(1).optional() }),
      invalidInput,
    ),
    async (c) => {
      const { q, status, serviceId } = c.req.valid('query');
      const rows = await c.var.db
        .select({ voucher: vouchers, serviceName: services.name, buyerName: voucherSales.buyerName, soldOn: voucherSales.businessDay })
        .from(vouchers)
        .innerJoin(services, eq(services.id, vouchers.serviceId))
        .leftJoin(voucherSales, eq(voucherSales.id, vouchers.voucherSaleId))
        .where(
          and(
            q ? like(sql`replace(${vouchers.serial}, '-', '')`, `%${compactSerial(q)}%`) : undefined,
            status ? eq(vouchers.status, status) : undefined,
            serviceId ? eq(vouchers.serviceId, serviceId) : undefined,
          ),
        )
        .orderBy(asc(vouchers.serial))
        .limit(500);
      return c.json({
        vouchers: rows.map((r) => ({
          ...r.voucher,
          serviceName: r.serviceName,
          buyerName: r.buyerName ?? r.voucher.importedBuyer,
          soldOn: r.soldOn ?? r.voucher.importedSoldOn,
        })),
      });
    },
  )

  .get('/vouchers/:serial', async (c) => {
    const row = await c.var.db
      .select({ voucher: vouchers, serviceName: services.name })
      .from(vouchers)
      .innerJoin(services, eq(services.id, vouchers.serviceId))
      .where(serialIs(c.req.param('serial')))
      .get();
    if (!row) return fail(c, 404, 'not_found', 'No voucher has that serial number.');
    return c.json({ ...row.voucher, serviceName: row.serviceName });
  })

  /** A card at the shop that is damaged or lost, so it can never be sold. */
  .post('/vouchers/:id/void', requireCapability('vouchers.endorse'), zValidator('json', reasonBody, invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(vouchers).where(eq(vouchers.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Voucher not found.');
    if (row.status !== 'in_shop') return fail(c, 409, 'not_in_shop', 'Only an unsold card can be cancelled here. Cancel a sold one through its sale.');
    const { reason } = c.req.valid('json');
    await db.batch([
      db.update(vouchers).set({ status: 'voided', voidReason: reason }).where(eq(vouchers.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher.void', entity: 'voucher', entityId: row.id, before: row, reason }),
    ]);
    return c.json({ ok: true });
  })

  /**
   * Go-live count, by card number: cards at the shop not sold yet, or paper
   * Vouchers sold before the system and still unused (not counted as sales again).
   */
  .post('/vouchers/import', requireCapability('vouchers.import'), zValidator('json', importBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const service = await db.select().from(services).where(eq(services.id, input.serviceId)).get();
    if (!service) return fail(c, 400, 'unknown_service', 'Pick a service.');
    if (!service.voucherPrefix) return fail(c, 409, 'no_voucher_prefix', 'Set this service’s voucher code (e.g. NTL-SM) under Settings first.');
    const numbers = parseCardNumbers(input.numbers);
    if (typeof numbers === 'string') return fail(c, 400, 'bad_numbers', numbers);
    const used = input.state === 'used_before_golive';
    const sold = input.state !== 'in_shop';
    // Paper Vouchers already counted as unused can be marked used by the same range.
    const flippable = used
      ? await db
          .select({ id: vouchers.id, n: vouchers.cardNo })
          .from(vouchers)
          .where(and(eq(vouchers.serviceId, service.id), eq(vouchers.imported, true), eq(vouchers.status, 'unused'), inRange(numbers)))
      : [];
    const flip = flippable.filter((v) => numbers.includes(v.n!));
    const counted = new Set(flip.map((v) => v.n!));
    const taken = (await cardsTaken(db, service.id, numbers)).filter((n) => !counted.has(n));
    if (taken.length) return fail(c, 409, 'duplicate_serial', `Already in the system: ${listCards(service.voucherPrefix, taken)}`);
    const now = nowIso();
    const usedFields = used ? { usedBeforeOn: input.usedOn ?? null, usedBeforeNote: input.note || null } : {};
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher.import', entity: 'service', entityId: service.id, after: input }),
      ...flip.map((v) => db.update(vouchers).set({ status: 'used_before_golive', ...usedFields }).where(eq(vouchers.id, v.id))),
      ...numbers.filter((n) => !counted.has(n)).map((n) =>
        db.insert(vouchers).values({
          id: crypto.randomUUID(),
          serial: cardSerial(service.voucherPrefix!, n),
          cardNo: n,
          serviceId: service.id,
          status: input.state,
          isFree: sold && input.isFree,
          imported: sold,
          importedBuyer: sold ? input.buyerName || null : null,
          importedSoldOn: sold ? (input.soldOn ?? null) : null,
          ...usedFields,
          createdAt: now,
          createdBy: c.var.user.id,
        }),
      ),
    ]);
    return c.json({ imported: numbers.length }, 201);
  })

  /** One paper Voucher found to have been used before Go-live. */
  .post('/vouchers/:id/mark-used', requireCapability('vouchers.import'), zValidator('json', markUsedBody, invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(vouchers).where(eq(vouchers.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Voucher not found.');
    if (!row.imported || row.status !== 'unused') return fail(c, 409, 'not_paper_unused', 'Only a paper voucher still unused can be marked used.');
    const input = c.req.valid('json');
    await db.batch([
      db.update(vouchers).set({ status: 'used_before_golive', usedBeforeOn: input.usedOn ?? null, usedBeforeNote: input.note || null }).where(eq(vouchers.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher.mark_used', entity: 'voucher', entityId: row.id, before: row, after: input }),
    ]);
    return c.json({ ok: true });
  })

  /** A card marked used by mistake, e.g. a Guest turns up holding it. */
  .post('/vouchers/:id/unmark-used', requireCapability('vouchers.import'), zValidator('json', reasonBody, invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(vouchers).where(eq(vouchers.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Voucher not found.');
    if (row.status !== 'used_before_golive') return fail(c, 409, 'not_used_before', 'This voucher is not marked as used before go-live.');
    const { reason } = c.req.valid('json');
    await db.batch([
      db.update(vouchers).set({ status: 'unused', usedBeforeOn: null, usedBeforeNote: null }).where(eq(vouchers.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher.unmark_used', entity: 'voucher', entityId: row.id, before: row, reason }),
    ]);
    return c.json({ ok: true });
  })

  /** Endorsements, unreceived first: the shop's For Receiving list. */
  .get('/voucher-endorsements', async (c) => {
    const rows = await c.var.db
      .select({ e: voucherEndorsements, serviceName: services.name, prefix: services.voucherPrefix })
      .from(voucherEndorsements)
      .innerJoin(services, eq(services.id, voucherEndorsements.serviceId))
      .orderBy(sql`${voucherEndorsements.receivedAt} is not null`, desc(voucherEndorsements.endorsedOn), desc(voucherEndorsements.createdAt))
      .limit(100);
    return c.json({
      endorsements: rows.map((r) => ({
        ...r.e,
        serviceName: r.serviceName,
        count: r.e.toNo - r.e.fromNo + 1,
        firstSerial: cardSerial(r.prefix ?? '?', r.e.fromNo),
        lastSerial: cardSerial(r.prefix ?? '?', r.e.toNo),
      })),
    });
  })

  /** The Super Admin hands a printed range of cards to the shop. */
  .post('/voucher-endorsements', requireCapability('vouchers.endorse'), zValidator('json', endorseBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const service = await db.select().from(services).where(eq(services.id, input.serviceId)).get();
    if (!service?.voucherEligible) return fail(c, 400, 'not_voucher_service', 'That service is not sold as a voucher.');
    if (!service.voucherPrefix) return fail(c, 409, 'no_voucher_prefix', 'Set this service’s voucher code (e.g. NTL-SM) under Settings first.');
    if (input.endorsedOn > todayInManila()) return fail(c, 400, 'future_date', 'The endorsement date cannot be in the future.');
    const numbers = Array.from({ length: input.toNo - input.fromNo + 1 }, (_, i) => input.fromNo + i);
    const taken = await cardsTaken(db, service.id, numbers);
    if (taken.length) return fail(c, 409, 'duplicate_serial', `Already endorsed or in the system: ${listCards(service.voucherPrefix, taken)}`);
    const id = crypto.randomUUID();
    await db.insert(voucherEndorsements).values({ id, ...input, note: input.note || null, createdAt: nowIso(), createdBy: c.var.user.id });
    return c.json({ id }, 201);
  })

  /** An Endorsement entered by mistake is removed before the shop receives it. */
  .delete('/voucher-endorsements/:id', requireCapability('vouchers.endorse'), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(voucherEndorsements).where(eq(voucherEndorsements.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Endorsement not found.');
    if (row.receivedAt) return fail(c, 409, 'already_received', 'The shop has already received these cards. Cancel any missing card instead.');
    await db.batch([
      db.delete(voucherEndorsements).where(eq(voucherEndorsements.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher_endorsement.delete', entity: 'voucher_endorsement', entityId: row.id, before: row }),
    ]);
    return c.json({ ok: true });
  })

  /** The shop confirms the cards arrived; they can then be sold. A missing card is noted and cancelled by the Super Admin. */
  .post(
    '/voucher-endorsements/:id/receive',
    zValidator('json', z.object({ note: z.string().trim().max(300).optional() }), invalidInput),
    async (c) => {
      const db = c.var.db;
      const row = await db
        .select({ e: voucherEndorsements, prefix: services.voucherPrefix })
        .from(voucherEndorsements)
        .innerJoin(services, eq(services.id, voucherEndorsements.serviceId))
        .where(eq(voucherEndorsements.id, c.req.param('id')))
        .get();
      if (!row) return fail(c, 404, 'not_found', 'Endorsement not found.');
      if (row.e.receivedAt) return fail(c, 409, 'already_received', 'These cards have already been received.');
      const prefix = row.prefix;
      if (!prefix) return fail(c, 409, 'no_voucher_prefix', 'This service has no voucher code. Ask the Super Admin.');
      const now = nowIso();
      const numbers = Array.from({ length: row.e.toNo - row.e.fromNo + 1 }, (_, i) => row.e.fromNo + i);
      await db.batch([
        db
          .update(voucherEndorsements)
          .set({ receivedAt: now, receivedBy: c.var.user.id, receiveNote: c.req.valid('json').note || null })
          .where(eq(voucherEndorsements.id, row.e.id)),
        ...numbers.map((n) =>
          db.insert(vouchers).values({
            id: crypto.randomUUID(),
            serial: cardSerial(prefix, n),
            cardNo: n,
            serviceId: row.e.serviceId,
            endorsementId: row.e.id,
            status: 'in_shop',
            createdAt: now,
            createdBy: c.var.user.id,
          }),
        ),
      ]);
      return c.json({ received: numbers.length });
    },
  );
