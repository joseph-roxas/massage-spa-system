import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { cashOuts } from './days';
import { staff } from './staff';
import { users } from './users';

export const PAYROLL_KINDS = ['therapist', 'receptionist'] as const;
export const PAYROLL_STATUSES = ['draft', 'approved', 'released'] as const;

/** One staff member's pay for one Pay Week. Drafts are regenerated freely; approved and released ones are fixed. */
export const payrolls = sqliteTable(
  'payrolls',
  {
    id: text('id').primaryKey(),
    /** The Pay Week's Sunday, YYYY-MM-DD. */
    weekStart: text('week_start').notNull(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    kind: text('kind', { enum: PAYROLL_KINDS }).notNull(),
    status: text('status', { enum: PAYROLL_STATUSES }).notNull().default('draft'),
    /** Centavos. */
    gross: integer('gross').notNull(),
    govSss: integer('gov_sss').notNull(),
    govPhic: integer('gov_phic').notNull(),
    govPagibig: integer('gov_pagibig').notNull(),
    caDeduction: integer('ca_deduction').notNull(),
    net: integer('net').notNull(),
    /** Receptionist basic pay (daily rate for paid minutes at 100%), the base for 13th Month Pay. */
    basic: integer('basic').notNull().default(0),
    /** Per-day lines as computed. */
    breakdownJson: text('breakdown_json').notNull(),
    generatedAt: text('generated_at').notNull(),
    generatedBy: text('generated_by').references(() => users.id),
    approvedAt: text('approved_at'),
    approvedBy: text('approved_by').references(() => users.id),
    releasedAt: text('released_at'),
    releasedBy: text('released_by').references(() => users.id),
  },
  (t) => [uniqueIndex('payrolls_week_staff_idx').on(t.weekStart, t.staffId)],
);

/** Money given ahead of Payroll. A Therapist's is deducted from the week it was taken against. */
export const cashAdvances = sqliteTable(
  'cash_advances',
  {
    id: text('id').primaryKey(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    amount: integer('amount').notNull(),
    businessDay: text('business_day').notNull(),
    /** Therapists only: the Pay Week whose Payroll repays it. */
    againstWeekStart: text('against_week_start'),
    /** The matching Cash-out when the money came from the drawer. */
    cashOutId: text('cash_out_id').references(() => cashOuts.id),
    /** Set when the Super Admin allowed more than the cap. */
    overrideBy: text('override_by').references(() => users.id),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('cash_advances_staff_idx').on(t.staffId, t.againstWeekStart)],
);

export const CA_ENTRIES = ['opening', 'advance', 'repayment'] as const;

/** What each person owes in Cash Advances: balance = opening + advances − repayments. */
export const caLedger = sqliteTable(
  'ca_ledger',
  {
    id: text('id').primaryKey(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    entry: text('entry', { enum: CA_ENTRIES }).notNull(),
    /** Centavos, always positive; `entry` gives the direction. */
    amount: integer('amount').notNull(),
    cashAdvanceId: text('cash_advance_id').references(() => cashAdvances.id),
    payrollId: text('payroll_id').references(() => payrolls.id),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('ca_ledger_staff_idx').on(t.staffId)],
);

export const BONUS_KINDS = ['year_end_bonus', 'thirteenth_month'] as const;

/** December payments, computed for a year and recomputable until paid. */
export const bonuses = sqliteTable(
  'bonuses',
  {
    id: text('id').primaryKey(),
    year: integer('year').notNull(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    kind: text('kind', { enum: BONUS_KINDS }).notNull(),
    /** Centavos: the year's Commission (Year-end Bonus) or basic pay (13th Month). */
    basis: integer('basis').notNull(),
    /** Year-end Bonus percentage in basis points. */
    bp: integer('bp'),
    amount: integer('amount').notNull(),
    paidAt: text('paid_at'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [uniqueIndex('bonuses_year_staff_kind_idx').on(t.year, t.staffId, t.kind)],
);
