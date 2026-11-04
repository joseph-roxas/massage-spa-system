import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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

/** A stocked consumable. Quantities are whole units of `unit`. */
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** E.g. gal, liter, pack of 50, 500 g, roll. */
    unit: text('unit').notNull(),
    /** Low-stock warning at or below this many units; 0 = never. */
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

/** Quantity received. `opening` is the go-live count, with no vendor or price. */
export const stockIns = sqliteTable(
  'stock_ins',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    kind: text('kind', { enum: STOCK_IN_KINDS }).notNull().default('purchase'),
    vendorId: text('vendor_id').references(() => vendors.id),
    /** Set when received against a Purchase Order. */
    poLineId: text('po_line_id').references(() => purchaseOrderLines.id),
    qty: integer('qty').notNull(),
    /** Centavos per unit. */
    unitPrice: integer('unit_price'),
    purchaseDate: text('purchase_date').notNull(),
    createdAt: text('created_at').notNull(),
    receivedBy: text('received_by').references(() => users.id),
  },
  (t) => [index('stock_ins_item_idx').on(t.itemId, t.purchaseDate)],
);

/** Quantity taken out of storage for use (or written off after a count). */
export const stockOuts = sqliteTable(
  'stock_outs',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    qty: integer('qty').notNull(),
    /** Business Day it was taken. */
    date: text('date').notNull(),
    takenByStaffId: text('taken_by_staff_id').references(() => staff.id),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    recordedBy: text('recorded_by').references(() => users.id),
  },
  (t) => [index('stock_outs_item_idx').on(t.itemId, t.date)],
);
