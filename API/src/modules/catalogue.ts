import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, like } from 'drizzle-orm';
import { effectiveOn, type Centavos } from '@spa/domain';
import { addons, HOLIDAY_TYPES, holidays, promos, rooms, SERVICE_KINDS, servicePrices, services } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { basisPoints, centavos, hhmm, isoDate, name, notInPast, todayInManila } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

const manage = requireCapability('settings.manage');

const serviceFields = z.object({
  code: z.string().trim().min(1).max(12).toUpperCase(),
  name,
  durationMin: z.number().int().min(5).max(480),
  kind: z.enum(SERVICE_KINDS),
  isFootType: z.boolean(),
  voucherEligible: z.boolean(),
  /** Printed before each Voucher card's number, e.g. "NTL-SM"; empty for none. */
  voucherPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z0-9]+(-[A-Z0-9]+)*)?$/, 'Use letters and digits joined by dashes, e.g. NTL-SM.')
    .max(20)
    .transform((s) => s || null)
    .nullable(),
  active: z.boolean(),
  sortOrder: z.number().int(),
});

const newService = serviceFields
  .partial({ isFootType: true, voucherEligible: true, voucherPrefix: true, active: true, sortOrder: true })
  .extend({ regularPrice: centavos, effectiveFrom: isoDate });

const newPrice = z.object({ regularPrice: centavos, effectiveFrom: notInPast('Effective date') });

const promoFields = z
  .object({
    name,
    serviceId: z.string().min(1),
    percentBp: basisPoints.min(1),
    startTime: hhmm,
    endTime: hhmm,
    validFrom: isoDate,
    validTo: isoDate,
    active: z.boolean(),
  })
  .refine((p) => p.endTime > p.startTime, { message: 'End time must be after start time.', path: ['endTime'] })
  .refine((p) => p.validTo >= p.validFrom, { message: 'End date must be on or after start date.', path: ['validTo'] });

const addonFields = z.object({ name, price: centavos, active: z.boolean() });
const roomFields = z.object({ name, isFlex: z.boolean(), active: z.boolean() });
const holidayFields = z.object({ name, type: z.enum(HOLIDAY_TYPES), raisesCommission: z.boolean() });

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${String(err.cause ?? '')}`);
}

export const catalogueRoutes = new Hono<AuthedEnv>()
  .use(requireAuth)

  // ---- Services & Regular Prices ----
  .get('/services', async (c) => {
    const db = c.var.db;
    const [rows, prices] = await Promise.all([
      db.select().from(services).orderBy(asc(services.sortOrder), asc(services.code)),
      db.select().from(servicePrices).orderBy(asc(servicePrices.effectiveFrom)),
    ]);
    const today = todayInManila();
    return c.json({
      today,
      services: rows.map((s) => {
        const history = prices
          .filter((p) => p.serviceId === s.id)
          .map((p) => ({ ...p, regularPrice: p.regularPrice as Centavos }));
        const current = effectiveOn(history, today);
        return {
          ...s,
          currentPrice: current?.regularPrice ?? null,
          upcomingPrices: history.filter((p) => p.effectiveFrom > today),
          priceHistory: history,
        };
      }),
    });
  })
  .post('/services', manage, zValidator('json', newService, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
      await db.batch([
        db.insert(services).values({
          id,
          code: input.code,
          name: input.name,
          durationMin: input.durationMin,
          kind: input.kind,
          isFootType: input.isFootType ?? false,
          voucherEligible: input.voucherEligible ?? false,
          voucherPrefix: input.voucherPrefix ?? null,
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 1000,
          createdAt: now,
        }),
        db.insert(servicePrices).values({
          id: crypto.randomUUID(),
          serviceId: id,
          regularPrice: input.regularPrice,
          effectiveFrom: input.effectiveFrom,
          createdAt: now,
          createdBy: c.var.user.id,
        }),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'service.create', entity: 'service', entityId: id, after: input }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(c, 409, 'code_taken', 'Another service already uses that code or voucher code.');
      throw err;
    }
    return c.json({ id }, 201);
  })
  .patch('/services/:id', manage, zValidator('json', serviceFields.omit({ kind: true }).partial(), invalidInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const before = await db.select().from(services).where(eq(services.id, id)).get();
    if (!before) return fail(c, 404, 'not_found', 'Service not found.');
    const changes = c.req.valid('json');
    try {
      await db.batch([
        db.update(services).set(changes).where(eq(services.id, id)),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'service.update', entity: 'service', entityId: id, before, after: changes }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(c, 409, 'code_taken', 'Another service already uses that code or voucher code.');
      throw err;
    }
    return c.json({ ok: true });
  })
  .post('/services/:id/prices', manage, zValidator('json', newPrice, invalidInput), async (c) => {
    const db = c.var.db;
    const serviceId = c.req.param('id');
    const service = await db.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).get();
    if (!service) return fail(c, 404, 'not_found', 'Service not found.');
    const input = c.req.valid('json');
    const id = crypto.randomUUID();
    try {
      await db.batch([
        db.insert(servicePrices).values({ id, serviceId, ...input, createdAt: nowIso(), createdBy: c.var.user.id }),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'service.price_add', entity: 'service', entityId: serviceId, after: input }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(c, 409, 'date_taken', 'A price already starts on that date.');
      throw err;
    }
    return c.json({ id }, 201);
  })
  .delete('/services/:id/prices/:priceId', manage, async (c) => {
    const db = c.var.db;
    const { id: serviceId, priceId } = c.req.param();
    const price = await db
      .select()
      .from(servicePrices)
      .where(and(eq(servicePrices.id, priceId), eq(servicePrices.serviceId, serviceId)))
      .get();
    if (!price) return fail(c, 404, 'not_found', 'Price not found.');
    if (price.effectiveFrom <= todayInManila()) {
      return fail(c, 409, 'already_effective', 'Only upcoming prices can be removed.');
    }
    await db.batch([
      db.delete(servicePrices).where(eq(servicePrices.id, priceId)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'service.price_remove', entity: 'service', entityId: serviceId, before: price }),
    ]);
    return c.json({ ok: true });
  })

  // ---- Promos ----
  .get('/promos', async (c) => {
    const rows = await c.var.db.select().from(promos).orderBy(asc(promos.validFrom));
    return c.json({ promos: rows });
  })
  .post('/promos', manage, zValidator('json', promoFields, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const service = await db.select({ id: services.id }).from(services).where(eq(services.id, input.serviceId)).get();
    if (!service) return fail(c, 400, 'unknown_service', 'Pick an existing service.');
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(promos).values({ id, ...input, createdAt: nowIso() }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'promo.create', entity: 'promo', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })
  .put('/promos/:id', manage, zValidator('json', promoFields, invalidInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const before = await db.select().from(promos).where(eq(promos.id, id)).get();
    if (!before) return fail(c, 404, 'not_found', 'Promo not found.');
    const input = c.req.valid('json');
    await db.batch([
      db.update(promos).set(input).where(eq(promos.id, id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'promo.update', entity: 'promo', entityId: id, before, after: input }),
    ]);
    return c.json({ ok: true });
  })

  // ---- Add-ons ----
  .get('/addons', async (c) => {
    return c.json({ addons: await c.var.db.select().from(addons).orderBy(asc(addons.name)) });
  })
  .post('/addons', manage, zValidator('json', addonFields, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(addons).values({ id, ...input, createdAt: nowIso() }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'addon.create', entity: 'addon', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })
  .put('/addons/:id', manage, zValidator('json', addonFields, invalidInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const before = await db.select().from(addons).where(eq(addons.id, id)).get();
    if (!before) return fail(c, 404, 'not_found', 'Add-on not found.');
    const input = c.req.valid('json');
    await db.batch([
      db.update(addons).set(input).where(eq(addons.id, id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'addon.update', entity: 'addon', entityId: id, before, after: input }),
    ]);
    return c.json({ ok: true });
  })

  // ---- Rooms ----
  .get('/rooms', async (c) => {
    return c.json({ rooms: await c.var.db.select().from(rooms).orderBy(asc(rooms.id)) });
  })
  .put('/rooms/:id', manage, zValidator('json', roomFields, invalidInput), async (c) => {
    const db = c.var.db;
    const id = Number(c.req.param('id'));
    const before = await db.select().from(rooms).where(eq(rooms.id, id)).get();
    if (!before) return fail(c, 404, 'not_found', 'Room not found.');
    const input = c.req.valid('json');
    await db.batch([
      db.update(rooms).set(input).where(eq(rooms.id, id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'room.update', entity: 'room', entityId: String(id), before, after: input }),
    ]);
    return c.json({ ok: true });
  })

  // ---- Holidays ----
  .get('/holidays', zValidator('query', z.object({ year: z.string().regex(/^\d{4}$/).optional() }), invalidInput), async (c) => {
    const { year } = c.req.valid('query');
    const rows = await c.var.db
      .select()
      .from(holidays)
      .where(year ? like(holidays.date, `${year}-%`) : undefined)
      .orderBy(asc(holidays.date));
    return c.json({ holidays: rows });
  })
  .put('/holidays/:date', manage, zValidator('param', z.object({ date: isoDate }), invalidInput), zValidator('json', holidayFields, invalidInput), async (c) => {
    const db = c.var.db;
    const { date } = c.req.valid('param');
    const input = c.req.valid('json');
    const before = await db.select().from(holidays).where(eq(holidays.date, date)).get();
    await db.batch([
      db.insert(holidays).values({ date, ...input }).onConflictDoUpdate({ target: holidays.date, set: input }),
      auditInsert(db, { actorUserId: c.var.user.id, action: before ? 'holiday.update' : 'holiday.create', entity: 'holiday', entityId: date, before, after: input }),
    ]);
    return c.json({ ok: true });
  })
  .delete('/holidays/:date', manage, async (c) => {
    const db = c.var.db;
    const date = c.req.param('date');
    const before = await db.select().from(holidays).where(eq(holidays.date, date)).get();
    if (!before) return fail(c, 404, 'not_found', 'Holiday not found.');
    await db.batch([
      db.delete(holidays).where(eq(holidays.date, date)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'holiday.delete', entity: 'holiday', entityId: date, before }),
    ]);
    return c.json({ ok: true });
  });
