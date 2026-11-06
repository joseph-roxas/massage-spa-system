import { and, asc, desc, eq, gte, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { businessDayOf, handoverReminder, lastCompletedPayWeek, payWeekOf, pettyCashBalance, salesCashAnchor, transferDay, type Centavos } from '@spa/domain';
import { businessDays, cashOuts, cashTransfers, payments, payrolls, sales, voucherPayments, voucherSales } from '@spa/db';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Net Sales Cash that came in over Business Days `from`..`to`: cash taken
 * for Services and Vouchers, less Cash-outs paid from Sales Cash and less
 * transfers (Payroll paid, Top-ups, Handovers).
 */
export async function netSalesCash(db: DrizzleD1Database, from: string, to: string): Promise<Centavos> {
  if (from > to) return 0 as Centavos;
  const [paid, vouchers, outs, moved] = await Promise.all([
    db
      .select({ s: sql<number>`sum(${payments.amount})` })
      .from(payments)
      .innerJoin(sales, eq(sales.id, payments.saleId))
      .where(and(eq(payments.method, 'cash'), eq(sales.status, 'paid'), gte(payments.businessDay, from), lte(payments.businessDay, to)))
      .get(),
    db
      .select({ s: sql<number>`sum(${voucherPayments.amount})` })
      .from(voucherPayments)
      .innerJoin(voucherSales, eq(voucherSales.id, voucherPayments.voucherSaleId))
      .where(and(eq(voucherPayments.method, 'cash'), eq(voucherSales.status, 'paid'), gte(voucherPayments.businessDay, from), lte(voucherPayments.businessDay, to)))
      .get(),
    db
      .select({ s: sql<number>`sum(${cashOuts.amount})` })
      .from(cashOuts)
      .where(and(eq(cashOuts.source, 'sales'), gte(cashOuts.businessDay, from), lte(cashOuts.businessDay, to)))
      .get(),
    db
      .select({ s: sql<number>`sum(${cashTransfers.amount})` })
      .from(cashTransfers)
      .where(and(ne(cashTransfers.kind, 'opening'), gte(cashTransfers.businessDay, from), lte(cashTransfers.businessDay, to)))
      .get(),
  ]);
  return (n(paid?.s) + n(vouchers?.s) - n(outs?.s) - n(moved?.s)) as Centavos;
}

/** Sales Cash that should be in the shop at the start of Business Day `day` (ADR 0003). */
export async function salesCashAtStartOf(db: DrizzleD1Database, day: string): Promise<Centavos> {
  const [closed, opening] = await Promise.all([
    db
      .select({ date: businessDays.date, countedCash: businessDays.countedCash })
      .from(businessDays)
      .where(and(lt(businessDays.date, day), isNotNull(businessDays.closedAt), isNotNull(businessDays.countedCash)))
      .orderBy(desc(businessDays.date))
      .get(),
    db
      .select({ date: cashTransfers.businessDay, amount: cashTransfers.amount })
      .from(cashTransfers)
      .where(and(eq(cashTransfers.kind, 'opening'), lte(cashTransfers.businessDay, day)))
      .orderBy(desc(cashTransfers.businessDay), desc(cashTransfers.createdAt))
      .get(),
  ]);
  const anchor = salesCashAnchor(closed ? { date: closed.date, countedCash: closed.countedCash! } : null, opening ?? null);
  const before = new Date(`${day}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  return (anchor.amount + (await netSalesCash(db, anchor.fromDay, before.toISOString().slice(0, 10)))) as Centavos;
}

/** The Business Day a cash movement recorded now counts toward. */
export async function currentTransferDay(db: DrizzleD1Database): Promise<string> {
  const today = businessDayOf(new Date());
  const row = await db.select({ closedAt: businessDays.closedAt }).from(businessDays).where(eq(businessDays.date, today)).get();
  return transferDay(today, !!row?.closedAt);
}

/** Sales Cash that should be in the shop right now. */
export async function salesCashNow(db: DrizzleD1Database): Promise<{ day: string; amount: Centavos }> {
  const day = await currentTransferDay(db);
  const [start, today] = await Promise.all([salesCashAtStartOf(db, day), netSalesCash(db, day, day)]);
  return { day, amount: (start + today) as Centavos };
}

export async function pettyCashNow(db: DrizzleD1Database): Promise<Centavos> {
  const [topUps, outs] = await Promise.all([
    db.select({ s: sql<number>`sum(${cashTransfers.amount})` }).from(cashTransfers).where(eq(cashTransfers.kind, 'petty_topup')).get(),
    db.select({ s: sql<number>`sum(${cashOuts.amount})` }).from(cashOuts).where(eq(cashOuts.source, 'petty')).get(),
  ]);
  return pettyCashBalance(n(topUps?.s), n(outs?.s));
}

/**
 * Whether the Receptionist should hand over Sales Cash now, and since when:
 * the moment the last of that week's Payroll and Laundry was paid.
 */
export async function handoverState(db: DrizzleD1Database, today: string) {
  const week = payWeekOf(today);
  const lastWeek = lastCompletedPayWeek(today);
  const [now, weekPayrolls, laundry, handedThisWeek] = await Promise.all([
    salesCashNow(db),
    db.select({ status: payrolls.status, releasedAt: payrolls.releasedAt }).from(payrolls).where(eq(payrolls.weekStart, lastWeek.start)),
    db
      .select({ createdAt: cashOuts.createdAt })
      .from(cashOuts)
      .where(and(eq(cashOuts.category, 'laundry'), gte(cashOuts.businessDay, week.start)))
      .orderBy(asc(cashOuts.createdAt))
      .get(),
    db
      .select({ id: cashTransfers.id })
      .from(cashTransfers)
      .where(and(eq(cashTransfers.kind, 'handover'), gte(cashTransfers.businessDay, week.start)))
      .get(),
  ]);
  const payrollReleased = weekPayrolls.length > 0 && weekPayrolls.every((p) => p.status === 'released');
  const reminder = handoverReminder({ salesCash: now.amount, payrollReleased: payrollReleased && !handedThisWeek, laundryPaid: !!laundry });
  const dueSince = reminder === 'hand_over' ? [laundry!.createdAt, ...weekPayrolls.map((p) => p.releasedAt!)].sort().at(-1)! : null;
  return { now, lastWeek, payrollReleased, laundryPaid: !!laundry, reminder, dueSince };
}
