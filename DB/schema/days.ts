import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { staff } from './staff';
import { users } from './users';

export const EARLY_CLOSE_STATUSES = ['recorded', 'rejected'] as const;

/** A Business Day, created by its first front-desk activity and ended by Day Close. */
export const businessDays = sqliteTable('business_days', {
  /** YYYY-MM-DD */
  date: text('date').primaryKey(),
  openedAt: text('opened_at').notNull(),
  openedBy: text('opened_by').references(() => users.id),
  earlyCloseAt: text('early_close_at'),
  earlyCloseReason: text('early_close_reason'),
  earlyCloseBy: text('early_close_by').references(() => users.id),
  earlyCloseStatus: text('early_close_status', { enum: EARLY_CLOSE_STATUSES }),
  /** Null while the day is open. */
  closedAt: text('closed_at'),
  closedBy: text('closed_by').references(() => users.id),
  /** Centavos, as computed at Day Close. */
  expectedCash: integer('expected_cash'),
  expectedGcash: integer('expected_gcash'),
  countedCash: integer('counted_cash'),
  /** counted − expected; negative means cash is short. */
  variance: integer('variance'),
  closeNote: text('close_note'),
  reopenedAt: text('reopened_at'),
  reopenedBy: text('reopened_by').references(() => users.id),
});

/** `supplies`, `food`, `transport`, `other` are history only; the form offers Petty cash and Laundry. */
export const CASH_OUT_CATEGORIES = ['on_call_commission', 'cash_advance', 'petty_cash', 'laundry', 'supplies', 'food', 'transport', 'other'] as const;
/** Which cash a Cash-out came from: Sales Cash or the Petty Cash Fund. */
export const CASH_OUT_SOURCES = ['sales', 'petty'] as const;

/** Cash taken from the drawer during a Business Day. */
export const cashOuts = sqliteTable(
  'cash_outs',
  {
    id: text('id').primaryKey(),
    businessDay: text('business_day').notNull(),
    category: text('category', { enum: CASH_OUT_CATEGORIES }).notNull(),
    source: text('source', { enum: CASH_OUT_SOURCES }).notNull().default('sales'),
    amount: integer('amount').notNull(),
    purpose: text('purpose').notNull(),
    /** Who received it, e.g. the On-call Therapist paid for the day. */
    staffId: text('staff_id').references(() => staff.id),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('cash_outs_day_idx').on(t.businessDay)],
);
