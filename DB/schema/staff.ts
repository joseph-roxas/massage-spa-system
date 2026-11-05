import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';

/** An Outside Reliever is sent by headquarters to cover the front desk; known only by name and PIN. */
export const STAFF_KINDS = ['therapist', 'receptionist', 'reliever'] as const;
/** When an Outside Reliever is paid: in cash when the Receptionist returns, or by weekly Payroll (long cover). */
export const RELIEF_PAY = ['on_return', 'weekly'] as const;
export const THERAPIST_CLASSES = ['regular', 'lmt'] as const;
export const GENDERS = ['female', 'male'] as const;
export const CIVIL_STATUSES = ['single', 'married', 'widowed', 'separated'] as const;
/** A Therapist's training level; only `doh` (DOH-licensed) may be an LMT. */
export const QUALIFICATIONS = ['nc2', 'doh', 'nuat_thai_trained', 'experience'] as const;
export const CERTIFICATE_TYPES = ['nc2', 'doh'] as const;

/** A person who works at the shop. Separate from users: most Staff never log in. */
export const staff = sqliteTable('staff', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  /** Surname. */
  lastName: text('last_name').notNull(),
  middleName: text('middle_name'),
  /** Name shown on the Clock-in Screen and Rotation. */
  displayName: text('display_name').notNull(),
  kind: text('kind', { enum: STAFF_KINDS }).notNull(),
  /** Therapists only. */
  therapistClass: text('therapist_class', { enum: THERAPIST_CLASSES }),
  /** On-call Therapists are paid daily with no Government Deductions or Cash Advances. */
  isOnCall: integer('is_on_call', { mode: 'boolean' }).notNull().default(false),
  /** Outside Reliever only. */
  reliefPay: text('relief_pay', { enum: RELIEF_PAY }),
  /** Receptionist only, centavos. */
  dailyRate: integer('daily_rate'),
  /** Receptionist only: the standing CA Repayment taken from each Payroll, centavos. */
  caRepayment: integer('ca_repayment').notNull().default(50_000),
  /**
   * Monthly salary basis for SSS, PhilHealth and Pag-IBIG, centavos. When set,
   * Payroll deducts the bracket's monthly employee share split over the month's
   * Pay Weeks, and the employer share is drafted as an Expense. When null, the
   * fixed weekly amounts below are used (records from before brackets).
   */
  contributionBase: integer('contribution_base'),
  /** Weekly employee share, centavos. */
  govSss: integer('gov_sss').notNull().default(0),
  govPhic: integer('gov_phic').notNull().default(0),
  govPagibig: integer('gov_pagibig').notNull().default(0),
  // Personal record, Super Admin only. Required for new staff; older records are completed when next edited.
  gender: text('gender', { enum: GENDERS }),
  birthdate: text('birthdate'),
  birthplace: text('birthplace'),
  civilStatus: text('civil_status', { enum: CIVIL_STATUSES }),
  religion: text('religion'),
  address: text('address'),
  email: text('email'),
  sssNo: text('sss_no'),
  phicNo: text('phic_no'),
  tin: text('tin'),
  pagibigNo: text('pagibig_no'),
  hireDate: text('hire_date'),
  /** Therapists only. */
  qualification: text('qualification', { enum: QUALIFICATIONS }),
  /** Clock-in Screen PIN, hashed. Null until set. */
  pinHash: text('pin_hash'),
  /** Wrong PINs in a row; reaching the limit locks the PIN for a few minutes. */
  pinFailedCount: integer('pin_failed_count').notNull().default(0),
  pinLockedUntil: text('pin_locked_until'),
  /** The login account of a Staff member who also uses the system, if any. */
  userId: text('user_id').references(() => users.id),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

/** Commission percentages by therapist class, in basis points (3000 = 30%). */
export const commissionRates = sqliteTable(
  'commission_rates',
  {
    id: text('id').primaryKey(),
    therapistClass: text('therapist_class', { enum: THERAPIST_CLASSES }).notNull(),
    normalBp: integer('normal_bp').notNull(),
    holidayBp: integer('holiday_bp').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by'),
  },
  (t) => [uniqueIndex('commission_rates_class_from_idx').on(t.therapistClass, t.effectiveFrom)],
);

/** Editable payroll settings (premium rates, shift hours, default deductions) as JSON values. */
export const payRules = sqliteTable('pay_rules', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

/** A dated credential a Therapist holds: TESDA NC-II or a DOH licence. */
export const certificates = sqliteTable('certificates', {
  id: text('id').primaryKey(),
  staffId: text('staff_id')
    .notNull()
    .references(() => staff.id),
  type: text('type', { enum: CERTIFICATE_TYPES }).notNull(),
  number: text('number'),
  issuedOn: text('issued_on'),
  expiresOn: text('expires_on'),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').references(() => users.id),
});
