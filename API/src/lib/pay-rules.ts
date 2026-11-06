import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { payRules } from '@spa/db';

async function rule<T>(db: DrizzleD1Database, key: string, fallback: T): Promise<T> {
  const row = await db.select().from(payRules).where(eq(payRules.key, key)).get();
  return row ? (JSON.parse(row.valueJson) as T) : fallback;
}

/** The least a Therapist should take home from a Payroll, in centavos. */
export const takeHomeFloor = (db: DrizzleD1Database) => rule(db, 'take_home_floor', 100_000);

/** The first real Business Day. */
export const goLiveDate = (db: DrizzleD1Database) => rule(db, 'go_live_date', '2026-11-08');
