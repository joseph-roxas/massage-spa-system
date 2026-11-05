import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const STATUTORY_TYPES = ['senior', 'pwd'] as const;

/** What the shop keeps about a Guest across Visits. Visits come from their checked-out Bookings. */
export const guests = sqliteTable(
  'guests',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    phone: text('phone'),
    /** The saved Senior Citizen or PWD ID, filled in at checkout. */
    statutoryType: text('statutory_type', { enum: STATUTORY_TYPES }),
    statutoryIdNo: text('statutory_id_no'),
    /** Set when the Super Admin merged this duplicate into another record. */
    mergedInto: text('merged_into'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('guests_name_idx').on(t.name), index('guests_phone_idx').on(t.phone)],
);
