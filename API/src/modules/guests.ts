import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, like, or } from 'drizzle-orm';
import { maskId } from '@spa/domain';
import { bookings, guests, sales, services, staff, STATUTORY_TYPES, voucherSales } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { regularRule, visitStatsFor, type GuestRow } from '../lib/guests';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { requireAuth, requireCapability } from '../auth/middleware';

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional();

const guestFields = z.object({
  name: z.string().trim().min(2, 'Enter the guest’s name.').max(80),
  phone: optText(30),
  statutoryType: z.enum(STATUTORY_TYPES).nullable().optional(),
  statutoryIdNo: optText(40),
});

/** A saved ID needs its kind, and the kind needs an ID. */
function idProblem(g: { statutoryType?: string | null; statutoryIdNo?: string | null }): string | null {
  return !!g.statutoryType !== !!g.statutoryIdNo ? 'Give both the ID kind (Senior Citizen or PWD) and its number, or neither.' : null;
}

/** What lists show: the saved ID masked. */
const listed = (g: GuestRow) => ({ id: g.id, name: g.name, phone: g.phone, statutoryType: g.statutoryType, statutoryIdMasked: maskId(g.statutoryIdNo) });

// Mounted at the API root, so the guards are scoped to these paths.
const guard = [requireAuth, requireCapability('bookings.manage')] as const;

export const guestRoutes = new Hono<AuthedEnv>()
  .use('/guests', ...guard)
  .use('/guests/*', ...guard)

  /** Guest Records, matching `q` by name or phone, most recent Visit first. */
  .get('/guests', zValidator('query', z.object({ q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), invalidInput), async (c) => {
    const { q, limit } = c.req.valid('query');
    const db = c.var.db;
    const rows = await db
      .select()
      .from(guests)
      .where(and(isNull(guests.mergedInto), q ? or(like(guests.name, `%${q}%`), like(guests.phone, `%${q}%`)) : undefined))
      .orderBy(asc(guests.name))
      .limit(limit);
    const [stats, rule] = await Promise.all([visitStatsFor(db, rows.map((r) => r.id)), regularRule(db)]);
    const list = rows.map((g) => ({ ...listed(g), ...stats.get(g.id)! }));
    list.sort((a, b) => (b.lastVisit ?? '').localeCompare(a.lastVisit ?? '') || a.name.localeCompare(b.name));
    return c.json({ guests: list, rule });
  })

  /** One Guest: the full saved ID (for checkout and editing), Visits and Vouchers bought. */
  .get('/guests/:id', async (c) => {
    const db = c.var.db;
    const g = await db.select().from(guests).where(eq(guests.id, c.req.param('id'))).get();
    if (!g) return fail(c, 404, 'not_found', 'Guest not found.');
    const [stats, visits, bought] = await Promise.all([
      visitStatsFor(db, [g.id]),
      db
        .select({ day: bookings.businessDay, serviceName: services.name, therapistName: staff.displayName, amountDue: sales.amountDue, discountType: sales.discountType })
        .from(bookings)
        .innerJoin(sales, and(eq(sales.bookingId, bookings.id), eq(sales.status, 'paid')))
        .innerJoin(services, eq(services.id, bookings.serviceId))
        .innerJoin(staff, eq(staff.id, sales.therapistId))
        .where(eq(bookings.guestId, g.id))
        .orderBy(desc(bookings.businessDay), desc(sales.createdAt)),
      db
        .select({ id: voucherSales.id, day: voucherSales.businessDay, serviceName: services.name, qtyPaid: voucherSales.qtyPaid, qtyFree: voucherSales.qtyFree, total: voucherSales.total, status: voucherSales.status })
        .from(voucherSales)
        .innerJoin(services, eq(services.id, voucherSales.serviceId))
        .where(eq(voucherSales.guestId, g.id))
        .orderBy(desc(voucherSales.businessDay)),
    ]);
    return c.json({ guest: { ...listed(g), statutoryIdNo: g.statutoryIdNo, mergedInto: g.mergedInto, ...stats.get(g.id)! }, visits, vouchers: bought });
  })

  .post('/guests', zValidator('json', guestFields, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const problem = idProblem(input);
    if (problem) return fail(c, 400, 'invalid_guest', problem);
    const id = crypto.randomUUID();
    const row = { id, name: input.name, phone: input.phone ?? null, statutoryType: input.statutoryType ?? null, statutoryIdNo: input.statutoryIdNo ?? null, createdAt: nowIso(), createdBy: c.var.user.id };
    await c.var.db.batch([c.var.db.insert(guests).values(row), auditInsert(c.var.db, { actorUserId: c.var.user.id, action: 'guest.create', entity: 'guest', entityId: id, after: row })]);
    return c.json({ id }, 201);
  })

  .patch('/guests/:id', zValidator('json', guestFields.partial(), invalidInput), async (c) => {
    const db = c.var.db;
    const before = await db.select().from(guests).where(eq(guests.id, c.req.param('id'))).get();
    if (!before || before.mergedInto) return fail(c, 404, 'not_found', 'Guest not found.');
    const changes = c.req.valid('json');
    const problem = idProblem({ ...before, ...changes });
    if (problem) return fail(c, 400, 'invalid_guest', problem);
    await db.batch([
      db.update(guests).set(changes).where(eq(guests.id, before.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'guest.update', entity: 'guest', entityId: before.id, before, after: changes }),
    ]);
    return c.json({ ok: true });
  })

  /** The Super Admin folds a duplicate into the record to keep: its Bookings and Voucher sales move over. */
  .post('/guests/:id/merge', requireCapability('settings.manage'), zValidator('json', z.object({ intoId: z.string().min(1) }), invalidInput), async (c) => {
    const db = c.var.db;
    const { intoId } = c.req.valid('json');
    const id = c.req.param('id');
    if (id === intoId) return fail(c, 400, 'same_guest', 'Pick a different record to keep.');
    const [dup, keep] = await Promise.all([db.select().from(guests).where(eq(guests.id, id)).get(), db.select().from(guests).where(eq(guests.id, intoId)).get()]);
    if (!dup || dup.mergedInto || !keep || keep.mergedInto) return fail(c, 404, 'not_found', 'Guest not found.');
    await db.batch([
      db.update(bookings).set({ guestId: keep.id }).where(eq(bookings.guestId, dup.id)),
      db.update(voucherSales).set({ guestId: keep.id }).where(eq(voucherSales.guestId, dup.id)),
      // Keep whatever the kept record lacks.
      db
        .update(guests)
        .set({
          phone: keep.phone ?? dup.phone,
          statutoryType: keep.statutoryIdNo ? keep.statutoryType : dup.statutoryType,
          statutoryIdNo: keep.statutoryIdNo ?? dup.statutoryIdNo,
        })
        .where(eq(guests.id, keep.id)),
      db.update(guests).set({ mergedInto: keep.id }).where(eq(guests.id, dup.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'guest.merge', entity: 'guest', entityId: keep.id, before: dup, after: { mergedInto: keep.id } }),
    ]);
    return c.json({ ok: true });
  });
