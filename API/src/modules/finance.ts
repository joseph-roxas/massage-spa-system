import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gte, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  businessDayOf,
  daysUntil,
  incomeStatement,
  isQuarter,
  percentageTax,
  percentageTaxDue,
  previousQuarter,
  quarterOf,
  quarterRange,
  toManila,
  type StatementLine,
  type Centavos,
} from '@spa/domain';
import {
  bonuses,
  cashOuts,
  expenseCategories,
  expenses,
  holidays,
  payments,
  payrolls,
  percentageTaxFilings,
  sales,
  stockIns,
  voucherPayments,
  voucherSales,
} from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { centavos, isoDate, todayInManila } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

type Db = DrizzleD1Database;

const n = (v: unknown) => Number(v ?? 0);
const quarterParam = z.string().refine(isQuarter, 'Use a quarter like 2026-Q3.');

const CASH_OUT_LABELS: Record<string, string> = { petty_cash: 'Petty cash', laundry: 'Laundry', supplies: 'Supplies (from the drawer)', food: 'Food / rice', transport: 'Transport', other: 'Other cash-outs' };

/** Gross sales for Percentage Tax: every payment received for Services, Add-ons and Vouchers, by Business Day. */
async function grossSales(db: Db, from: string, to: string) {
  const [svc, vouchers] = await Promise.all([
    db
      .select({ s: sql<number>`sum(${payments.amount})` })
      .from(payments)
      .innerJoin(sales, eq(sales.id, payments.saleId))
      .where(and(eq(sales.status, 'paid'), gte(payments.businessDay, from), lte(payments.businessDay, to)))
      .get(),
    db
      .select({ s: sql<number>`sum(${voucherPayments.amount})` })
      .from(voucherPayments)
      .innerJoin(voucherSales, eq(voucherSales.id, voucherPayments.voucherSaleId))
      .where(and(eq(voucherSales.status, 'paid'), gte(voucherPayments.businessDay, from), lte(voucherPayments.businessDay, to)))
      .get(),
  ]);
  return { services: n(svc?.s) as Centavos, vouchers: n(vouchers?.s) as Centavos, total: (n(svc?.s) + n(vouchers?.s)) as Centavos };
}

async function holidaySet(db: Db, q: string) {
  const rows = await db.select({ date: holidays.date }).from(holidays).where(gte(holidays.date, quarterRange(q).end));
  return new Set(rows.map((r) => r.date));
}

export async function quarterStatus(db: Db, q: string) {
  const { start, end } = quarterRange(q);
  const [gross, filing, hols] = await Promise.all([
    grossSales(db, start, end),
    db.select().from(percentageTaxFilings).where(eq(percentageTaxFilings.quarter, q)).get(),
    holidaySet(db, q),
  ]);
  const dueOn = percentageTaxDue(q, hols);
  return { quarter: q, start, end, grossSales: gross, tax: percentageTax(gross.total), dueOn, daysLeft: daysUntil(dueOn, businessDayOf(new Date())), filing: filing ?? null };
}

/** Every line of an Income Statement for Business Days `from`..`to`. Pending drafts are listed apart, not counted. */
async function statementFor(db: Db, from: string, to: string) {
  const weekFrom = new Date(`${from}T00:00:00Z`);
  weekFrom.setUTCDate(weekFrom.getUTCDate() - 6);
  const [sold, vouchers, desk, paidBonuses, spent, outs, bought] = await Promise.all([
    db
      .select({
        services: sql<number>`sum(${sales.serviceAmount})`,
        addons: sql<number>`sum(${sales.addonsTotal})`,
        discounts: sql<number>`sum(case when ${sales.discountType} in ('senior', 'pwd', 'promo') then ${sales.discountAmount} else 0 end)`,
        commission: sql<number>`sum(${sales.commissionAmount})`,
      })
      .from(sales)
      .where(and(eq(sales.status, 'paid'), gte(sales.businessDay, from), lte(sales.businessDay, to)))
      .get(),
    db
      .select({ s: sql<number>`sum(${voucherSales.total})` })
      .from(voucherSales)
      .where(and(eq(voucherSales.status, 'paid'), gte(voucherSales.businessDay, from), lte(voucherSales.businessDay, to)))
      .get(),
    db
      .select({ days: payrolls.breakdownJson })
      .from(payrolls)
      .where(and(eq(payrolls.kind, 'receptionist'), gte(payrolls.weekStart, weekFrom.toISOString().slice(0, 10)), lte(payrolls.weekStart, to))),
    db.select({ kind: bonuses.kind, amount: bonuses.amount, paidAt: bonuses.paidAt }).from(bonuses).where(isNotNull(bonuses.paidAt)),
    db
      .select({ name: expenseCategories.name, status: expenses.status, amount: sql<number>`sum(${expenses.amount})` })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(and(gte(expenses.date, from), lte(expenses.date, to)))
      .groupBy(expenseCategories.name, expenses.status),
    db
      .select({ category: cashOuts.category, amount: sql<number>`sum(${cashOuts.amount})` })
      .from(cashOuts)
      .where(
        and(
          gte(cashOuts.businessDay, from),
          lte(cashOuts.businessDay, to),
          notInArray(cashOuts.category, ['on_call_commission', 'cash_advance']),
          sql`not exists (select 1 from ${stockIns} where ${stockIns.cashOutId} = ${cashOuts.id})`,
        ),
      )
      .groupBy(cashOuts.category),
    db
      .select({ s: sql<number>`sum(${stockIns.qty} * coalesce(${stockIns.unitPrice}, 0))` })
      .from(stockIns)
      .where(and(eq(stockIns.kind, 'purchase'), gte(stockIns.purchaseDate, from), lte(stockIns.purchaseDate, to)))
      .get(),
  ]);

  // Receptionist pay counts on the day worked.
  let deskPay = 0;
  for (const row of desk) {
    for (const d of JSON.parse(row.days) as { date: string; total: number }[]) if (d.date >= from && d.date <= to) deskPay += d.total;
  }
  const bonusPaid = paidBonuses.filter((b) => {
    const day = toManila(new Date(b.paidAt!)).date;
    return day >= from && day <= to;
  });

  const revenue: StatementLine[] = [
    { label: 'Services (after discounts)', amount: n(sold?.services) as Centavos },
    { label: 'Add-ons', amount: n(sold?.addons) as Centavos },
    { label: 'Vouchers sold', amount: n(vouchers?.s) as Centavos },
  ];
  const costs: StatementLine[] = [
    { label: 'Therapist commission', amount: n(sold?.commission) as Centavos },
    { label: 'Receptionist pay', amount: deskPay as Centavos },
    { label: 'Year-end bonus', amount: bonusPaid.filter((b) => b.kind === 'year_end_bonus').reduce((s, b) => s + b.amount, 0) as Centavos },
    { label: '13th month pay', amount: bonusPaid.filter((b) => b.kind === 'thirteenth_month').reduce((s, b) => s + b.amount, 0) as Centavos },
    ...spent.filter((e) => e.status === 'confirmed').map((e) => ({ label: e.name, amount: n(e.amount) as Centavos })),
    ...outs.map((o) => ({ label: CASH_OUT_LABELS[o.category] ?? o.category, amount: n(o.amount) as Centavos })),
    { label: 'Inventory purchases', amount: n(bought?.s) as Centavos },
  ];
  const pending = spent.filter((e) => e.status === 'pending').map((e) => ({ label: e.name, amount: n(e.amount) as Centavos }));
  return { ...incomeStatement(revenue, costs), discounts: n(sold?.discounts) as Centavos, pending };
}

const lastYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, '-02-28');

export const financeRoutes = new Hono<AuthedEnv>()
  .use('/finance/*', requireAuth, requireCapability('reports.all'))

  /** A quarter's 2551Q: gross sales, the 3% due, its deadline, and the filing if made. */
  .get('/finance/percentage-tax', zValidator('query', z.object({ quarter: quarterParam.optional() }), invalidInput), async (c) => {
    const today = businessDayOf(new Date());
    const q = c.req.valid('query').quarter ?? previousQuarter(quarterOf(today));
    return c.json({ ...(await quarterStatus(c.var.db, q)), currentQuarter: quarterOf(today) });
  })

  /** The latest finished quarter, if its 2551Q is not filed yet: what the Home reminder shows. */
  .get('/finance/percentage-tax/due', async (c) => {
    const q = previousQuarter(quarterOf(businessDayOf(new Date())));
    const status = await quarterStatus(c.var.db, q);
    return c.json({ due: status.filing ? null : status });
  })

  /** Records the 2551Q as filed and paid, which records it as a BIR Expense. */
  .post(
    '/finance/percentage-tax/:quarter/file',
    requireCapability('expenses.manage'),
    zValidator('param', z.object({ quarter: quarterParam }), invalidInput),
    zValidator('json', z.object({ filedOn: isoDate, amountPaid: centavos }), invalidInput),
    async (c) => {
      const db = c.var.db;
      const { quarter } = c.req.valid('param');
      const input = c.req.valid('json');
      if (input.filedOn > todayInManila()) return fail(c, 400, 'future_date', 'The filing date cannot be in the future.');
      if (quarterRange(quarter).end >= businessDayOf(new Date())) return fail(c, 409, 'quarter_open', 'File 2551Q once the quarter has ended.');
      const status = await quarterStatus(db, quarter);
      if (status.filing) return fail(c, 409, 'already_filed', `2551Q for ${quarter} is already recorded as filed.`);
      const expenseId = crypto.randomUUID();
      const now = nowIso();
      await db.batch([
        db.insert(expenses).values({
          id: expenseId,
          categoryId: 'bir',
          date: input.filedOn,
          amount: input.amountPaid,
          description: `2551Q Percentage Tax for ${quarter} (3% of ₱${(status.grossSales.total / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })})`,
          status: 'confirmed',
          createdAt: now,
          createdBy: c.var.user.id,
          confirmedAt: now,
          confirmedBy: c.var.user.id,
        }),
        db.insert(percentageTaxFilings).values({
          quarter,
          grossSales: status.grossSales.total,
          computed: status.tax,
          amountPaid: input.amountPaid,
          filedOn: input.filedOn,
          expenseId,
          createdAt: now,
          createdBy: c.var.user.id,
        }),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'percentage_tax.file', entity: 'percentage_tax', entityId: quarter, after: input }),
      ]);
      return c.json({ ok: true }, 201);
    },
  )

  /** Revenue less every cost for a period, beside the same dates a year earlier. */
  .get(
    '/finance/income-statement',
    zValidator(
      'query',
      z
        .object({ from: isoDate, to: isoDate })
        .refine((q) => q.from <= q.to, 'The start date must be on or before the end date.')
        .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, 'Choose at most a year at a time.'),
      invalidInput,
    ),
    async (c) => {
      const { from, to } = c.req.valid('query');
      const [current, previous] = await Promise.all([statementFor(c.var.db, from, to), statementFor(c.var.db, lastYear(from), lastYear(to))]);
      return c.json({ from, to, current, lastYear: { from: lastYear(from), to: lastYear(to), ...previous } });
    },
  );
