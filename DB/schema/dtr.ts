import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { staff } from './staff';

export const DTR_SOURCES = ['pin', 'manual'] as const;

/** One clock-in/clock-out pair. A staff member may have several in a Business Day. */
export const dtr = sqliteTable(
  'dtr',
  {
    id: text('id').primaryKey(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    /** YYYY-MM-DD the entry belongs to (after-midnight work counts toward the day that opened). */
    businessDay: text('business_day').notNull(),
    /** ISO instants. */
    clockIn: text('clock_in').notNull(),
    clockOut: text('clock_out'),
    /** 'pin' = punched on the Clock-in Screen; 'manual' = added by a correction. */
    source: text('source', { enum: DTR_SOURCES }).notNull(),
    createdAt: text('created_at').notNull(),
    /** Set when someone edits a punched entry; the reason is kept in the audit log too. */
    correctedBy: text('corrected_by'),
    correctedAt: text('corrected_at'),
    correctionReason: text('correction_reason'),
  },
  (t) => [index('dtr_day_idx').on(t.businessDay), index('dtr_staff_idx').on(t.staffId, t.clockIn)],
);
