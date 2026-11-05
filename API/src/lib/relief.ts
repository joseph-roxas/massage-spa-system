import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { reliefDay, type Premiums, type ReceptionistDay, type ReceptionistRules, type ShiftHours } from '@spa/domain';
import { businessDays, dtr, holidays, payRules } from '@spa/db';

type Db = DrizzleD1Database;
type DtrRow = typeof dtr.$inferSelect;

/** The Receptionist's shift, Rest Day and premiums from Settings. */
export async function receptionistRules(db: Db): Promise<ReceptionistRules> {
  const rows = await db.select().from(payRules).where(inArray(payRules.key, ['receptionist_shift', 'receptionist_rest_weekday', 'receptionist_premiums']));
  const get = (key: string) => JSON.parse(rows.find((r) => r.key === key)!.valueJson) as unknown;
  return { shift: get('receptionist_shift') as ShiftHours, restWeekday: get('receptionist_rest_weekday') as number, premiums: get('receptionist_premiums') as Premiums };
}

/** The Minimum Wage Rate in Settings, centavos. */
export async function minimumWage(db: Db): Promise<number> {
  const row = await db.select().from(payRules).where(eq(payRules.key, 'minimum_wage_daily')).get();
  return row ? (JSON.parse(row.valueJson) as number) : 58_200;
}

/** Relief pay for each Business Day the given (closed) relief entries cover. */
export async function reliefDays(db: Db, entries: readonly DtrRow[]): Promise<ReceptionistDay[]> {
  const closed = entries.filter((e) => e.isRelief && e.clockOut);
  if (!closed.length) return [];
  const dates = [...new Set(closed.map((e) => e.businessDay))].sort();
  const [rules, wage, hols, days] = await Promise.all([
    receptionistRules(db),
    minimumWage(db),
    db.select().from(holidays).where(inArray(holidays.date, dates)),
    db.select().from(businessDays).where(inArray(businessDays.date, dates)),
  ]);
  return dates.flatMap((date) => {
    const bd = days.find((d) => d.date === date);
    const day = reliefDay({
      date,
      holiday: hols.find((h) => h.date === date)?.type ?? null,
      entries: closed.filter((e) => e.businessDay === date).map((e) => ({ clockIn: new Date(e.clockIn), clockOut: new Date(e.clockOut!) })),
      earlyCloseAt: bd?.earlyCloseStatus === 'recorded' && bd.earlyCloseAt ? new Date(bd.earlyCloseAt) : null,
      minimumWage: wage,
      rules,
    });
    return day ? [day] : [];
  });
}

/** An Outside Reliever's relief time not yet paid in cash ("paid when the Receptionist returns"). */
export async function unpaidRelief(db: Db, staffId: string) {
  const entries = await db
    .select()
    .from(dtr)
    .where(and(eq(dtr.staffId, staffId), eq(dtr.isRelief, true), isNotNull(dtr.clockOut)));
  const owed = entries.filter((e) => !e.reliefPaidAt);
  const days = await reliefDays(db, owed);
  return { entryIds: owed.map((e) => e.id), days, amount: days.reduce((s, d) => s + d.total, 0) };
}
