import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const SERVICE_KINDS = ['single', 'combo'] as const;

export const services = sqliteTable('services', {
  id: text('id').primaryKey(),
  /** Short label shown on screens and receipts, e.g. "C3". */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  durationMin: integer('duration_min').notNull(),
  kind: text('kind', { enum: SERVICE_KINDS }).notNull(),
  /** May be done on the Flex Room recliner. */
  isFootType: integer('is_foot_type', { mode: 'boolean' }).notNull().default(false),
  voucherEligible: integer('voucher_eligible', { mode: 'boolean' }).notNull().default(false),
  /** Branch and Service code printed before a Voucher card's number, e.g. "NTL-SM". */
  voucherPrefix: text('voucher_prefix').unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

/** Regular Price history; the one in force is the latest effective_from on or before the day. */
export const servicePrices = sqliteTable(
  'service_prices',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    /** Centavos. */
    regularPrice: integer('regular_price').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by'),
  },
  (t) => [uniqueIndex('service_prices_service_from_idx').on(t.serviceId, t.effectiveFrom)],
);

export const promos = sqliteTable(
  'promos',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    /** Basis points: 1000 = 10%. */
    percentBp: integer('percent_bp').notNull(),
    /** Service start time window, Manila: start inclusive, end exclusive. */
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    /** Inclusive dates. */
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('promos_service_idx').on(t.serviceId)],
);

export const addons = sqliteTable('addons', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Centavos. */
  price: integer('price').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const rooms = sqliteTable('rooms', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  /** The Flex Room is set up per Booking as a floor bed or a foot recliner. */
  isFlex: integer('is_flex', { mode: 'boolean' }).notNull().default(false),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
});

export const HOLIDAY_TYPES = ['regular', 'special'] as const;

export const holidays = sqliteTable('holidays', {
  /** YYYY-MM-DD */
  date: text('date').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: HOLIDAY_TYPES }).notNull(),
  /** Therapists earn the holiday Commission rate on this date. */
  raisesCommission: integer('raises_commission', { mode: 'boolean' }).notNull(),
});
