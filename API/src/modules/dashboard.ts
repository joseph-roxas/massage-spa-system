import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  businessDayOf,
  consumablesTrend,
  daysIn,
  isMonth,
  monthRange,
  percentageTax,
  projected,
  quarterOf,
  quarterRange,
  royaltyAmount,
  shiftMonth,
  toManila,
  weekdayAverages,
  type Row,
} from '@spa/domain';
import { bookings, businessDays, cashOuts, expenses, items, payrolls, royaltyStatements, sales, servicePrices, services, staff, stockIns, stockOuts, vouchers } from '@spa/db';
import type { AuthedEnv } from '../env';
import { requireAuth, requireCapability } from '../auth/middleware';
import { contributionRates, contributionsOf } from '../lib/contributions';
import { pastReceptionistPay, summaryTotals } from '../lib/daily-summaries';
import { fail, invalidInput } from '../lib/http';
import { goLiveDate } from '../lib/pay-rules';
import { currentRoyaltyBp, royaltyFigures } from './expenses';
import { quarterStatus, statementFor } from './finance';
import { dailySales, foc, therapistSales } from './reports';

type Db = DrizzleD1Database;

const n = (v: unknown) => Number(v ?? 0);
const money = (row: Row, key: string) => n(row[key]);
const TOP = 5;

/** What the month's remittance comes to: both shares, for everyone enrolled. */
async function governmentDue(db: Db) {
  const [people, rates] = await Promise.all([db.select().from(staff).where(eq(staff.active, true)), contributionRates(db)]);
  let employee = 0;
  let employer = 0;
  let noBasis = 0;
  for (const p of people) {
    if (p.kind === 'reliever' || p.isOnCall || p.notEnrolled) continue;
    const c = contributionsOf(p, rates);
    if (!c) noBasis += 1;
    else {
      employee += c.ee;
      employer += c.er;
    }
  }
  return { employee, employer, total: employee + employer, noBasis };
}

async function taxForecast(db: Db, to: string, today: string) {
  const q = quarterOf(to);
  const { start, end } = quarterRange(q);
  const status = await quarterStatus(db, q);
  const last = end < today ? end : today;
  const gross = projected(status.grossSales.total, daysIn(start, last), daysIn(start, end));
  return { quarter: q, soFar: status.tax, forecast: percentageTax(gross), dueOn: status.dueOn, filed: !!status.filing };
}

async function royaltyStatus(db: Db, m: string, daysDone: number, daysTotal: number) {
  const [row, unpaid] = await Promise.all([
    db.select().from(royaltyStatements).where(eq(royaltyStatements.month, m)).get(),
    db.select({ month: royaltyStatements.month, amount: royaltyStatements.amount }).from(royaltyStatements).where(eq(royaltyStatements.status, 'draft')),
  ]);
  const owing = { months: unpaid.length, total: unpaid.reduce((s, r) => s + r.amount, 0) };
  if (row) return { status: row.status === 'confirmed' ? ('paid' as const) : ('not_paid' as const), amount: row.amount, owing };
  const [figures, bp] = await Promise.all([royaltyFigures(db, m), currentRoyaltyBp(db)]);
  return { status: 'forecast' as const, amount: projected(royaltyAmount(figures.grossSales, bp), daysDone, daysTotal), owing };
}

async function electricity(db: Db, m: string) {
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(m, i - 5));
  const rows = await db
    .select({ month: sql<string>`substr(${expenses.date}, 1, 7)`, amount: sql<number>`sum(${expenses.amount})` })
    .from(expenses)
    .where(and(eq(expenses.categoryId, 'electricity'), eq(expenses.status, 'confirmed'), gte(expenses.date, monthRange(months[0]!).start), lte(expenses.date, monthRange(m).end)))
    .groupBy(sql`substr(${expenses.date}, 1, 7)`);
  return months.map((month) => ({ month, amount: n(rows.find((r) => r.month === month)?.amount) }));
}

/** Consumables used, at what they cost on average, per Guest. */
async function consumablesPerGuest(db: Db, from: string, to: string) {
  const [used, prices, served] = await Promise.all([
    db
      .select({ id: stockOuts.itemId, qty: sql<number>`sum(${stockOuts.qty})` })
      .from(stockOuts)
      .innerJoin(items, eq(items.id, stockOuts.itemId))
      .where(and(eq(items.kind, 'consumable'), eq(stockOuts.kind, 'use'), gte(stockOuts.date, from), lte(stockOuts.date, to)))
      .groupBy(stockOuts.itemId),
    db
      .select({ id: stockIns.itemId, spent: sql<number>`sum(${stockIns.qty} * ${stockIns.unitPrice})`, qty: sql<number>`sum(${stockIns.qty})` })
      .from(stockIns)
      .where(isNotNull(stockIns.unitPrice))
      .groupBy(stockIns.itemId),
    db.select({ n: sql<number>`count(*)` }).from(sales).where(and(eq(sales.status, 'paid'), gte(sales.businessDay, from), lte(sales.businessDay, to))).get(),
  ]);
  const cost = used.reduce((s, u) => {
    const p = prices.find((x) => x.id === u.id);
    return s + (p && n(p.qty) ? (n(u.qty) * n(p.spent)) / n(p.qty) : 0);
  }, 0);
  return { cost: Math.round(cost), guests: n(served?.n), perGuest: n(served?.n) ? Math.round(cost / n(served?.n)) : 0 };
}

async function consumables(db: Db, m: string, from: string, to: string) {
  const goLive = await goLiveDate(db);
  // Only whole months on the system can be a baseline.
  const firstFull = goLive.endsWith('-01') ? goLive.slice(0, 7) : shiftMonth(goLive.slice(0, 7), 1);
  const earlier = [1, 2, 3].map((i) => shiftMonth(m, -i)).filter((x) => x >= firstFull);
  const [now, ...before] = await Promise.all([
    consumablesPerGuest(db, from, to),
    ...earlier.map((x) => {
      const r = monthRange(x);
      return consumablesPerGuest(db, r.start, r.end);
    }),
  ]);
  return { cost: now!.cost, ...consumablesTrend(now!.perGuest, before.filter((b) => b.guests).map((b) => b.perGuest)) };
}

/** Unused Vouchers are services still owed, at today's Regular Price. */
async function voucherLiability(db: Db, today: string) {
  const [owed, prices] = await Promise.all([
    db
      .select({ serviceId: vouchers.serviceId, count: sql<number>`count(*)` })
      .from(vouchers)
      .where(and(eq(vouchers.status, 'unused'), or(isNotNull(vouchers.voucherSaleId), eq(vouchers.imported, true))))
      .groupBy(vouchers.serviceId),
    db.select().from(servicePrices).where(lte(servicePrices.effectiveFrom, today)).orderBy(desc(servicePrices.effectiveFrom)),
  ]);
  return {
    count: owed.reduce((s, o) => s + n(o.count), 0),
    value: owed.reduce((s, o) => s + n(o.count) * (prices.find((p) => p.serviceId === o.serviceId)?.regularPrice ?? 0), 0),
  };
}

async function dayCloseVariance(db: Db, from: string, to: string) {
  const days = await db
    .select({ date: businessDays.date, variance: businessDays.variance })
    .from(businessDays)
    .where(and(gte(businessDays.date, from), lte(businessDays.date, to), isNotNull(businessDays.variance)));
  const off = days.filter((d) => d.variance);
  const worst = off.reduce<(typeof off)[number] | null>((w, d) => (!w || Math.abs(d.variance!) > Math.abs(w.variance!) ? d : w), null);
  return { total: off.reduce((s, d) => s + d.variance!, 0), days: off.length, worst };
}

async function topServices(db: Db, from: string, to: string) {
  const rows = await db
    .select({ name: services.name, sales: sql<number>`sum(${sales.serviceAmount})`, count: sql<number>`count(*)` })
    .from(sales)
    .innerJoin(services, eq(services.id, sales.serviceId))
    .where(and(eq(sales.status, 'paid'), gte(sales.businessDay, from), lte(sales.businessDay, to)))
    .groupBy(services.id)
    .orderBy(desc(sql`sum(${sales.serviceAmount})`))
    .limit(TOP);
  return rows.map((r) => ({ name: r.name, amount: n(r.sales), count: n(r.count) }));
}

/**
 * Guests booked but not served: the month's No-shows and cancellations, who the
 * No-shows were with their count to date, and the latest reasons given. An Added
 * Service that was cancelled isn't a Guest lost.
 */
async function missedGuests(db: Db, from: string, to: string) {
  const rows = await db
    .select({ day: bookings.businessDay, status: bookings.status, guestId: bookings.guestId, guest: bookings.guestName, reason: bookings.cancelReason, createdAt: bookings.createdAt })
    .from(bookings)
    .where(and(inArray(bookings.status, ['no_show', 'cancelled']), isNull(bookings.parentBookingId), lte(bookings.businessDay, to)));
  const month = rows.filter((r) => r.day >= from);
  const noShows = month.filter((r) => r.status === 'no_show');
  const who = (r: { guestId: string | null; guest: string | null }) => r.guestId ?? r.guest?.trim().toLowerCase() ?? null;
  const toDate = new Map<string, number>();
  for (const r of rows.filter((x) => x.status === 'no_show')) {
    const key = who(r);
    if (key) toDate.set(key, (toDate.get(key) ?? 0) + 1);
  }
  const names = new Map(noShows.filter((r) => who(r) && r.guest).map((r) => [who(r)!, r.guest!]));
  return {
    noShows: noShows.length,
    cancelled: month.length - noShows.length,
    noShowGuests: [...names].map(([key, name]) => ({ name, count: toDate.get(key) ?? 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOP),
    cancelReasons: month
      .filter((r) => r.status === 'cancelled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, TOP)
      .map((r) => ({ date: r.day, guest: r.guest, reason: r.reason })),
  };
}

async function moneyOut(db: Db, from: string, to: string, costTotal: number, liveWages: number) {
  const [released, outs] = await Promise.all([
    db
      .select({ net: payrolls.net, releasedAt: payrolls.releasedAt })
      .from(payrolls)
      .where(and(eq(payrolls.status, 'released'), isNotNull(payrolls.releasedAt))),
    db
      .select({ total: sql<number>`sum(${cashOuts.amount})` })
      .from(cashOuts)
      .where(and(gte(cashOuts.businessDay, from), lte(cashOuts.businessDay, to), inArray(cashOuts.category, ['on_call_commission', 'cash_advance'])))
      .get(),
  ]);
  const paid = released.filter((p) => {
    const day = toManila(new Date(p.releasedAt!)).date;
    return day >= from && day <= to;
  });
  // Commission counts when earned; here what matters is the Payroll actually handed over.
  return costTotal - liveWages + paid.reduce((s, p) => s + p.net, 0) + n(outs?.total);
}

export const dashboardRoutes = new Hono<AuthedEnv>().get(
  '/dashboard',
  requireAuth,
  requireCapability('reports.all'),
  zValidator('query', z.object({ month: z.string().refine(isMonth, 'Use a month as YYYY-MM.').optional() }), invalidInput),
  async (c) => {
    const db = c.var.db;
    const today = businessDayOf(new Date());
    const m = c.req.valid('query').month ?? today.slice(0, 7);
    const { start, end } = monthRange(m);
    if (start > today) return fail(c, 400, 'future_month', 'That month has not started.');
    const to = end < today ? end : today;
    const range = { from: start, to };
    const daysDone = daysIn(start, to);
    const daysTotal = daysIn(start, end);
    const current = to < end;

    const [statement, daily, therapists, discounts, past, pastDesk, billed, people] = await Promise.all([
      statementFor(db, start, to),
      dailySales(db, range),
      therapistSales(db, range),
      foc(db, range),
      summaryTotals(db, start, to),
      pastReceptionistPay(db, start, to),
      db
        .select({ date: expenses.date, amount: sql<number>`sum(${expenses.amount})` })
        .from(expenses)
        .where(and(eq(expenses.status, 'confirmed'), isNull(expenses.backfillMonth), gte(expenses.date, start), lte(expenses.date, to)))
        .groupBy(expenses.date),
      db.select({ name: staff.displayName, birthdate: staff.birthdate }).from(staff).where(and(eq(staff.active, true), isNotNull(staff.birthdate))),
    ]);
    const line = (label: string) => statement.costs.find((l) => l.label === label)?.amount ?? 0;
    const commission = line('Therapist commission');
    const receptionist = line('Receptionist pay');

    const [out, government, tax, royalty, power, stock, liability, variance, services_, missed] = await Promise.all([
      moneyOut(db, start, to, statement.costTotal, commission + receptionist - past.commission - pastDesk),
      governmentDue(db),
      taxForecast(db, to, today),
      royaltyStatus(db, m, daysDone, daysTotal),
      electricity(db, m),
      consumables(db, m, start, to),
      voucherLiability(db, today),
      dayCloseVariance(db, start, to),
      topServices(db, start, to),
      missedGuests(db, start, to),
    ]);

    const byDay = new Map(daily.rows.map((r) => [String(r.date), r]));
    const days = Array.from({ length: daysDone }, (_, i) => {
      const date = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      const r = byDay.get(date) ?? {};
      return {
        date,
        sales: money(r, 'services') + money(r, 'addons') + money(r, 'vouchers'),
        expenses: money(r, 'commission') + money(r, 'cashOuts') + n(billed.find((b) => b.date === date)?.amount),
      };
    });

    const guests = daily.rows.reduce((s, r) => s + money(r, 'guests'), 0);
    const turnedAway = daily.rows.reduce((s, r) => s + money(r, 'rejects'), 0);
    const earned = daily.rows.reduce((s, r) => s + money(r, 'services') + money(r, 'addons'), 0);
    const cashIn = daily.rows.reduce((s, r) => s + money(r, 'cash') + money(r, 'gcash'), 0);
    const discountRows = discounts.rows.map((r) => ({ label: String(r.group), amount: money(r, 'discount'), count: money(r, 'count') }));
    if (past.foc) discountRows.push({ label: 'FOC, from Daily Summaries', amount: past.foc, count: 0 });

    return c.json({
      month: m,
      from: start,
      to,
      current,
      top: {
        sales: statement.revenueTotal,
        expenses: statement.costTotal,
        profit: statement.net,
        profitForecast: current ? projected(statement.net, daysDone, daysTotal) : null,
        pendingExpenses: statement.pending.reduce((s, p) => s + p.amount, 0),
        cashIn,
        cashOut: out,
        averageSale: guests ? Math.round(earned / guests) : 0,
      },
      days,
      government,
      tax,
      royalty,
      electricity: power,
      payroll: { therapists: commission, receptionist, total: commission + receptionist },
      discounts: discountRows,
      guests: {
        total: guests,
        turnedAway,
        ...missed,
        byWeekday: weekdayAverages(daily.rows.map((r) => ({ date: String(r.date), guests: money(r, 'guests') }))),
      },
      topTherapists: therapists.rows
        .map((r) => ({ name: String(r.name), amount: money(r, 'regular'), count: money(r, 'services') }))
        .filter((r) => r.amount > 0)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, TOP),
      topServices: services_,
      consumables: stock,
      vouchers: liability,
      variance,
      birthdays: people
        .filter((p) => p.birthdate!.slice(5, 7) === m.slice(5, 7))
        .map((p) => ({ name: p.name, day: Number(p.birthdate!.slice(8, 10)) }))
        .sort((a, b) => a.day - b.day),
    });
  },
);
