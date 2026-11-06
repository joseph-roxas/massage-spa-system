import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const expenseCategories = sqliteTable('expense_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

/** A monthly expense the system drafts for the Super Admin to confirm, e.g. bookkeeping. */
export const recurringExpenses = sqliteTable('recurring_expenses', {
  id: text('id').primaryKey(),
  categoryId: text('category_id')
    .notNull()
    .references(() => expenseCategories.id),
  description: text('description').notNull(),
  /** Centavos; the draft can be changed before confirming (e.g. a varying bill). */
  amount: integer('amount').notNull(),
  /** 1–31; past the month's end it falls on the last day. */
  dayOfMonth: integer('day_of_month').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').references(() => users.id),
});

export const ROYALTY_STATUSES = ['draft', 'confirmed'] as const;

/** The month's Royalty: 3% of Gross Sales, recomputable until confirmed. */
export const royaltyStatements = sqliteTable('royalty_statements', {
  /** YYYY-MM */
  month: text('month').primaryKey(),
  monthStart: text('month_start').notNull(),
  monthEnd: text('month_end').notNull(),
  /** Centavos: Service payments after Discounts. */
  serviceSales: integer('service_sales').notNull(),
  /** Centavos: Vouchers sold in the month. */
  voucherSales: integer('voucher_sales').notNull(),
  grossSales: integer('gross_sales').notNull(),
  bp: integer('bp').notNull(),
  amount: integer('amount').notNull(),
  /** Entered from the owner's records before Go-live: never recomputed. */
  fixed: integer('fixed', { mode: 'boolean' }).notNull().default(false),
  status: text('status', { enum: ROYALTY_STATUSES }).notNull().default('draft'),
  computedAt: text('computed_at').notNull(),
  confirmedAt: text('confirmed_at'),
  confirmedBy: text('confirmed_by').references(() => users.id),
});

export const EXPENSE_STATUSES = ['pending', 'confirmed'] as const;

/** Money the shop spends. Drafted ones (recurring, royalty) are `pending` until confirmed. */
export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => expenseCategories.id),
    date: text('date').notNull(),
    amount: integer('amount').notNull(),
    description: text('description').notNull(),
    status: text('status', { enum: EXPENSE_STATUSES }).notNull().default('confirmed'),
    recurringExpenseId: text('recurring_expense_id').references(() => recurringExpenses.id),
    /** YYYY-MM a recurring draft was made for, so each month gets one. */
    recurringMonth: text('recurring_month'),
    royaltyMonth: text('royalty_month').references(() => royaltyStatements.month),
    /** YYYY-MM of an Employer Contributions draft, so each month gets one. */
    contributionsMonth: text('contributions_month'),
    /** YYYY-MM it came from the backfill for, so re-uploading a month replaces it. */
    backfillMonth: text('backfill_month'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
    confirmedAt: text('confirmed_at'),
    confirmedBy: text('confirmed_by').references(() => users.id),
  },
  (t) => [
    index('expenses_date_idx').on(t.date),
    uniqueIndex('expenses_recurring_month_idx').on(t.recurringExpenseId, t.recurringMonth),
    uniqueIndex('expenses_royalty_idx').on(t.royaltyMonth),
    uniqueIndex('expenses_contributions_idx').on(t.contributionsMonth),
  ],
);

/** A quarter's Percentage Tax (BIR 2551Q): computed from sales, and the filing once paid. */
export const percentageTaxFilings = sqliteTable('percentage_tax_filings', {
  /** YYYY-Qn */
  quarter: text('quarter').primaryKey(),
  grossSales: integer('gross_sales').notNull(),
  /** Centavos: 3% of gross sales as computed when filed. */
  computed: integer('computed').notNull(),
  amountPaid: integer('amount_paid').notNull(),
  filedOn: text('filed_on').notNull(),
  expenseId: text('expense_id').references(() => expenses.id),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').references(() => users.id),
});
