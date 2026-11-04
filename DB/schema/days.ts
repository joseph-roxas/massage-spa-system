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

/**
 * Sales Cash moved without being spent: Payroll paid from the shop, a Petty
 * Cash Top-up, or a Cash Handover to the owner. `opening` is the Super
 * Admin's count of Sales Cash in the shop when counting starts. Not Expenses.
 */
export const CASH_TRANSFER_KINDS = ['opening', 'payroll', 'petty_topup', 'handover'] as const;

export const cashTransfers = sqliteTable(
  'cash_transfers',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: CASH_TRANSFER_KINDS }).notNull(),
    /** Centavos. For a handover, what the Receptionist handed over. */
    amount: integer('amount').notNull(),
    /** The Business Day it counts toward; after that day's Day Close, the next one. */
    businessDay: text('business_day').notNull(),
    /** Payroll paid from the shop. */
    payrollId: text('payroll_id'),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
    /** Handover: what the owner counted, and who received it. */
    receivedAmount: integer('received_amount'),
    receivedOn: text('received_on'),
    /** "Me" (the confirming Super Admin) leaves this null; otherwise who received it for them. */
    receivedByName: text('received_by_name'),
    receiveNote: text('receive_note'),
    confirmedAt: text('confirmed_at'),
    confirmedBy: text('confirmed_by').references(() => users.id),
  },
  (t) => [index('cash_transfers_day_idx').on(t.businessDay), index('cash_transfers_kind_idx').on(t.kind, t.businessDay)],
);
