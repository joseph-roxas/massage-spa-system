import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, like } from 'drizzle-orm';
import { businessDayOf, effectiveOn, newSerial, normalizeSerial, paymentProblem, voucherOrder, type Centavos } from '@spa/domain';
import { PAYMENT_METHODS, servicePrices, services, VOUCHER_STATUSES, voucherPayments, vouchers, voucherSales } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor, requireOpenDay } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { centavos, isoDate } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

const sellBody = z.object({
  serviceId: z.string().min(1),
  qty: z.number().int().min(1).max(50),
  buyerName: z.string().trim().max(120).optional(),
  buyerPhone: z.string().trim().max(30).optional(),
  payments: z
    .array(z.object({ method: z.enum(PAYMENT_METHODS), amount: centavos, gcashRef: z.string().trim().max(40).nullable().optional() }))
    .min(1)
    .max(4),
});

const importBody = z.object({
  serviceId: z.string().min(1),
  // D1 binds at most 100 values per query; the screen sends larger lists in chunks.
  serials: z.array(z.string().trim().min(3).max(40)).min(1).max(90),
  isFree: z.boolean().default(false),
});

const reasonBody = z.object({ reason: z.string().trim().min(3, 'Give a short reason.').max(300) });

function serialsFor(code: string, count: number): string[] {
  const out = new Set<string>();
  while (out.size < count) out.add(newSerial(code, crypto.getRandomValues(new Uint8Array(6))));
  return [...out];
}

export const voucherRoutes = new Hono<AuthedEnv>()
  .use('/voucher-sales', requireAuth, requireCapability('sales.manage'))
  .use('/voucher-sales/*', requireAuth, requireCapability('sales.manage'))
  .use('/vouchers', requireAuth, requireCapability('sales.manage'))
  .use('/vouchers/*', requireAuth, requireCapability('sales.manage'))

  /** Sells Vouchers at today's Regular Price; every five earn a free one. */
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
    const lines = input.payments.map((p) => ({ ...p, amount: p.amount as Centavos }));
    const problem = paymentProblem(order.total, lines);
    if (problem) return fail(c, 400, 'payment_mismatch', problem);

    const id = crypto.randomUUID();
    const now = nowIso();
    const serials = serialsFor(service.code, order.paid + order.free);
    await db.batch([
      db.insert(voucherSales).values({
        id,
        businessDay: day,
        serviceId: service.id,
        buyerName: input.buyerName || null,
        buyerPhone: input.buyerPhone || null,
        qtyPaid: order.paid,
        qtyFree: order.free,
        unitPrice: regular.regularPrice,
        total: order.total,
        createdAt: now,
        createdBy: c.var.user.id,
      }),
      ...serials.map((serial, i) =>
        db.insert(vouchers).values({
          id: crypto.randomUUID(),
          serial,
          serviceId: service.id,
          voucherSaleId: id,
          isFree: i >= order.paid,
          createdAt: now,
          createdBy: c.var.user.id,
        }),
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
    return c.json({ id, total: order.total, serials: serials.map((serial, i) => ({ serial, isFree: i >= order.paid })) }, 201);
  })

  .get('/voucher-sales', zValidator('query', z.object({ day: isoDate }), invalidInput), async (c) => {
    const db = c.var.db;
    const { day } = c.req.valid('query');
    const rows = await db
      .select({ sale: voucherSales, serviceName: services.name })
      .from(voucherSales)
      .innerJoin(services, eq(services.id, voucherSales.serviceId))
      .where(eq(voucherSales.businessDay, day))
      .orderBy(desc(voucherSales.createdAt));
    const ids = rows.map((r) => r.sale.id);
    const [issued, pays] = ids.length
      ? await Promise.all([
          db.select().from(vouchers).where(inArray(vouchers.voucherSaleId, ids)),
          db.select().from(voucherPayments).where(inArray(voucherPayments.voucherSaleId, ids)),
        ])
      : [[], []];
    return c.json({
      voucherSales: rows.map((r) => ({
        ...r.sale,
        serviceName: r.serviceName,
        vouchers: issued.filter((v) => v.voucherSaleId === r.sale.id).map((v) => ({ serial: v.serial, isFree: v.isFree, status: v.status })),
        payments: pays.filter((p) => p.voucherSaleId === r.sale.id),
      })),
    });
  })

  /** A mistaken Voucher sale is cancelled while the day is open and none of its Vouchers is used. */
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
      db.update(vouchers).set({ status: 'voided' }).where(eq(vouchers.voucherSaleId, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher_sale.void', entity: 'voucher_sale', entityId: row.id, before: row, reason }),
    ]);
    return c.json({ ok: true });
  })

  .get(
    '/vouchers',
    zValidator('query', z.object({ q: z.string().trim().max(40).optional(), status: z.enum(VOUCHER_STATUSES).optional() }), invalidInput),
    async (c) => {
      const { q, status } = c.req.valid('query');
      const rows = await c.var.db
        .select({ voucher: vouchers, serviceName: services.name, buyerName: voucherSales.buyerName, soldOn: voucherSales.businessDay })
        .from(vouchers)
        .innerJoin(services, eq(services.id, vouchers.serviceId))
        .leftJoin(voucherSales, eq(voucherSales.id, vouchers.voucherSaleId))
        .where(and(q ? like(vouchers.serial, `%${normalizeSerial(q)}%`) : undefined, status ? eq(vouchers.status, status) : undefined))
        .orderBy(desc(vouchers.createdAt))
        .limit(200);
      return c.json({ vouchers: rows.map((r) => ({ ...r.voucher, serviceName: r.serviceName, buyerName: r.buyerName, soldOn: r.soldOn })) });
    },
  )

  .get('/vouchers/:serial', async (c) => {
    const row = await c.var.db
      .select({ voucher: vouchers, serviceName: services.name })
      .from(vouchers)
      .innerJoin(services, eq(services.id, vouchers.serviceId))
      .where(eq(vouchers.serial, normalizeSerial(c.req.param('serial'))))
      .get();
    if (!row) return fail(c, 404, 'not_found', 'No voucher has that serial number.');
    return c.json({ ...row.voucher, serviceName: row.serviceName });
  })

  /** Paper Vouchers sold before go-live, entered with their printed serials. Not counted as sales. */
  .post('/vouchers/import', requireCapability('vouchers.import'), zValidator('json', importBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const service = await db.select().from(services).where(eq(services.id, input.serviceId)).get();
    if (!service) return fail(c, 400, 'unknown_service', 'Pick a service.');
    const serials = [...new Set(input.serials.map(normalizeSerial))];
    const taken = await db.select({ serial: vouchers.serial }).from(vouchers).where(inArray(vouchers.serial, serials));
    if (taken.length) return fail(c, 409, 'duplicate_serial', `Already in the system: ${taken.map((t) => t.serial).join(', ')}`);
    const now = nowIso();
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'voucher.import', entity: 'service', entityId: service.id, after: { serials, isFree: input.isFree } }),
      ...serials.map((serial) =>
        db.insert(vouchers).values({
          id: crypto.randomUUID(),
          serial,
          serviceId: service.id,
          isFree: input.isFree,
          imported: true,
          createdAt: now,
          createdBy: c.var.user.id,
        }),
      ),
    ]);
    return c.json({ imported: serials.length }, 201);
  });
