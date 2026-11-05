import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { rooms, services } from './catalogue';
import { guests } from './guests';
import { staff } from './staff';
import { users } from './users';

export const BOOKING_KINDS = ['walk_in', 'scheduled'] as const;
/**
 * scheduled → (guest arrives) waiting → in_service → done
 * A walk-in starts as waiting. scheduled/waiting can be cancelled; scheduled can be a no-show.
 */
export const BOOKING_STATUSES = ['scheduled', 'waiting', 'in_service', 'done', 'cancelled', 'no_show'] as const;
export const FLEX_MODES = ['floor', 'recliner'] as const;

/** One Guest receiving one Service. A group of two is two Bookings. */
export const bookings = sqliteTable(
  'bookings',
  {
    id: text('id').primaryKey(),
    businessDay: text('business_day').notNull(),
    kind: text('kind', { enum: BOOKING_KINDS }).notNull(),
    status: text('status', { enum: BOOKING_STATUSES }).notNull(),
    /** The Guest Record, when the desk picked or saved one; name and phone are copied as at booking. */
    guestId: text('guest_id').references(() => guests.id),
    guestName: text('guest_name'),
    guestPhone: text('guest_phone'),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    /** Copied from the Service when booked, so later edits to the catalogue don't move the schedule. */
    durationMin: integer('duration_min').notNull(),
    /** ISO instant the Guest is expected; null for walk-ins. */
    scheduledAt: text('scheduled_at'),
    requestedTherapistId: text('requested_therapist_id').references(() => staff.id),
    therapistId: text('therapist_id').references(() => staff.id),
    roomId: integer('room_id').references(() => rooms.id),
    flexMode: text('flex_mode', { enum: FLEX_MODES }),
    portableTable: integer('portable_table', { mode: 'boolean' }).notNull().default(false),
    /** Why the therapist differs from the system's suggestion, if it does. */
    overrideReason: text('override_reason'),
    notes: text('notes'),
    startedAt: text('started_at'),
    doneAt: text('done_at'),
    cancelReason: text('cancel_reason'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [
    index('bookings_day_idx').on(t.businessDay, t.status),
    index('bookings_therapist_idx').on(t.therapistId, t.status),
    index('bookings_guest_idx').on(t.guestId),
    // The database itself refuses double-booking: one Guest per Room, one Guest per therapist.
    uniqueIndex('bookings_one_per_room').on(t.roomId).where(sql`status = 'in_service'`),
    uniqueIndex('bookings_one_per_therapist').on(t.therapistId).where(sql`status = 'in_service'`),
  ],
);
