import { and, gte, lte, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { dailySummaries, pastMonths } from '@spa/db';

/** Daily Summaries in a date range, added up. Live figures add these on top (ADR 0006). */
export async function summaryTotals(db: DrizzleD1Database, from: string, to: string) {
  const row = await db
    .select({
      cash: sql<number>`coalesce(sum(${dailySummaries.cash}), 0)`,
      gcash: sql<number>`coalesce(sum(${dailySummaries.gcash}), 0)`,
      voucher: sql<number>`coalesce(sum(${dailySummaries.voucher}), 0)`,
      foc: sql<number>`coalesce(sum(${dailySummaries.foc}), 0)`,
      commission: sql<number>`coalesce(sum(${dailySummaries.commission}), 0)`,
    })
    .from(dailySummaries)
    .where(and(gte(dailySummaries.date, from), lte(dailySummaries.date, to)))
    .get();
  const cash = Number(row?.cash ?? 0);
  const gcash = Number(row?.gcash ?? 0);
  const voucher = Number(row?.voucher ?? 0);
  const foc = Number(row?.foc ?? 0);
  return { cash, gcash, voucher, foc, commission: Number(row?.commission ?? 0), services: cash + gcash - foc, received: cash + gcash + voucher - foc };
}

/** The Receptionist's gross pay for whole past months starting inside the range. */
export async function pastReceptionistPay(db: DrizzleD1Database, from: string, to: string): Promise<number> {
  const row = await db
    .select({ s: sql<number>`coalesce(sum(${pastMonths.receptionistPay}), 0)` })
    .from(pastMonths)
    .where(and(gte(sql`${pastMonths.month} || '-01'`, from), lte(sql`${pastMonths.month} || '-01'`, to)))
    .get();
  return Number(row?.s ?? 0);
}
