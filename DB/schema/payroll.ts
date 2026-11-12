import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { cashOuts } from './days';
import { staff } from './staff';
import { users } from './users';

/** `reliever`: an Outside Reliever on long cover, paid weekly. */
export const PAYROLL_KINDS = ['therapist', 'receptionist', 'reliever'] as const;
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
    /** Therapists: this week's Government Deductions not taken, kept as Deferred Deductions. */
    govDeferred: integer('gov_deferred').notNull().default(0),
    /** Therapists: Deferred Deductions from earlier weeks collected now. */
    govCollected: integer('gov_collected').notNull().default(0),
    /** The Deferred Deductions balance this Payroll was computed from. */
    govBalanceBefore: integer('gov_balance_before').notNull().default(0),
    /** The Super Admin's own figure for what to take on this Payroll, instead of the Take-home Floor. */
    govOverride: integer('gov_override'),
    /** The Therapist agreed to have this week's deduction taken, below the Take-home Floor. */
    govAgreed: integer('gov_agreed', { mode: 'boolean' }).notNull().default(false),
    /** Commission for the days of this Pay Week before Go-live. */
    commissionBefore: integer('commission_before').notNull().default(0),
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

/**
 * A labelled amount the Super Admin adds to or takes off one person's Payroll for a Pay Week.
 * Keyed by week and person, not Payroll id, because drafts are regenerated.
 */
export const payrollAdjustments = sqliteTable(
  'payroll_adjustments',
  {
    id: text('id').primaryKey(),
    weekStart: text('week_start').notNull(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    /** Shown on the Payslip. */
    label: text('label').notNull(),
    /** Centavos, signed: negative takes pay off. */
    amount: integer('amount').notNull(),
    /** For the Super Admin only; not on the Payslip. */
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('payroll_adjustments_week_staff_idx').on(t.weekStart, t.staffId)],
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

export const DEDUCTION_ENTRIES = ['opening', 'deferred', 'collected', 'bonus', 'refund'] as const;

/** What each Therapist still owes in Government Deductions: balance = opening + deferred − collected − bonus − refund. */
export const deductionLedger = sqliteTable(
  'deduction_ledger',
  {
    id: text('id').primaryKey(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    entry: text('entry', { enum: DEDUCTION_ENTRIES }).notNull(),
    /** Centavos, always positive; `entry` gives the direction. */
    amount: integer('amount').notNull(),
    payrollId: text('payroll_id').references(() => payrolls.id),
    /** An opening balance's weeks, as `[{ weekStart, amount }]`; a later week comes from its Payroll. */
    weeksJson: text('weeks_json'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('deduction_ledger_staff_idx').on(t.staffId), index('deduction_ledger_payroll_idx').on(t.payrollId)],
);

/**
 * The one-time Government Deduction Refund (ADR 0010): what a staff member was over-charged,
 * by agency, applied first to their Deferred Deductions and the rest paid on one Payroll.
 */
export const deductionRefunds = sqliteTable('deduction_refunds', {
  id: text('id').primaryKey(),
  staffId: text('staff_id')
    .notNull()
    .unique()
    .references(() => staff.id),
  /** The Pay Week whose Payroll carries it. */
  weekStart: text('week_start').notNull(),
  /** Centavos, signed per agency; their sum is the refund and is never below zero. */
  sss: integer('sss').notNull(),
  phic: integer('phic').notNull(),
  pagibig: integer('pagibig').notNull(),
  /** Taken off the Deferred Deductions balance. */
  applied: integer('applied').notNull(),
  /** Paid on the Payroll, as an Adjustment. */
  cash: integer('cash').notNull(),
  adjustmentId: text('adjustment_id').references(() => payrollAdjustments.id),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').references(() => users.id),
});

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
    /** Deferred Deductions taken off `amount` when paid; the rest stays owed. */
    deduction: integer('deduction').notNull().default(0),
    /** Year-end Bonus: the Business Days it covers. The next year starts the day after `periodEnd`. */
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    paidAt: text('paid_at'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [uniqueIndex('bonuses_year_staff_kind_idx').on(t.year, t.staffId, t.kind)],
);

/** Basic pay earned in a year before the system, added to live basic pay for 13th Month Pay. */
export const openingBasicPay = sqliteTable(
  'opening_basic_pay',
  {
    id: text('id').primaryKey(),
    year: integer('year').notNull(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    /** Centavos. */
    amount: integer('amount').notNull(),
    updatedAt: text('updated_at').notNull(),
    updatedBy: text('updated_by').references(() => users.id),
  },
  (t) => [uniqueIndex('opening_basic_pay_year_staff_idx').on(t.year, t.staffId)],
);
