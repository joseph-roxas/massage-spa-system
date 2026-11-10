import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  businessDayOf,
  can,
  isLowStock,
  matchOpeningRows,
  poCan,
  receiveProblem,
  receiveTurnoverProblem,
  statusAfterDelivery,
  stockLevels,
  takeOutProblem,
  turnoverProblem,
  type PoStatus,
} from '@spa/domain';
import {
  cashOuts,
  DISCARD_REASONS,
  ITEM_KINDS,
  items,
  PO_STATUSES,
  purchaseOrderLines,
  purchaseOrders,
  staff,
  STOCK_LOCATIONS,
  stockIns,
  stockOuts,
  TAKEOUT_LEVELS,
  takeoutRequests,
  turnovers,
  users,
  vendors,
} from '@spa/db';
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
  kind: z.enum(ITEM_KINDS).optional(),
  reorderLevel: z.number().int().min(0).max(100_000),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
const vendorFields = z.object({ name, contact: z.string().trim().max(200).optional(), active: z.boolean().optional() });
const reasonBody = z.object({ reason: z.string().trim().min(3, 'Give a short reason.').max(300) });

type Stock = { storage: number; inTransit: number; shop: number; lastStockOut: string | null };

const NO_STOCK: Stock = { storage: 0, inTransit: 0, shop: 0, lastStockOut: null };

/** Storage, in transit and Shop Stock per Item. */
async function stockMap(db: Db, itemIds?: string[]): Promise<Map<string, Stock>> {
  const where = (col: typeof stockIns.itemId | typeof stockOuts.itemId | typeof turnovers.itemId) => (itemIds ? inArray(col, itemIds) : undefined);
  const [ins, outs, sent] = await Promise.all([
    db
      .select({ itemId: stockIns.itemId, location: stockIns.location, qty: sql<number>`sum(${stockIns.qty})` })
      .from(stockIns)
      .where(where(stockIns.itemId))
      .groupBy(stockIns.itemId, stockIns.location),
    db
      .select({ itemId: stockOuts.itemId, location: stockOuts.location, qty: sql<number>`sum(${stockOuts.qty})`, last: sql<string>`max(${stockOuts.date})` })
      .from(stockOuts)
      .where(where(stockOuts.itemId))
      .groupBy(stockOuts.itemId, stockOuts.location),
    db
      .select({
        itemId: turnovers.itemId,
        inTransit: sql<number>`sum(case when ${turnovers.receivedAt} is null then ${turnovers.qty} else 0 end)`,
        received: sql<number>`sum(coalesce(${turnovers.receivedQty}, 0))`,
      })
      .from(turnovers)
      .where(where(turnovers.itemId))
      .groupBy(turnovers.itemId),
  ]);
  const ids = new Set([...ins.map((x) => x.itemId), ...outs.map((x) => x.itemId), ...sent.map((x) => x.itemId)]);
  const out = new Map<string, Stock>();
  for (const id of ids) {
    const qty = (rows: { itemId: string; location: string; qty: number }[], location: string) =>
      Number(rows.find((r) => r.itemId === id && r.location === location)?.qty ?? 0);
    const t = sent.find((s) => s.itemId === id);
    const levels = stockLevels({
      storageIns: qty(ins, 'storage'),
      shopIns: qty(ins, 'shop'),
      inTransit: Number(t?.inTransit ?? 0),
      received: Number(t?.received ?? 0),
      storageOuts: qty(outs, 'storage'),
      shopOuts: qty(outs, 'shop'),
    });
    out.set(id, { ...levels, lastStockOut: outs.find((o) => o.itemId === id && o.location === 'shop')?.last ?? null });
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
      stockMap(db),
      db
        .select({ itemId: stockIns.itemId, unitPrice: stockIns.unitPrice, purchaseDate: stockIns.purchaseDate, vendorName: vendors.name })
        .from(stockIns)
        .leftJoin(vendors, eq(vendors.id, stockIns.vendorId))
        .where(eq(stockIns.kind, 'purchase'))
        .orderBy(desc(stockIns.purchaseDate), desc(stockIns.createdAt)),
    ]);
    return c.json({
      items: rows.map((i) => {
        const s = stock.get(i.id) ?? NO_STOCK;
        const latest = purchases.find((p) => p.itemId === i.id) ?? null;
        // `onHand` is Shop Stock; the reorder level warns on what the shop has.
        return { ...i, ...s, onHand: s.shop, low: isLowStock(s.shop, i.reorderLevel), latestPurchase: latest };
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
    const [ins, outs, sent] = await Promise.all([
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
      db.select().from(turnovers).where(eq(turnovers.itemId, id)).orderBy(desc(turnovers.createdAt)).limit(200),
    ]);
    const moves = [
      ...ins.map((i) => ({
        type: i.row.kind === 'opening' ? ('opening' as const) : ('in' as const),
        location: i.row.location,
        id: i.row.id,
        date: i.row.purchaseDate,
        qty: i.row.qty,
        unitPrice: i.row.unitPrice,
        who: i.vendorName,
        note: null as string | null,
        createdAt: i.row.createdAt,
      })),
      ...outs.map((o) => ({
        type: o.row.kind,
        location: o.row.location,
        id: o.row.id,
        date: o.row.date,
        qty: o.row.qty,
        unitPrice: null,
        who: o.takenBy,
        note: [o.row.reason?.replace('_', ' '), o.row.note].filter(Boolean).join(': ') || null,
        createdAt: o.row.createdAt,
      })),
      ...sent.map((t) => ({
        type: 'turnover' as const,
        location: 'shop' as const,
        id: t.id,
        date: t.sentOn,
        qty: t.receivedQty ?? t.qty,
        unitPrice: null,
        who: null,
        note: !t.receivedAt
          ? 'Sent, not received yet'
          : t.receivedQty! < t.qty
            ? `${t.qty} sent, ${t.receivedQty} received${t.receiveNote ? `: ${t.receiveNote}` : ''}`
            : t.receiveNote,
        createdAt: t.createdAt,
      })),
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
    zValidator(
      'json',
      z
        .object({
          itemId: z.string().min(1),
          qty,
          kind: z.enum(['use', 'discard']).default('use'),
          reason: z.enum(DISCARD_REASONS).optional(),
          /** Storage: the Super Admin discarding from their own stock. */
          location: z.enum(STOCK_LOCATIONS).default('shop'),
          takenByStaffId: z.string().min(1).nullable().optional(),
          note: z.string().trim().max(200).optional(),
        })
        .refine((x) => x.kind === 'use' || x.reason, { message: 'Say why: broken, worn out or lost.', path: ['reason'] }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const input = c.req.valid('json');
      if (input.location === 'storage' && !can(c.var.user.role, 'inventory.po.approve')) return fail(c, 403, 'forbidden', 'Only the Super Admin manages Storage.');
      const item = await db.select().from(items).where(eq(items.id, input.itemId)).get();
      if (!item) return fail(c, 404, 'not_found', 'Item not found.');
      const stock = (await stockMap(db, [item.id])).get(item.id) ?? NO_STOCK;
      const available = input.location === 'shop' ? stock.shop : stock.storage;
      const problem =
        input.location === 'shop'
          ? takeOutProblem(input.kind, item.kind, input.qty, available)
          : input.kind === 'use'
            ? 'Items are used at the shop. Send them with a Turnover.'
            : input.qty > available
              ? `Only ${available} in storage.`
              : null;
      if (problem) return fail(c, 409, 'not_enough', `${item.name}: ${problem}`);
      const id = crypto.randomUUID();
      const row = {
        id,
        itemId: item.id,
        qty: input.qty,
        kind: input.kind,
        reason: input.kind === 'discard' ? input.reason! : null,
        location: input.location,
        date: businessDayOf(new Date()),
        takenByStaffId: input.takenByStaffId ?? null,
        note: input.note || null,
        createdAt: nowIso(),
        recordedBy: c.var.user.id,
      };
      await db.batch([db.insert(stockOuts).values(row), auditInsert(db, { actorUserId: c.var.user.id, action: `stock_out.${input.kind}`, entity: 'stock_out', entityId: id, after: row })]);
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

  /** A purchase bought without a Purchase Order, e.g. from the market. It lands in Storage. */
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

  /** Go-live: the counted quantity of each Item at the Shop or in Storage. Replaces that Item's earlier count there. */
  .put(
    '/inventory/opening',
    requireCapability('inventory.po.approve'),
    zValidator(
      'json',
      z.object({
        date: isoDate,
        location: z.enum(STOCK_LOCATIONS).default('shop'),
        counts: z.array(z.object({ itemId: z.string().min(1), qty: z.number().int().min(0).max(100_000) })).min(1).max(80),
      }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const { date, location, counts } = c.req.valid('json');
      const known = new Set((await db.select({ id: items.id }).from(items)).map((i) => i.id));
      if (counts.some((x) => !known.has(x.itemId))) return fail(c, 404, 'not_found', 'An item was not found.');
      const now = nowIso();
      await db.batch([
        auditInsert(db, { actorUserId: c.var.user.id, action: 'inventory.opening', entity: 'inventory', entityId: date, after: counts }),
        ...counts.flatMap((x) => [
          db.delete(stockIns).where(and(eq(stockIns.itemId, x.itemId), eq(stockIns.kind, 'opening'), eq(stockIns.location, location))),
          ...(x.qty > 0
            ? [db.insert(stockIns).values({ id: crypto.randomUUID(), itemId: x.itemId, kind: 'opening', location, qty: x.qty, purchaseDate: date, createdAt: now, receivedBy: c.var.user.id })]
            : []),
        ]),
      ]);
      return c.json({ ok: true });
    },
  )

  /**
   * The Opening Count from an uploaded file: lines matched to the catalog by name, new Items created,
   * all or nothing. Refused with every problem named if any line can't be placed.
   */
  .put(
    '/inventory/opening/import',
    requireCapability('inventory.po.approve'),
    zValidator(
      'json',
      z.object({
        date: isoDate,
        location: z.enum(STOCK_LOCATIONS),
        rows: z
          .array(
            z.object({
              line: z.number().int().min(1),
              name: z.string().trim().min(1).max(80),
              qty: z.number().int().min(0).max(100_000),
              unit: z.string().trim().min(1).max(30).optional(),
              kind: z.enum(ITEM_KINDS).optional(),
            }),
          )
          .min(1)
          .max(300),
      }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const { date, location, rows } = c.req.valid('json');
      const catalog = await db.select({ id: items.id, name: items.name, unit: items.unit }).from(items);
      const matches = matchOpeningRows(rows, catalog);
      const problems = matches.filter((m) => m.status === 'problem');
      if (problems.length) {
        const shown = problems.slice(0, 5).map((p) => `line ${p.line}: ${p.message}`);
        return fail(c, 400, 'bad_rows', `Nothing was saved. ${shown.join(' ')}${problems.length > 5 ? ` And ${problems.length - 5} more.` : ''}`);
      }
      const now = nowIso();
      const counts: { itemId: string; qty: number }[] = [];
      const created: { id: string; name: string; unit: string; kind: (typeof ITEM_KINDS)[number] }[] = [];
      for (const m of matches) {
        if (m.status === 'matched') counts.push({ itemId: m.itemId, qty: m.qty });
        else if (m.status === 'new') {
          const id = crypto.randomUUID();
          created.push({ id, name: m.name, unit: m.unit, kind: m.kind });
          counts.push({ itemId: id, qty: m.qty });
        }
      }
      await db.batch([
        auditInsert(db, { actorUserId: c.var.user.id, action: 'inventory.opening_import', entity: 'inventory', entityId: date, after: { location, counts, created } }),
        ...created.map((i) => db.insert(items).values({ ...i, reorderLevel: 0, createdAt: now })),
        ...counts.flatMap((x) => [
          db.delete(stockIns).where(and(eq(stockIns.itemId, x.itemId), eq(stockIns.kind, 'opening'), eq(stockIns.location, location))),
          ...(x.qty > 0
            ? [db.insert(stockIns).values({ id: crypto.randomUUID(), itemId: x.itemId, kind: 'opening', location, qty: x.qty, purchaseDate: date, createdAt: now, receivedBy: c.var.user.id })]
            : []),
        ]),
      ]);
      return c.json({ counted: counts.length, created: created.length });
    },
  )

  // ------------------------------------------------- Take-out Requests

  /** Open requests first, then the most recent resolved ones. */
  .get('/inventory/takeout-requests', async (c) => {
    const db = c.var.db;
    const rows = await db
      .select({ r: takeoutRequests, itemName: items.name, unit: items.unit, by: users.firstName })
      .from(takeoutRequests)
      .leftJoin(items, eq(items.id, takeoutRequests.itemId))
      .leftJoin(users, eq(users.id, takeoutRequests.createdBy))
      .orderBy(sql`${takeoutRequests.resolvedAt} is not null`, desc(takeoutRequests.createdAt))
      .limit(100);
    const ids = rows.map((x) => x.r.id);
    const sent = ids.length
      ? await db.select({ requestId: turnovers.takeoutRequestId, qty: turnovers.qty, receivedAt: turnovers.receivedAt }).from(turnovers).where(inArray(turnovers.takeoutRequestId, ids))
      : [];
    return c.json({
      requests: rows.map((x) => ({
        ...x.r,
        itemName: x.itemName ?? x.r.itemText,
        unit: x.unit,
        requestedByName: x.by,
        sent: sent.filter((t) => t.requestId === x.r.id).reduce((n, t) => n + t.qty, 0),
      })),
    });
  })

  /** The shop needs an Item: running low or out. The Super Admin sends it from Storage, buying first if needed. */
  .post(
    '/inventory/takeout-requests',
    zValidator(
      'json',
      z
        .object({
          itemId: z.string().min(1).optional(),
          itemText: z.string().trim().min(2).max(120).optional(),
          qty,
          level: z.enum(TAKEOUT_LEVELS),
          note: z.string().trim().max(300).optional(),
        })
        .refine((x) => !!x.itemId !== !!x.itemText, { message: 'Pick an item, or describe a new one.', path: ['itemId'] }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const input = c.req.valid('json');
      if (input.itemId && !(await db.select({ id: items.id }).from(items).where(eq(items.id, input.itemId)).get())) return fail(c, 404, 'not_found', 'Item not found.');
      const id = crypto.randomUUID();
      await db.insert(takeoutRequests).values({
        id,
        itemId: input.itemId ?? null,
        itemText: input.itemText ?? null,
        qty: input.qty,
        level: input.level,
        note: input.note || null,
        createdAt: nowIso(),
        createdBy: c.var.user.id,
      });
      return c.json({ id }, 201);
    },
  )

  .post('/inventory/takeout-requests/:id/dismiss', requireCapability('inventory.po.approve'), zValidator('json', reasonBody, invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(takeoutRequests).where(eq(takeoutRequests.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Request not found.');
    if (row.resolvedAt) return fail(c, 409, 'resolved', 'This request is already closed.');
    await db
      .update(takeoutRequests)
      .set({ resolvedAt: nowIso(), resolvedBy: c.var.user.id, dismissReason: c.req.valid('json').reason })
      .where(eq(takeoutRequests.id, row.id));
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- Turnovers

  /** Not yet received first (the shop's For Receiving list), then shortfalls to resolve, then the rest. */
  .get('/inventory/turnovers', async (c) => {
    const rows = await c.var.db
      .select({ t: turnovers, itemName: items.name, unit: items.unit })
      .from(turnovers)
      .innerJoin(items, eq(items.id, turnovers.itemId))
      .orderBy(sql`${turnovers.receivedAt} is not null`, desc(turnovers.createdAt))
      .limit(150);
    return c.json({
      turnovers: rows.map((r) => ({
        ...r.t,
        itemName: r.itemName,
        unit: r.unit,
        short: r.t.receivedQty !== null && r.t.receivedQty < r.t.qty ? r.t.qty - r.t.receivedQty : 0,
      })),
    });
  })

  /** The Super Admin sends items from Storage to the shop. */
  .post(
    '/inventory/turnovers',
    requireCapability('inventory.po.approve'),
    zValidator(
      'json',
      z.object({ itemId: z.string().min(1), qty, sentOn: isoDate, takeoutRequestId: z.string().min(1).optional(), note: z.string().trim().max(300).optional() }),
      invalidInput,
    ),
    async (c) => {
      const db = c.var.db;
      const input = c.req.valid('json');
      if (input.sentOn > businessDayOf(new Date())) return fail(c, 400, 'future_date', 'The date sent cannot be in the future.');
      const item = await db.select().from(items).where(eq(items.id, input.itemId)).get();
      if (!item) return fail(c, 404, 'not_found', 'Item not found.');
      if (input.takeoutRequestId) {
        const req = await db.select().from(takeoutRequests).where(eq(takeoutRequests.id, input.takeoutRequestId)).get();
        if (!req || req.resolvedAt) return fail(c, 409, 'request_closed', 'That request is already closed.');
      }
      const stock = (await stockMap(db, [item.id])).get(item.id) ?? NO_STOCK;
      const problem = turnoverProblem(input.qty, stock.storage);
      if (problem) return fail(c, 409, 'not_enough', `${item.name}: ${problem}`);
      const id = crypto.randomUUID();
      const row = { id, ...input, takeoutRequestId: input.takeoutRequestId ?? null, note: input.note || null, createdAt: nowIso(), createdBy: c.var.user.id };
      await db.batch([db.insert(turnovers).values(row), auditInsert(db, { actorUserId: c.var.user.id, action: 'turnover.create', entity: 'turnover', entityId: id, after: row })]);
      return c.json({ id }, 201);
    },
  )

  /** A Turnover sent by mistake is removed before the shop receives it. */
  .delete('/inventory/turnovers/:id', requireCapability('inventory.po.approve'), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(turnovers).where(eq(turnovers.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Turnover not found.');
    if (row.receivedAt) return fail(c, 409, 'already_received', 'The shop has already received this.');
    await db.batch([db.delete(turnovers).where(eq(turnovers.id, row.id)), auditInsert(db, { actorUserId: c.var.user.id, action: 'turnover.delete', entity: 'turnover', entityId: row.id, before: row })]);
    return c.json({ ok: true });
  })

  /** The shop confirms what arrived; Shop Stock goes up by that, and the request it answers is closed. */
  .post(
    '/inventory/turnovers/:id/receive',
    zValidator('json', z.object({ receivedQty: z.number().int().min(0).max(100_000), note: z.string().trim().max(300).optional() }), invalidInput),
    async (c) => {
      const db = c.var.db;
      const row = await db.select().from(turnovers).where(eq(turnovers.id, c.req.param('id'))).get();
      if (!row) return fail(c, 404, 'not_found', 'Turnover not found.');
      if (row.receivedAt) return fail(c, 409, 'already_received', 'This has already been received.');
      const input = c.req.valid('json');
      const problem = receiveTurnoverProblem(input.receivedQty, row.qty);
      if (problem) return fail(c, 400, 'too_many', problem);
      if (input.receivedQty < row.qty && !input.note) return fail(c, 400, 'note_required', 'Say what is missing or damaged.');
      const now = nowIso();
      await db.batch([
        db
          .update(turnovers)
          .set({ receivedQty: input.receivedQty, receivedAt: now, receivedBy: c.var.user.id, receiveNote: input.note || null })
          .where(and(eq(turnovers.id, row.id), isNull(turnovers.receivedAt))),
        ...(row.takeoutRequestId
          ? [db.update(takeoutRequests).set({ resolvedAt: now, resolvedBy: c.var.user.id }).where(and(eq(takeoutRequests.id, row.takeoutRequestId), isNull(takeoutRequests.resolvedAt)))]
          : []),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'turnover.receive', entity: 'turnover', entityId: row.id, after: input }),
      ]);
      return c.json({ ok: true });
    },
  )

  /** The Super Admin says where a shortfall went: still in Storage, or lost (discarded from Storage). */
  .post(
    '/inventory/turnovers/:id/resolve',
    requireCapability('inventory.po.approve'),
    zValidator('json', z.object({ outcome: z.enum(['in_storage', 'lost']) }), invalidInput),
    async (c) => {
      const db = c.var.db;
      const row = await db.select().from(turnovers).where(eq(turnovers.id, c.req.param('id'))).get();
      if (!row) return fail(c, 404, 'not_found', 'Turnover not found.');
      const short = row.receivedQty === null ? 0 : row.qty - row.receivedQty;
      if (!short || row.shortfallResolvedAt) return fail(c, 409, 'nothing_short', 'There is no open shortfall on this Turnover.');
      const { outcome } = c.req.valid('json');
      const now = nowIso();
      await db.batch([
        db.update(turnovers).set({ shortfallOutcome: outcome, shortfallResolvedAt: now }).where(eq(turnovers.id, row.id)),
        ...(outcome === 'lost'
          ? [
              db.insert(stockOuts).values({
                id: crypto.randomUUID(),
                itemId: row.itemId,
                qty: short,
                kind: 'discard',
                reason: 'lost',
                location: 'storage',
                date: businessDayOf(new Date()),
                note: `Short on the Turnover of ${row.sentOn}`,
                createdAt: now,
                recordedBy: c.var.user.id,
              }),
            ]
          : []),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'turnover.resolve', entity: 'turnover', entityId: row.id, after: { outcome, short } }),
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
