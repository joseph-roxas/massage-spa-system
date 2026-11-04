import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { businessDayOf, isLowStock, poCan, receiveProblem, statusAfterDelivery, stockOutProblem, type PoStatus } from '@spa/domain';
import { cashOuts, items, PO_STATUSES, purchaseOrderLines, purchaseOrders, staff, stockIns, stockOuts, users, vendors } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { centavos, isoDate, name } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

type Db = DrizzleD1Database;

const qty = z.number().int().min(1).max(100_000);
const itemFields = z.object({
  name,
  unit: z.string().trim().min(1).max(30),
  reorderLevel: z.number().int().min(0).max(100_000),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
const vendorFields = z.object({ name, contact: z.string().trim().max(200).optional(), active: z.boolean().optional() });
const reasonBody = z.object({ reason: z.string().trim().min(3, 'Give a short reason.').max(300) });

/** On hand per Item. */
async function onHandMap(db: Db, itemIds?: string[]) {
  const where = (col: typeof stockIns.itemId | typeof stockOuts.itemId) => (itemIds ? inArray(col, itemIds) : undefined);
  const [ins, outs] = await Promise.all([
    db.select({ itemId: stockIns.itemId, qty: sql<number>`sum(${stockIns.qty})` }).from(stockIns).where(where(stockIns.itemId)).groupBy(stockIns.itemId),
    db
      .select({ itemId: stockOuts.itemId, qty: sql<number>`sum(${stockOuts.qty})`, last: sql<string>`max(${stockOuts.date})` })
      .from(stockOuts)
      .where(where(stockOuts.itemId))
      .groupBy(stockOuts.itemId),
  ]);
  const out = new Map<string, { onHand: number; lastStockOut: string | null }>();
  for (const i of ins) out.set(i.itemId, { onHand: Number(i.qty), lastStockOut: null });
  for (const o of outs) {
    const cur = out.get(o.itemId) ?? { onHand: 0, lastStockOut: null };
    out.set(o.itemId, { onHand: cur.onHand - Number(o.qty), lastStockOut: o.last });
  }
  return out;
}

/** An order with its lines, how much of each has arrived, and who asked. */
async function ordersWithLines(db: Db, rows: (typeof purchaseOrders.$inferSelect)[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [lines, received, vendorRows, people] = await Promise.all([
    db
      .select({ line: purchaseOrderLines, itemName: items.name, unit: items.unit })
      .from(purchaseOrderLines)
      .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
      .where(inArray(purchaseOrderLines.poId, ids)),
    db
      .select({ poLineId: stockIns.poLineId, qty: sql<number>`sum(${stockIns.qty})` })
      .from(stockIns)
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, stockIns.poLineId))
      .where(inArray(purchaseOrderLines.poId, ids))
      .groupBy(stockIns.poLineId),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors),
    db.select({ id: users.id, firstName: users.firstName }).from(users),
  ]);
  const got = new Map(received.map((r) => [r.poLineId!, Number(r.qty)]));
  return rows.map((po) => ({
    ...po,
    vendorName: vendorRows.find((v) => v.id === po.vendorId)?.name ?? '',
    requestedByName: people.find((p) => p.id === po.requestedBy)?.firstName ?? null,
    lines: lines
      .filter((l) => l.line.poId === po.id)
      .map((l) => ({ ...l.line, itemName: l.itemName, unit: l.unit, received: got.get(l.line.id) ?? 0 })),
  }));
}

/** A supplies Cash-out on today's Business Day for a purchase paid from the drawer, or the refusal. */
async function drawerCashOut(c: Context<AuthedEnv>, amount: number, purpose: string) {
  const day = businessDayOf(new Date());
  const blocked = await openDayFor(c, day);
  if (blocked) return blocked;
  return { id: crypto.randomUUID(), businessDay: day, category: 'supplies' as const, amount, purpose, createdAt: nowIso(), createdBy: c.var.user.id };
}

export const inventoryRoutes = new Hono<AuthedEnv>()
  .use('/inventory/*', requireAuth, requireCapability('inventory.stock_out'))

  /** Every Item with on hand, low-stock flag, last stock-out and the latest purchase. */
  .get('/inventory/items', async (c) => {
    const db = c.var.db;
    const [rows, stock, purchases] = await Promise.all([
      db.select().from(items).orderBy(asc(items.sortOrder), asc(items.name)),
      onHandMap(db),
      db
        .select({ itemId: stockIns.itemId, unitPrice: stockIns.unitPrice, purchaseDate: stockIns.purchaseDate, vendorName: vendors.name })
        .from(stockIns)
        .leftJoin(vendors, eq(vendors.id, stockIns.vendorId))
        .where(eq(stockIns.kind, 'purchase'))
        .orderBy(desc(stockIns.purchaseDate), desc(stockIns.createdAt)),
    ]);
    return c.json({
      items: rows.map((i) => {
        const s = stock.get(i.id) ?? { onHand: 0, lastStockOut: null };
        const latest = purchases.find((p) => p.itemId === i.id) ?? null;
        return { ...i, ...s, low: isLowStock(s.onHand, i.reorderLevel), latestPurchase: latest };
      }),
    });
  })

  .post('/inventory/items', requireCapability('inventory.po.approve'), zValidator('json', itemFields, invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const dup = await db.select({ id: items.id }).from(items).where(and(eq(items.name, input.name), eq(items.unit, input.unit))).get();
    if (dup) return fail(c, 409, 'duplicate', 'That item and unit already exist.');
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(items).values({ id, ...input, createdAt: nowIso() }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'item.create', entity: 'item', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })

  .patch('/inventory/items/:id', requireCapability('inventory.po.approve'), zValidator('json', itemFields.partial(), invalidInput), async (c) => {
    const db = c.var.db;
    const before = await db.select().from(items).where(eq(items.id, c.req.param('id'))).get();
    if (!before) return fail(c, 404, 'not_found', 'Item not found.');
    const input = c.req.valid('json');
    await db.batch([
      db.update(items).set(input).where(eq(items.id, before.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'item.update', entity: 'item', entityId: before.id, before, after: input }),
    ]);
    return c.json({ ok: true });
  })

  /** Every Stock-in and Stock-out of one Item, newest first. */
  .get('/inventory/items/:id/history', async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const [ins, outs] = await Promise.all([
      db
        .select({ row: stockIns, vendorName: vendors.name })
        .from(stockIns)
        .leftJoin(vendors, eq(vendors.id, stockIns.vendorId))
        .where(eq(stockIns.itemId, id))
        .orderBy(desc(stockIns.purchaseDate), desc(stockIns.createdAt))
        .limit(200),
      db
        .select({ row: stockOuts, takenBy: staff.displayName })
        .from(stockOuts)
        .leftJoin(staff, eq(staff.id, stockOuts.takenByStaffId))
        .where(eq(stockOuts.itemId, id))
        .orderBy(desc(stockOuts.date), desc(stockOuts.createdAt))
        .limit(200),
    ]);
    const moves = [
      ...ins.map((i) => ({ type: i.row.kind === 'opening' ? ('opening' as const) : ('in' as const), id: i.row.id, date: i.row.purchaseDate, qty: i.row.qty, unitPrice: i.row.unitPrice, who: i.vendorName, note: null, createdAt: i.row.createdAt })),
      ...outs.map((o) => ({ type: 'out' as const, id: o.row.id, date: o.row.date, qty: o.row.qty, unitPrice: null, who: o.takenBy, note: o.row.note, createdAt: o.row.createdAt })),
    ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    return c.json({ moves });
  })

  // ------------------------------------------------------------------ Vendors

  .get('/inventory/vendors', async (c) => {
    return c.json({ vendors: await c.var.db.select().from(vendors).orderBy(asc(vendors.name)) });
  })

  .post('/inventory/vendors', requireCapability('inventory.po.request'), zValidator('json', vendorFields, invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const dup = await db.select({ id: vendors.id }).from(vendors).where(sql`lower(${vendors.name}) = lower(${input.name})`).get();
    if (dup) return fail(c, 409, 'duplicate', 'That vendor already exists.');
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(vendors).values({ id, name: input.name, contact: input.contact || null, createdAt: nowIso(), createdBy: c.var.user.id }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'vendor.create', entity: 'vendor', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })

  .patch('/inventory/vendors/:id', requireCapability('inventory.po.approve'), zValidator('json', vendorFields.partial(), invalidInput), async (c) => {
    const db = c.var.db;
    const before = await db.select().from(vendors).where(eq(vendors.id, c.req.param('id'))).get();
    if (!before) return fail(c, 404, 'not_found', 'Vendor not found.');
    const input = c.req.valid('json');
    await db.batch([
      db.update(vendors).set(input).where(eq(vendors.id, before.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'vendor.update', entity: 'vendor', entityId: before.id, before, after: input }),
    ]);
    return c.json({ ok: true });
  })

  // ----------------------------------------------------------- Stock in / out

  .post(
    '/inventory/stock-outs',
    zValidator('json', z.object({ itemId: z.string().min(1), qty, takenByStaffId: z.string().min(1).nullable().optional(), note: z.string().trim().max(200).optional() }), invalidInput),
    async (c) => {
      const db = c.var.db;
      const input = c.req.valid('json');
      const item = await db.select().from(items).where(eq(items.id, input.itemId)).get();
      if (!item) return fail(c, 404, 'not_found', 'Item not found.');
      const available = (await onHandMap(db, [item.id])).get(item.id)?.onHand ?? 0;
      const problem = stockOutProblem(input.qty, available);
      if (problem) return fail(c, 409, 'not_enough', `${item.name}: ${problem}`);
      const id = crypto.randomUUID();
      const row = { id, itemId: item.id, qty: input.qty, date: businessDayOf(new Date()), takenByStaffId: input.takenByStaffId ?? null, note: input.note || null, createdAt: nowIso(), recordedBy: c.var.user.id };
      await db.batch([db.insert(stockOuts).values(row), auditInsert(db, { actorUserId: c.var.user.id, action: 'stock_out.create', entity: 'stock_out', entityId: id, after: row })]);
      return c.json({ id, onHand: available - input.qty }, 201);
    },
  )

  /** A mistaken Stock-out can be removed on the day it was taken. */
  .delete('/inventory/stock-outs/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(stockOuts).where(eq(stockOuts.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Stock-out not found.');
    if (row.date !== businessDayOf(new Date()) && c.var.user.role !== 'super_admin') {
      return fail(c, 409, 'past_day', 'Only today’s Stock-outs can be removed. Ask the Super Admin.');
    }
    await db.batch([db.delete(stockOuts).where(eq(stockOuts.id, row.id)), auditInsert(db, { actorUserId: c.var.user.id, action: 'stock_out.delete', entity: 'stock_out', entityId: row.id, before: row })]);
    return c.json({ ok: true });
  })

  /** A purchase bought without a Purchase Order, e.g. from the market. */
  .post(
    '/inventory/stock-ins',
    requireCapability('inventory.receive'),
    zValidator(
      'json',
      z.object({ itemId: z.string().min(1), vendorId: z.string().min(1), qty, unitPrice: centavos, purchaseDate: isoDate, fromDrawer: z.boolean().default(false) }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const input = c.req.valid('json');
      if (input.purchaseDate > businessDayOf(new Date())) return fail(c, 400, 'future_date', 'The purchase date cannot be in the future.');
      const [item, vendor] = await Promise.all([
        db.select({ id: items.id, name: items.name }).from(items).where(eq(items.id, input.itemId)).get(),
        db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.vendorId)).get(),
      ]);
      if (!item || !vendor) return fail(c, 404, 'not_found', 'Item or vendor not found.');
      const drawer = input.fromDrawer ? await drawerCashOut(c, input.qty * input.unitPrice, `Inventory: ${item.name}`) : null;
      if (drawer instanceof Response) return drawer;
      const id = crypto.randomUUID();
      const { fromDrawer: _, ...fields } = input;
      const row = { id, ...fields, kind: 'purchase' as const, cashOutId: drawer?.id ?? null, createdAt: nowIso(), receivedBy: c.var.user.id };
      await db.batch([
        auditInsert(db, { actorUserId: c.var.user.id, action: 'stock_in.create', entity: 'stock_in', entityId: id, after: row }),
        ...(drawer ? [db.insert(cashOuts).values(drawer)] : []),
        db.insert(stockIns).values(row),
      ]);
      return c.json({ id }, 201);
    },
  )

  /** Go-live: the counted quantity of each Item. Replaces that Item's earlier opening count. */
  .put(
    '/inventory/opening',
    requireCapability('inventory.po.approve'),
    zValidator('json', z.object({ date: isoDate, counts: z.array(z.object({ itemId: z.string().min(1), qty: z.number().int().min(0).max(100_000) })).min(1).max(80) }), invalidInput),
    async (c) => {
      const db = c.var.db;
      const { date, counts } = c.req.valid('json');
      const known = new Set((await db.select({ id: items.id }).from(items)).map((i) => i.id));
      if (counts.some((x) => !known.has(x.itemId))) return fail(c, 404, 'not_found', 'An item was not found.');
      const now = nowIso();
      await db.batch([
        auditInsert(db, { actorUserId: c.var.user.id, action: 'inventory.opening', entity: 'inventory', entityId: date, after: counts }),
        ...counts.flatMap((x) => [
          db.delete(stockIns).where(and(eq(stockIns.itemId, x.itemId), eq(stockIns.kind, 'opening'))),
          ...(x.qty > 0 ? [db.insert(stockIns).values({ id: crypto.randomUUID(), itemId: x.itemId, kind: 'opening', qty: x.qty, purchaseDate: date, createdAt: now, receivedBy: c.var.user.id })] : []),
        ]),
      ]);
      return c.json({ ok: true });
    },
  )

  // ---------------------------------------------------------- Purchase Orders

  .get('/inventory/purchase-orders', zValidator('query', z.object({ status: z.enum(PO_STATUSES).optional() }), invalidInput), async (c) => {
    const db = c.var.db;
    const { status } = c.req.valid('query');
    const rows = await db
      .select()
      .from(purchaseOrders)
      .where(status ? eq(purchaseOrders.status, status) : undefined)
      .orderBy(desc(purchaseOrders.requestedAt))
      .limit(100);
    return c.json({ purchaseOrders: await ordersWithLines(db, rows) });
  })

  .post(
    '/inventory/purchase-orders',
    requireCapability('inventory.po.request'),
    zValidator(
      'json',
      z.object({
        vendorId: z.string().min(1),
        note: z.string().trim().max(300).optional(),
        lines: z.array(z.object({ itemId: z.string().min(1), qty, expectedPrice: centavos.nullable().optional() })).min(1).max(40),
      }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const input = c.req.valid('json');
      const vendor = await db.select().from(vendors).where(eq(vendors.id, input.vendorId)).get();
      if (!vendor?.active) return fail(c, 404, 'not_found', 'Vendor not found.');
      const ids = [...new Set(input.lines.map((l) => l.itemId))];
      if (ids.length !== input.lines.length) return fail(c, 400, 'duplicate_item', 'Each item goes on one line only.');
      const found = await db.select({ id: items.id }).from(items).where(inArray(items.id, ids));
      if (found.length !== ids.length) return fail(c, 404, 'not_found', 'An item was not found.');
      const id = crypto.randomUUID();
      const now = nowIso();
      await db.batch([
        db.insert(purchaseOrders).values({ id, vendorId: vendor.id, note: input.note || null, requestedAt: now, requestedBy: c.var.user.id }),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'po.request', entity: 'purchase_order', entityId: id, after: input }),
        ...input.lines.map((l) => db.insert(purchaseOrderLines).values({ id: crypto.randomUUID(), poId: id, itemId: l.itemId, qty: l.qty, expectedPrice: l.expectedPrice ?? null })),
      ]);
      return c.json({ id }, 201);
    },
  )

  .post('/inventory/purchase-orders/:id/approve', requireCapability('inventory.po.approve'), async (c) => {
    const db = c.var.db;
    const po = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, c.req.param('id'))).get();
    if (!po) return fail(c, 404, 'not_found', 'Order not found.');
    if (!poCan(po.status as PoStatus, 'approve')) return fail(c, 409, 'bad_status', 'Only a requested order can be approved.');
    const set = { status: 'approved' as const, approvedAt: nowIso(), approvedBy: c.var.user.id };
    await db.batch([
      db.update(purchaseOrders).set(set).where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, 'requested'))),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'po.approve', entity: 'purchase_order', entityId: po.id }),
    ]);
    return c.json({ ok: true });
  })

  /** Withdraws a request, rejects it, or stops waiting for the rest of a delivery. */
  .post('/inventory/purchase-orders/:id/cancel', zValidator('json', reasonBody, invalidInput), async (c) => {
    const db = c.var.db;
    const po = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, c.req.param('id'))).get();
    if (!po) return fail(c, 404, 'not_found', 'Order not found.');
    const mine = po.requestedBy === c.var.user.id && po.status === 'requested';
    if (!mine && c.var.user.role !== 'super_admin') return fail(c, 403, 'forbidden', 'Only the Super Admin can cancel this order.');
    if (!poCan(po.status as PoStatus, 'cancel')) return fail(c, 409, 'bad_status', 'This order can no longer be cancelled.');
    const { reason } = c.req.valid('json');
    await db.batch([
      db.update(purchaseOrders).set({ status: 'cancelled', cancelledAt: nowIso(), cancelledBy: c.var.user.id, cancelReason: reason }).where(eq(purchaseOrders.id, po.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'po.cancel', entity: 'purchase_order', entityId: po.id, reason }),
    ]);
    return c.json({ ok: true });
  })

  /** A delivery against an approved order: each line received becomes a Stock-in at the price paid. */
  .post(
    '/inventory/purchase-orders/:id/receive',
    requireCapability('inventory.receive'),
    zValidator(
      'json',
      z.object({
        purchaseDate: isoDate,
        lines: z.array(z.object({ lineId: z.string().min(1), qty: z.number().int().min(0).max(100_000), unitPrice: centavos })).min(1).max(40),
        fromDrawer: z.boolean().default(false),
      }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const input = c.req.valid('json');
      const po = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, c.req.param('id'))).get();
      if (!po) return fail(c, 404, 'not_found', 'Order not found.');
      if (!poCan(po.status as PoStatus, 'receive')) {
        return fail(c, 409, 'bad_status', po.status === 'requested' ? 'The Super Admin must approve this order first.' : 'This order is closed.');
      }
      if (input.purchaseDate > businessDayOf(new Date())) return fail(c, 400, 'future_date', 'The delivery date cannot be in the future.');
      const [order] = await ordersWithLines(db, [po]);
      const lines = order!.lines.map((l) => ({ id: l.id, qty: l.qty, received: l.received }));
      const delivery = input.lines.filter((l) => l.qty > 0);
      const problem = receiveProblem(lines, input.lines);
      if (problem) return fail(c, 400, 'bad_delivery', problem);

      const after = lines.map((l) => ({ ...l, received: l.received + (delivery.find((d) => d.lineId === l.id)?.qty ?? 0) }));
      const status = statusAfterDelivery(after);
      const total = delivery.reduce((sum, d) => sum + d.qty * d.unitPrice, 0);
      const drawer = input.fromDrawer && total > 0 ? await drawerCashOut(c, total, `Inventory delivery: ${order!.vendorName}`) : null;
      if (drawer instanceof Response) return drawer;
      const now = nowIso();
      await db.batch([
        db.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, po.id)),
        ...(drawer ? [db.insert(cashOuts).values(drawer)] : []),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'po.receive', entity: 'purchase_order', entityId: po.id, after: input }),
        ...delivery.map((d) =>
          db.insert(stockIns).values({
            id: crypto.randomUUID(),
            itemId: order!.lines.find((l) => l.id === d.lineId)!.itemId,
            kind: 'purchase',
            vendorId: po.vendorId,
            poLineId: d.lineId,
            qty: d.qty,
            unitPrice: d.unitPrice,
            purchaseDate: input.purchaseDate,
            cashOutId: drawer?.id ?? null,
            createdAt: now,
            receivedBy: c.var.user.id,
          }),
        ),
      ]);
      return c.json({ ok: true, status });
    },
  );
