import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { cashOuts } from './days';
import { staff } from './staff';
import { users } from './users';

export const vendors = sqliteTable('vendors', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  contact: text('contact'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').references(() => users.id),
});

/** Consumable: used up in service. Reusable: used until it breaks or wears out. Equipment: large and durable. */
export const ITEM_KINDS = ['consumable', 'reusable', 'equipment'] as const;
/** Storage is the Super Admin's own stock; the Shop holds what has been turned over and received. */
export const STOCK_LOCATIONS = ['storage', 'shop'] as const;

/** Something the shop stocks. Quantities are whole units of `unit`. */
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** E.g. gal, liter, pack of 50, 500 g, roll. */
    unit: text('unit').notNull(),
    kind: text('kind', { enum: ITEM_KINDS }).notNull().default('consumable'),
    /** Low-stock warning (on Shop Stock) at or below this many units; 0 = never. */
    reorderLevel: integer('reorder_level').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('items_name_unit_idx').on(t.name, t.unit)],
);

export const PO_STATUSES = ['requested', 'approved', 'partially_received', 'received', 'cancelled'] as const;

export const purchaseOrders = sqliteTable(
  'purchase_orders',
  {
    id: text('id').primaryKey(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id),
    status: text('status', { enum: PO_STATUSES }).notNull().default('requested'),
    note: text('note'),
    requestedAt: text('requested_at').notNull(),
    requestedBy: text('requested_by').references(() => users.id),
    approvedAt: text('approved_at'),
    approvedBy: text('approved_by').references(() => users.id),
    cancelledAt: text('cancelled_at'),
    cancelledBy: text('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
  },
  (t) => [index('purchase_orders_status_idx').on(t.status)],
);

export const purchaseOrderLines = sqliteTable('purchase_order_lines', {
  id: text('id').primaryKey(),
  poId: text('po_id')
    .notNull()
    .references(() => purchaseOrders.id),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id),
  qty: integer('qty').notNull(),
  /** Centavos per unit, if known when ordering. */
  expectedPrice: integer('expected_price'),
});

export const STOCK_IN_KINDS = ['purchase', 'opening'] as const;

/** Quantity received. `opening` is the go-live count, with no vendor or price. Purchases land in Storage. */
export const stockIns = sqliteTable(
  'stock_ins',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    kind: text('kind', { enum: STOCK_IN_KINDS }).notNull().default('purchase'),
    location: text('location', { enum: STOCK_LOCATIONS }).notNull().default('storage'),
    vendorId: text('vendor_id').references(() => vendors.id),
    /** Set when received against a Purchase Order. */
    poLineId: text('po_line_id').references(() => purchaseOrderLines.id),
    qty: integer('qty').notNull(),
    /** Centavos per unit. */
    unitPrice: integer('unit_price'),
    purchaseDate: text('purchase_date').notNull(),
    /** The Cash-out when it was paid from the drawer; Expenses then count it once, as a purchase. */
    cashOutId: text('cash_out_id').references(() => cashOuts.id),
    createdAt: text('created_at').notNull(),
    receivedBy: text('received_by').references(() => users.id),
  },
  (t) => [index('stock_ins_item_idx').on(t.itemId, t.purchaseDate)],
);

/** Use: a Consumable taken for service. Discard: a Reusable Supply or Equipment gone for good. */
export const STOCK_OUT_KINDS = ['use', 'discard'] as const;
export const DISCARD_REASONS = ['broken', 'worn_out', 'lost'] as const;

/** Quantity leaving stock: Used at the shop, or Discarded (from the shop, or by the Super Admin from Storage). */
export const stockOuts = sqliteTable(
  'stock_outs',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    qty: integer('qty').notNull(),
    kind: text('kind', { enum: STOCK_OUT_KINDS }).notNull().default('use'),
    reason: text('reason', { enum: DISCARD_REASONS }),
    location: text('location', { enum: STOCK_LOCATIONS }).notNull().default('shop'),
    /** Business Day it was taken. */
    date: text('date').notNull(),
    takenByStaffId: text('taken_by_staff_id').references(() => staff.id),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    recordedBy: text('recorded_by').references(() => users.id),
  },
  (t) => [index('stock_outs_item_idx').on(t.itemId, t.date)],
);

export const TAKEOUT_LEVELS = ['low', 'out'] as const;

/** The Receptionist asking the Super Admin for an Item the shop needs; fulfilled by a Turnover. */
export const takeoutRequests = sqliteTable(
  'takeout_requests',
  {
    id: text('id').primaryKey(),
    /** Null for something not in the Item list yet, described in `itemText`. */
    itemId: text('item_id').references(() => items.id),
    itemText: text('item_text'),
    qty: integer('qty').notNull(),
    level: text('level', { enum: TAKEOUT_LEVELS }).notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
    /** Set when its Turnover is received, or when the Super Admin dismisses it. */
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by').references(() => users.id),
    dismissReason: text('dismiss_reason'),
  },
  (t) => [index('takeout_requests_open_idx').on(t.resolvedAt)],
);

export const SHORTFALL_OUTCOMES = ['in_storage', 'lost'] as const;

/** Items the Super Admin sends from Storage to the Shop; Shop Stock goes up only once Received. */
export const turnovers = sqliteTable(
  'turnovers',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    qty: integer('qty').notNull(),
    sentOn: text('sent_on').notNull(),
    takeoutRequestId: text('takeout_request_id').references(() => takeoutRequests.id),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
    receivedQty: integer('received_qty'),
    receivedAt: text('received_at'),
    receivedBy: text('received_by').references(() => users.id),
    receiveNote: text('receive_note'),
    /** A shortfall stays counted in Storage until the Super Admin says where it went. */
    shortfallOutcome: text('shortfall_outcome', { enum: SHORTFALL_OUTCOMES }),
    shortfallResolvedAt: text('shortfall_resolved_at'),
  },
  (t) => [index('turnovers_item_idx').on(t.itemId), index('turnovers_pending_idx').on(t.receivedAt)],
);
