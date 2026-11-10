import { and, eq, inArray, isNull, lt, lte } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { autoClockOutAt, businessDayOf } from '@spa/domain';
import { businessDays, dtr, staff } from '@spa/db';
import { auditInsert } from './audit';

/** Who is still clocked in on `day` or earlier: what Day Close will clock out. */
export function stillClockedIn(db: DrizzleD1Database, day: string) {
  return db
    .select({ id: dtr.id, staffId: dtr.staffId, displayName: staff.displayName, clockIn: dtr.clockIn })
    .from(dtr)
    .innerJoin(staff, eq(staff.id, dtr.staffId))
    .where(and(isNull(dtr.clockOut), lte(dtr.businessDay, day)));
}

/** The update and audit line for one Auto Clock-out; it goes back on the DTR Review. */
export function autoClockOutWrites(db: DrizzleD1Database, actorUserId: string | null, id: string, clockOut: string, why: string) {
  return [
    db.update(dtr).set({ clockOut, autoClockOut: true, reviewedAt: null, reviewedBy: null }).where(eq(dtr.id, id)),
    auditInsert(db, { actorUserId, action: 'dtr.auto_clock_out', entity: 'dtr', entityId: id, after: { clockOut }, reason: why }),
  ];
}

/**
 * Clocks out anyone still in from an earlier Business Day, i.e. after 6:00am the next morning:
 * at that day's Day Close time, or 11:00pm if it was never closed. Safe to run any number of times.
 */
export async function clockOutForgotten(db: DrizzleD1Database, now: Date = new Date()): Promise<number> {
  const open = await db
    .select({ id: dtr.id, businessDay: dtr.businessDay, clockIn: dtr.clockIn })
    .from(dtr)
    .where(and(isNull(dtr.clockOut), lt(dtr.businessDay, businessDayOf(now))));
  if (!open.length) return 0;
  const days = await db
    .select({ date: businessDays.date, closedAt: businessDays.closedAt })
    .from(businessDays)
    .where(inArray(businessDays.date, [...new Set(open.map((e) => e.businessDay))]));
  const writes = open.flatMap((e) => {
    const closedAt = days.find((d) => d.date === e.businessDay)?.closedAt ?? null;
    return autoClockOutWrites(db, null, e.id, autoClockOutAt(e, closedAt), closedAt ? 'Still clocked in after Day Close' : 'Still clocked in; the day was never closed');
  });
  await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
  return open.length;
}
