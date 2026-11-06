import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  businessDayOf,
  DEFAULT_ROYALTY_BP,
  isMonth,
  monthOf,
  monthRange,
  previousMonth,
  recurringDate,
  royaltyAmount,
  royaltyGross,
  type Month,
} from '@spa/domain';
import { cashOuts, expenseCategories, expenses, items, recurringExpenses, royaltyStatements, sales, staff, stockIns, vendors, voucherSales } from '@spa/db';
import { contributionRates, contributionsOf } from '../lib/contributions';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { summaryTotals } from '../lib/daily-summaries';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { basisPoints, centavos, isoDate, name } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

type Db = DrizzleD1Database;

const month = z.string().refine(isMonth, 'Use a month as YYYY-MM.');
const amount = centavos.refine((v) => v > 0, 'Enter an amount.');
const expenseFields = z.object({ categoryId: z.string().min(1), date: isoDate, amount, description: z.string().trim().min(2).max(200) });
const recurringFields = z.object({
  categoryId: z.string().min(1),
  description: z.string().trim().min(2).max(200),
  amount,
  dayOfMonth: z.number().int().min(1).max(31),
  active: z.boolean().optional(),
});

/** Cash-outs that are spending, not pay (On-call pay, Relief pay and CAs belong to Payroll). */
const PAYROLL_CASH_OUTS = ['on_call_commission', 'cash_advance', 'relief_pay'] as const;

const peso = (c: number) => `₱${(c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

/** Drafts this month's recurring expenses that are not there yet. Safe to run again. */
export async function draftRecurring(db: Db, m: Month, actor: string | null) {
  const templates = await db.select().from(recurringExpenses).where(eq(recurringExpenses.active, true));
  if (!templates.length) return 0;
  const existing = new Set(
    (
      await db
        .select({ id: expenses.recurringExpenseId })
        .from(expenses)
        .where(and(eq(expenses.recurringMonth, m), isNotNull(expenses.recurringExpenseId)))
    ).map((e) => e.id),
  );
  const missing = templates.filter((t) => !existing.has(t.id));
  if (!missing.length) return 0;
  const now = nowIso();
  await db.batch([
    auditInsert(db, { actorUserId: actor, action: 'expense.recurring_draft', entity: 'expense_month', entityId: m, after: { count: missing.length } }),
    ...missing.map((t) =>
      db
        .insert(expenses)
        .values({
          id: crypto.randomUUID(),
          categoryId: t.categoryId,
          date: recurringDate(m, t.dayOfMonth),
          amount: t.amount,
          description: t.description,
          status: 'pending',
          recurringExpenseId: t.id,
          recurringMonth: m,
          createdAt: now,
          createdBy: actor,
        })
        .onConflictDoNothing(),
    ),
  ]);
  return missing.length;
}

async function royaltyFigures(db: Db, m: Month) {
  const { start, end } = monthRange(m);
  const [svc, vouchers] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${sales.serviceAmount}), 0)` })
      .from(sales)
      .where(and(eq(sales.status, 'paid'), gte(sales.businessDay, start), lte(sales.businessDay, end)))
      .get(),
    db
      .select({ total: sql<number>`coalesce(sum(${voucherSales.total}), 0)` })
      .from(voucherSales)
      .where(and(eq(voucherSales.status, 'paid'), gte(voucherSales.businessDay, start), lte(voucherSales.businessDay, end)))
      .get(),
  ]);
  const past = await summaryTotals(db, start, end);
  const serviceSales = Number(svc?.total ?? 0) + past.services;
  const voucher = Number(vouchers?.total ?? 0) + past.voucher;
  return { start, end, serviceSales, voucherSales: voucher, grossSales: royaltyGross([serviceSales], [voucher]) };
}

/** The last rate used, or 3%. */
async function currentRoyaltyBp(db: Db) {
  const last = await db.select({ bp: royaltyStatements.bp }).from(royaltyStatements).orderBy(desc(royaltyStatements.month)).get();
  return last?.bp ?? DEFAULT_ROYALTY_BP;
}

/**
 * (Re)computes a finished month's Royalty draft and its pending Expense.
 * Returns null once that month's statement is confirmed.
 */
export async function draftRoyalty(db: Db, m: Month, actor: string | null, bp?: number) {
  const existing = await db.select().from(royaltyStatements).where(eq(royaltyStatements.month, m)).get();
  if (existing?.status === 'confirmed' || existing?.fixed) return null;
  const f = await royaltyFigures(db, m);
  const rate = bp ?? existing?.bp ?? (await currentRoyaltyBp(db));
  const statement = {
    month: m,
    monthStart: f.start,
    monthEnd: f.end,
    serviceSales: f.serviceSales,
    voucherSales: f.voucherSales,
    grossSales: f.grossSales,
    bp: rate,
    amount: royaltyAmount(f.grossSales, rate),
    status: 'draft' as const,
    computedAt: nowIso(),
  };
  const description = `Royalty ${f.start} to ${f.end}: ${rate / 100}% of ${peso(f.grossSales)}`;
  const expense = await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.royaltyMonth, m)).get();
  await db.batch([
    auditInsert(db, { actorUserId: actor, action: 'royalty.draft', entity: 'royalty_statement', entityId: m, before: existing, after: statement }),
    db.insert(royaltyStatements).values(statement).onConflictDoUpdate({ target: royaltyStatements.month, set: statement }),
    expense
      ? db.update(expenses).set({ amount: statement.amount, description, date: f.end }).where(eq(expenses.id, expense.id))
      : db.insert(expenses).values({
          id: crypto.randomUUID(),
          categoryId: 'royalty',
          date: f.end,
          amount: statement.amount,
          description,
          status: 'pending',
          royaltyMonth: m,
          createdAt: nowIso(),
          createdBy: actor,
        }),
  ]);
  return statement;
}

/**
 * (Re)computes a month's Employer Contributions draft from everyone's bracket.
 * Returns null once that month's Expense is confirmed.
 */
export async function draftContributions(db: Db, m: Month, actor: string | null) {
  const [people, rates, existing] = await Promise.all([
    db.select().from(staff).where(eq(staff.active, true)),
    contributionRates(db),
    db.select().from(expenses).where(eq(expenses.contributionsMonth, m)).get(),
  ]);
  if (existing?.status === 'confirmed') return null;
  const shares = people.map((p) => ({ name: p.displayName, c: contributionsOf(p, rates) })).filter((x) => x.c && x.c.er > 0);
  const amount = shares.reduce((s, x) => s + x.c!.er, 0);
  if (!amount && !existing) return 0;
  const { end } = monthRange(m);
  const description = `Employer SSS, PhilHealth and Pag-IBIG for ${m}: ${shares.map((x) => `${x.name} ${peso(x.c!.er)}`).join(', ') || 'nobody'}`;
  await db.batch([
    existing
      ? db.update(expenses).set({ amount, description, date: end }).where(eq(expenses.id, existing.id))
      : db.insert(expenses).values({
          id: crypto.randomUUID(),
          categoryId: 'employer-contributions',
          date: end,
          amount,
          description,
          status: 'pending',
          contributionsMonth: m,
          createdAt: nowIso(),
          createdBy: actor,
        }),
    auditInsert(db, { actorUserId: actor, action: 'contributions.draft', entity: 'expense_month', entityId: m, after: { amount } }),
  ]);
  return amount;
}

/** The daily job: this month's recurring drafts and last month's Royalty draft. Idempotent. */
export async function monthlyJobs(db: Db, now = new Date()) {
  const thisMonth = monthOf(businessDayOf(now));
  const drafted = await draftRecurring(db, thisMonth, null);
  await draftContributions(db, thisMonth, null);
  const last = previousMonth(thisMonth);
  const hasRoyalty = await db.select({ month: royaltyStatements.month }).from(royaltyStatements).where(eq(royaltyStatements.month, last)).get();
  if (!hasRoyalty) await draftRoyalty(db, last, null);
  return { drafted, royaltyMonth: hasRoyalty ? null : last };
}

export const expenseRoutes = new Hono<AuthedEnv>()
  .use('/expenses', requireAuth, requireCapability('expenses.manage'))
  .use('/expenses/*', requireAuth, requireCapability('expenses.manage'))
  .use('/royalty', requireAuth, requireCapability('royalty.manage'))
  .use('/royalty/*', requireAuth, requireCapability('royalty.manage'))

  // --------------------------------------------------------------- Categories

  .get('/expenses/categories', async (c) => {
    return c.json({ categories: await c.var.db.select().from(expenseCategories).orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name)) });
  })
  .post('/expenses/categories', zValidator('json', z.object({ name }), invalidInput), async (c) => {
    const db = c.var.db;
    const { name: n } = c.req.valid('json');
    const dup = await db.select({ id: expenseCategories.id }).from(expenseCategories).where(sql`lower(${expenseCategories.name}) = lower(${n})`).get();
    if (dup) return fail(c, 409, 'duplicate', 'That category already exists.');
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(expenseCategories).values({ id, name: n, sortOrder: 150 }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'expense_category.create', entity: 'expense_category', entityId: id, after: { name: n } }),
    ]);
    return c.json({ id }, 201);
  })
  .patch('/expenses/categories/:id', zValidator('json', z.object({ name: name.optional(), active: z.boolean().optional() }), invalidInput), async (c) => {
    const db = c.var.db;
    const before = await db.select().from(expenseCategories).where(eq(expenseCategories.id, c.req.param('id'))).get();
    if (!before) return fail(c, 404, 'not_found', 'Category not found.');
    if (before.id === 'royalty' && c.req.valid('json').active === false) return fail(c, 409, 'royalty', 'Royalty is always needed.');
    await db.batch([
      db.update(expenseCategories).set(c.req.valid('json')).where(eq(expenseCategories.id, before.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'expense_category.update', entity: 'expense_category', entityId: before.id, before, after: c.req.valid('json') }),
    ]);
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- Recurring

  .get('/expenses/recurring', async (c) => {
    return c.json({ recurring: await c.var.db.select().from(recurringExpenses).orderBy(asc(recurringExpenses.dayOfMonth)) });
  })
  .post('/expenses/recurring', zValidator('json', recurringFields, invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(recurringExpenses).values({ id, ...input, createdAt: nowIso(), createdBy: c.var.user.id }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'recurring_expense.create', entity: 'recurring_expense', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })
  .patch('/expenses/recurring/:id', zValidator('json', recurringFields.partial(), invalidInput), async (c) => {
    const db = c.var.db;
    const before = await db.select().from(recurringExpenses).where(eq(recurringExpenses.id, c.req.param('id'))).get();
    if (!before) return fail(c, 404, 'not_found', 'Recurring expense not found.');
    await db.batch([
      db.update(recurringExpenses).set(c.req.valid('json')).where(eq(recurringExpenses.id, before.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'recurring_expense.update', entity: 'recurring_expense', entityId: before.id, before, after: c.req.valid('json') }),
    ]);
    return c.json({ ok: true });
  })
  /** Normally done by the daily job; also available on demand. */
  /** Recomputes a month's Employer Contributions draft, e.g. after changing someone's salary basis. */
  .post('/expenses/contributions/draft', zValidator('json', z.object({ month }), invalidInput), async (c) => {
    const amount = await draftContributions(c.var.db, c.req.valid('json').month, c.var.user.id);
    if (amount === null) return fail(c, 409, 'confirmed', 'That month’s employer contributions are already confirmed.');
    return c.json({ amount });
  })
  .post('/expenses/recurring/draft', zValidator('json', z.object({ month }), invalidInput), async (c) => {
    return c.json({ drafted: await draftRecurring(c.var.db, c.req.valid('json').month, c.var.user.id) });
  })

  // ----------------------------------------------------------------- Expenses

  /** A month's spending: recorded Expenses, drawer Cash-outs and inventory purchases, each counted once. */
  .get('/expenses', zValidator('query', z.object({ month }), invalidInput), async (c) => {
    const db = c.var.db;
    const { start, end } = monthRange(c.req.valid('query').month);
    const [rows, outs, purchases] = await Promise.all([
      db
        .select()
        .from(expenses)
        .where(and(gte(expenses.date, start), lte(expenses.date, end)))
        .orderBy(asc(expenses.date), asc(expenses.createdAt)),
      db
        .select()
        .from(cashOuts)
        .where(
          and(
            gte(cashOuts.businessDay, start),
            lte(cashOuts.businessDay, end),
            notInArray(cashOuts.category, [...PAYROLL_CASH_OUTS]),
            sql`not exists (select 1 from ${stockIns} where ${stockIns.cashOutId} = ${cashOuts.id})`,
          ),
        )
        .orderBy(asc(cashOuts.businessDay), asc(cashOuts.createdAt)),
      db
        .select({
          id: stockIns.id,
          date: stockIns.purchaseDate,
          qty: stockIns.qty,
          unitPrice: stockIns.unitPrice,
          cashOutId: stockIns.cashOutId,
          itemName: items.name,
          unit: items.unit,
          vendorName: vendors.name,
        })
        .from(stockIns)
        .innerJoin(items, eq(items.id, stockIns.itemId))
        .leftJoin(vendors, eq(vendors.id, stockIns.vendorId))
        .where(and(eq(stockIns.kind, 'purchase'), gte(stockIns.purchaseDate, start), lte(stockIns.purchaseDate, end)))
        .orderBy(asc(stockIns.purchaseDate)),
    ]);
    const purchaseLines = purchases.map((p) => ({ ...p, total: p.qty * (p.unitPrice ?? 0), fromDrawer: p.cashOutId !== null }));
    const sum = (xs: { amount?: number; total?: number }[]) => xs.reduce((s, x) => s + (x.amount ?? x.total ?? 0), 0);
    return c.json({
      start,
      end,
      expenses: rows,
      cashOuts: outs,
      purchases: purchaseLines,
      totals: {
        confirmed: sum(rows.filter((r) => r.status === 'confirmed')),
        pending: sum(rows.filter((r) => r.status === 'pending')),
        cashOuts: sum(outs),
        purchases: sum(purchaseLines),
      },
    });
  })

  .post('/expenses', zValidator('json', expenseFields, invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const cat = await db.select().from(expenseCategories).where(eq(expenseCategories.id, input.categoryId)).get();
    if (!cat?.active) return fail(c, 404, 'not_found', 'Category not found.');
    if (cat.id === 'royalty') return fail(c, 409, 'royalty', 'Royalty is computed under Royalty, not entered here.');
    const id = crypto.randomUUID();
    const now = nowIso();
    const row = { id, ...input, status: 'confirmed' as const, createdAt: now, createdBy: c.var.user.id, confirmedAt: now, confirmedBy: c.var.user.id };
    await db.batch([db.insert(expenses).values(row), auditInsert(db, { actorUserId: c.var.user.id, action: 'expense.create', entity: 'expense', entityId: id, after: row })]);
    return c.json({ id }, 201);
  })

  .patch('/expenses/:id', zValidator('json', expenseFields.partial(), invalidInput), async (c) => {
    const db = c.var.db;
    const before = await db.select().from(expenses).where(eq(expenses.id, c.req.param('id'))).get();
    if (!before) return fail(c, 404, 'not_found', 'Expense not found.');
    if (before.royaltyMonth) return fail(c, 409, 'royalty', 'Recompute the Royalty statement instead.');
    const input = c.req.valid('json');
    await db.batch([
      db.update(expenses).set(input).where(eq(expenses.id, before.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'expense.update', entity: 'expense', entityId: before.id, before, after: input }),
    ]);
    return c.json({ ok: true });
  })

  /** A drafted (recurring) expense was actually paid. */
  .post('/expenses/:id/confirm', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(expenses).where(eq(expenses.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Expense not found.');
    if (row.royaltyMonth) return fail(c, 409, 'royalty', 'Confirm it from the Royalty statement.');
    if (row.status === 'confirmed') return fail(c, 409, 'confirmed', 'Already confirmed.');
    await db.batch([
      db.update(expenses).set({ status: 'confirmed', confirmedAt: nowIso(), confirmedBy: c.var.user.id }).where(eq(expenses.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'expense.confirm', entity: 'expense', entityId: row.id }),
    ]);
    return c.json({ ok: true });
  })

  .delete('/expenses/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(expenses).where(eq(expenses.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Expense not found.');
    if (row.royaltyMonth) return fail(c, 409, 'royalty', 'The Royalty expense follows its statement.');
    await db.batch([db.delete(expenses).where(eq(expenses.id, row.id)), auditInsert(db, { actorUserId: c.var.user.id, action: 'expense.delete', entity: 'expense', entityId: row.id, before: row })]);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ Royalty

  .get('/royalty', async (c) => {
    const db = c.var.db;
    const statements = await db.select().from(royaltyStatements).orderBy(desc(royaltyStatements.month)).limit(24);
    const thisMonth = monthOf(businessDayOf(new Date()));
    // This month so far, for a running figure.
    const f = await royaltyFigures(db, thisMonth);
    const bp = await currentRoyaltyBp(db);
    return c.json({ statements, current: { month: thisMonth, ...f, bp, amount: royaltyAmount(f.grossSales, bp) } });
  })

  .post('/royalty/:month/compute', zValidator('param', z.object({ month })), zValidator('json', z.object({ bp: basisPoints.refine((v) => v > 0).optional() }), invalidInput), async (c) => {
    const m = c.req.valid('param').month;
    if (businessDayOf(new Date()) <= monthRange(m).end) return fail(c, 409, 'month_not_over', 'That month is not over yet.');
    const statement = await draftRoyalty(c.var.db, m, c.var.user.id, c.req.valid('json').bp);
    if (!statement) return fail(c, 409, 'confirmed', 'This statement is confirmed or came from your records, so it can’t be recomputed.');
    return c.json({ statement });
  })

  /** Paid to the franchisor: the statement and its Expense are final. */
  .post('/royalty/:month/confirm', zValidator('param', z.object({ month })), async (c) => {
    const db = c.var.db;
    const m = c.req.valid('param').month;
    const row = await db.select().from(royaltyStatements).where(eq(royaltyStatements.month, m)).get();
    if (!row) return fail(c, 404, 'not_found', 'Compute the statement first.');
    if (row.status === 'confirmed') return fail(c, 409, 'confirmed', 'Already confirmed.');
    const now = nowIso();
    await db.batch([
      db.update(royaltyStatements).set({ status: 'confirmed', confirmedAt: now, confirmedBy: c.var.user.id }).where(eq(royaltyStatements.month, m)),
      db.update(expenses).set({ status: 'confirmed', confirmedAt: now, confirmedBy: c.var.user.id }).where(eq(expenses.royaltyMonth, m)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'royalty.confirm', entity: 'royalty_statement', entityId: m, after: { amount: row.amount } }),
    ]);
    return c.json({ ok: true });
  });
