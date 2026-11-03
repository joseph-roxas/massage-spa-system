import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bookings } from './bookings';
import { addons, services } from './catalogue';
import { staff } from './staff';
import { users } from './users';

export const DISCOUNT_TYPES = ['none', 'senior', 'pwd', 'promo', 'voucher', 'complimentary'] as const;
export const FOC_KINDS = ['none', 'prepaid', 'real'] as const;
export const SALE_STATUSES = ['paid', 'voided'] as const;
export const PAYMENT_METHODS = ['cash', 'gcash'] as const;

/** Checkout of one Booking. Prices, Discount and Commission are snapshots taken at checkout. */
export const sales = sqliteTable(
  'sales',
  {
    id: text('id').primaryKey(),
    bookingId: text('booking_id')
      .notNull()
      .references(() => bookings.id),
    businessDay: text('business_day').notNull(),
    status: text('status', { enum: SALE_STATUSES }).notNull().default('paid'),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    therapistId: text('therapist_id')
      .notNull()
      .references(() => staff.id),
    /** Centavos, before any Discount. */
    regularPrice: integer('regular_price').notNull(),
    discountType: text('discount_type', { enum: DISCOUNT_TYPES }).notNull(),
    /** Senior/PWD ID number, the Promo id, or the Voucher serial. */
    discountRef: text('discount_ref'),
    discountBp: integer('discount_bp').notNull().default(0),
    discountAmount: integer('discount_amount').notNull().default(0),
    /** Paid for the Service after the Discount; Royalty Gross Sales counts this, not Add-ons. */
    serviceAmount: integer('service_amount').notNull(),
    addonsTotal: integer('addons_total').notNull().default(0),
    amountDue: integer('amount_due').notNull(),
    focKind: text('foc_kind', { enum: FOC_KINDS }).notNull().default('none'),
    commissionBp: integer('commission_bp').notNull(),
    commissionAmount: integer('commission_amount').notNull(),
    isHoliday: integer('is_holiday', { mode: 'boolean' }).notNull().default(false),
    /** Number from the paper receipt booklet. */
    bookletInvoiceNo: text('booklet_invoice_no'),
    /** Why the Super Admin gave a Complimentary Service. */
    reason: text('reason'),
    voidReason: text('void_reason'),
    voidedBy: text('voided_by').references(() => users.id),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [
    index('sales_day_idx').on(t.businessDay, t.status),
    index('sales_therapist_idx').on(t.therapistId, t.businessDay),
    // A Booking is checked out once; a voided sale can be redone.
    uniqueIndex('sales_one_per_booking').on(t.bookingId).where(sql`status = 'paid'`),
    // A Voucher pays for one Service only.
    uniqueIndex('sales_one_per_voucher').on(t.discountRef).where(sql`discount_type = 'voucher' AND status = 'paid'`),
  ],
);

export const saleAddons = sqliteTable('sale_addons', {
  id: text('id').primaryKey(),
  saleId: text('sale_id')
    .notNull()
    .references(() => sales.id),
  addonId: text('addon_id')
    .notNull()
    .references(() => addons.id),
  name: text('name').notNull(),
  price: integer('price').notNull(),
});

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id),
    businessDay: text('business_day').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    amount: integer('amount').notNull(),
    gcashRef: text('gcash_ref'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('payments_day_idx').on(t.businessDay), index('payments_sale_idx').on(t.saleId)],
);
