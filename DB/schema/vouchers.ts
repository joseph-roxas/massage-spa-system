import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { services } from './catalogue';
import { PAYMENT_METHODS, sales } from './sales';
import { users } from './users';

export const VOUCHER_STATUSES = ['unused', 'redeemed', 'voided'] as const;
export const VOUCHER_SALE_STATUSES = ['paid', 'voided'] as const;

/** One purchase of Vouchers for one Service; every five bought earn a free sixth. */
export const voucherSales = sqliteTable(
  'voucher_sales',
  {
    id: text('id').primaryKey(),
    businessDay: text('business_day').notNull(),
    status: text('status', { enum: VOUCHER_SALE_STATUSES }).notNull().default('paid'),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    buyerName: text('buyer_name'),
    buyerPhone: text('buyer_phone'),
    qtyPaid: integer('qty_paid').notNull(),
    qtyFree: integer('qty_free').notNull(),
    /** Centavos: the Regular Price on the day sold. */
    unitPrice: integer('unit_price').notNull(),
    /** Counts toward Royalty Gross Sales on the day sold. */
    total: integer('total').notNull(),
    voidReason: text('void_reason'),
    voidedBy: text('voided_by').references(() => users.id),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('voucher_sales_day_idx').on(t.businessDay, t.status)],
);

export const vouchers = sqliteTable(
  'vouchers',
  {
    id: text('id').primaryKey(),
    serial: text('serial').notNull().unique(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    /** Null for paper Vouchers imported at go-live. */
    voucherSaleId: text('voucher_sale_id').references(() => voucherSales.id),
    /** The free sixth of a Bundle: its Redemption is a Real FOC. */
    isFree: integer('is_free', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: VOUCHER_STATUSES }).notNull().default('unused'),
    redeemedSaleId: text('redeemed_sale_id').references(() => sales.id),
    redeemedAt: text('redeemed_at'),
    /** Sold on paper before the system; entered at go-live. */
    imported: integer('imported', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('vouchers_sale_idx').on(t.voucherSaleId), index('vouchers_status_idx').on(t.status)],
);

/** How a Voucher purchase was paid; counted in the drawer like Service payments. */
export const voucherPayments = sqliteTable(
  'voucher_payments',
  {
    id: text('id').primaryKey(),
    voucherSaleId: text('voucher_sale_id')
      .notNull()
      .references(() => voucherSales.id),
    businessDay: text('business_day').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    amount: integer('amount').notNull(),
    gcashRef: text('gcash_ref'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('voucher_payments_day_idx').on(t.businessDay)],
);
