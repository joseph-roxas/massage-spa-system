import type { Context } from 'hono';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { businessDays } from '@spa/db';
import type { AuthedEnv } from '../env';
import { fail } from './http';
import { nowIso } from './time';

export type BusinessDayRow = typeof businessDays.$inferSelect;

/** Days with activity that nobody has closed yet, oldest first. */
export function openDays(db: DrizzleD1Database) {
  return db.select().from(businessDays).where(isNull(businessDays.closedAt)).orderBy(asc(businessDays.date));
}

/**
 * Lets front-desk activity happen on `day`, opening it if this is its first.
 * Refuses while an earlier day is still open (it must be closed first) or once
 * `day` itself is closed. Returns the error response, or null to go ahead.
 */
export async function openDayFor(c: Context<AuthedEnv>, day: string): Promise<Response | null> {
  const db = c.var.db;
  const earlier = await db
    .select({ date: businessDays.date })
    .from(businessDays)
    .where(and(isNull(businessDays.closedAt), lt(businessDays.date, day)))
    .orderBy(asc(businessDays.date))
    .get();
  if (earlier) {
    return fail(c, 409, 'previous_day_open', `The Business Day of ${earlier.date} was never closed. Close it first.`);
  }
  const row = await db.select().from(businessDays).where(eq(businessDays.date, day)).get();
  if (row?.closedAt) {
    return fail(c, 409, 'day_closed', `The Business Day of ${day} is closed. Only the Super Admin can reopen it.`);
  }
  if (!row) {
    await db.insert(businessDays).values({ date: day, openedAt: nowIso(), openedBy: c.var.user.id }).onConflictDoNothing();
  }
  return null;
}

/** For changes to a day's records (e.g. voiding a sale): the day must exist and still be open. */
export async function requireOpenDay(c: Context<AuthedEnv>, day: string): Promise<Response | null> {
  const row = await c.var.db.select().from(businessDays).where(eq(businessDays.date, day)).get();
  if (row?.closedAt) {
    return fail(c, 409, 'day_closed', `The Business Day of ${day} is closed. Only the Super Admin can reopen it.`);
  }
  return null;
}
