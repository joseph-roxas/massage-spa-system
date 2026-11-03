import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const STAFF_KINDS = ['therapist', 'receptionist'] as const;
export const THERAPIST_CLASSES = ['regular', 'lmt'] as const;

/** A person who works at the shop. Separate from users: most Staff never log in. */
export const staff = sqliteTable('staff', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  /** Name shown on the Clock-in Screen and Rotation. */
  displayName: text('display_name').notNull(),
  kind: text('kind', { enum: STAFF_KINDS }).notNull(),
  /** Therapists only. */
  therapistClass: text('therapist_class', { enum: THERAPIST_CLASSES }),
  /** On-call Therapists are paid daily with no Government Deductions or Cash Advances. */
  isOnCall: integer('is_on_call', { mode: 'boolean' }).notNull().default(false),
  /** Receptionist only, centavos. */
  dailyRate: integer('daily_rate'),
  /** Weekly employee share, centavos. */
  govSss: integer('gov_sss').notNull().default(0),
  govPhic: integer('gov_phic').notNull().default(0),
  govPagibig: integer('gov_pagibig').notNull().default(0),
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
