import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { services } from './catalogue';
import { guests } from './guests';
import { PAYMENT_METHODS, sales } from './sales';
import { users } from './users';

/**
 * `in_shop`: a printed card at the shop, not sold yet. `unused`: sold, not yet redeemed.
 * `used_before_golive`: sold and used on paper; no Sale, Commission or FOC behind it.
 */
export const VOUCHER_STATUSES = ['in_shop', 'unused', 'redeemed', 'used_before_golive', 'voided'] as const;
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
    /** The buyer's Guest Record; name and phone are copied as at the sale. */
    guestId: text('guest_id').references(() => guests.id),
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

/** A printed range of Voucher cards the Super Admin hands to the shop; its cards exist once the shop receives them. */
export const voucherEndorsements = sqliteTable(
  'voucher_endorsements',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    fromNo: integer('from_no').notNull(),
    toNo: integer('to_no').notNull(),
    endorsedOn: text('endorsed_on').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
    receivedAt: text('received_at'),
    receivedBy: text('received_by').references(() => users.id),
    receiveNote: text('receive_note'),
  },
  (t) => [index('voucher_endorsements_service_idx').on(t.serviceId)],
);

export const vouchers = sqliteTable(
  'vouchers',
  {
    id: text('id').primaryKey(),
    serial: text('serial').notNull().unique(),
    /** The printed card number, e.g. 271 of NTL-SM-0271. Null for serials from before cards were numbered. */
    cardNo: integer('card_no'),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    /** Null for paper Vouchers imported at go-live and cards not sold yet. */
    voucherSaleId: text('voucher_sale_id').references(() => voucherSales.id),
    endorsementId: text('endorsement_id').references(() => voucherEndorsements.id),
    /** Imported paper Vouchers only: free (5+1), so its Redemption is a Real FOC. Sold Bundles work it out at Redemption. */
    isFree: integer('is_free', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: VOUCHER_STATUSES }).notNull().default('unused'),
    redeemedSaleId: text('redeemed_sale_id').references(() => sales.id),
    redeemedAt: text('redeemed_at'),
    /** Sold on paper before the system; entered at go-live. */
    imported: integer('imported', { mode: 'boolean' }).notNull().default(false),
    /** Imported only: who bought it and when, if known. */
    importedBuyer: text('imported_buyer'),
    importedSoldOn: text('imported_sold_on'),
    /** Used Before Go-live only: when it was used and any note, if known. */
    usedBeforeOn: text('used_before_on'),
    usedBeforeNote: text('used_before_note'),
    voidReason: text('void_reason'),
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
