import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { staff } from './staff';
import { users } from './users';

/**
 * One day's totals from before Go-live (ADR 0006). `cash` is the sheet's Gross
 * Sales column, before FOC; money received is cash + gcash + oil + voucher − foc.
 */
export const dailySummaries = sqliteTable('daily_summaries', {
  /** YYYY-MM-DD */
  date: text('date').primaryKey(),
  /** Centavos. */
  cash: integer('cash').notNull().default(0),
  gcash: integer('gcash').notNull().default(0),
  oil: integer('oil').notNull().default(0),
  voucher: integer('voucher').notNull().default(0),
  foc: integer('foc').notNull().default(0),
  commission: integer('commission').notNull().default(0),
  guests: integer('guests').notNull().default(0),
  therapists: integer('therapists').notNull().default(0),
  rejects: integer('rejects').notNull().default(0),
  /** Only for the daily chart: the month's Expenses are the official totals. */
  laundry: integer('laundry').notNull().default(0),
  expenses: integer('expenses').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').references(() => users.id),
});

/** What only exists per month before Go-live. Everything else a month cost is an Expense. */
export const pastMonths = sqliteTable('past_months', {
  /** YYYY-MM */
  month: text('month').primaryKey(),
  /** Centavos: the Receptionist's gross pay. */
  receptionistPay: integer('receptionist_pay').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').references(() => users.id),
});

/** A Therapist's Commission for one Pay Week before Go-live, as recorded in the owner's sheet. */
export const pastTherapistWeeks = sqliteTable(
  'past_therapist_weeks',
  {
    id: text('id').primaryKey(),
    /** The Pay Week's Monday. */
    weekStart: text('week_start').notNull(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    /** Centavos. */
    gross: integer('gross').notNull(),
    daysWorked: integer('days_worked').notNull(),
    /** Can be negative: deductions recorded in a week with no earnings. */
    net: integer('net').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('past_therapist_weeks_week_staff_idx').on(t.weekStart, t.staffId)],
);

/** A Receptionist's Payslip from before Go-live, kept exactly as paid and never recomputed. */
export const pastPayslips = sqliteTable(
  'past_payslips',
  {
    id: text('id').primaryKey(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    weekStart: text('week_start').notNull(),
    weekEnd: text('week_end').notNull(),
    paidOn: text('paid_on'),
    /** Centavos. */
    dailyRate: integer('daily_rate').notNull(),
    daysWorked: integer('days_worked').notNull(),
    basic: integer('basic').notNull(),
    /** Hours × 100. */
    overtimeHours: integer('overtime_hours').notNull(),
    overtimePay: integer('overtime_pay').notNull(),
    /** Holiday and Rest Day pay. */
    premiumPay: integer('premium_pay').notNull(),
    lateUndertime: integer('late_undertime').notNull(),
    sss: integer('sss').notNull(),
    hdmf: integer('hdmf').notNull(),
    phic: integer('phic').notNull(),
    caRepayment: integer('ca_repayment').notNull(),
    gross: integer('gross').notNull(),
    net: integer('net').notNull(),
    /** Cash Advance balance after this week, as recorded. */
    caBalance: integer('ca_balance'),
    /** Each day's times, as recorded. */
    daysJson: text('days_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('past_payslips_staff_week_idx').on(t.staffId, t.weekStart), index('past_payslips_staff_idx').on(t.staffId)],
);
