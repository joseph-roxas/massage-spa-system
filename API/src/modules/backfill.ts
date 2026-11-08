import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { monthRange } from '@spa/domain';
import { dailySummaries, expenses, pastMonths, pastPayslips, pastTherapistWeeks, percentageTaxFilings, royaltyStatements, sales, staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { centavos, isoDate } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-01.');
const count = z.number().int().min(0).max(100_000);

const dayFields = z.object({
  cash: centavos,
  gcash: centavos,
  oil: centavos,
  voucher: centavos,
  foc: centavos,
  commission: centavos,
  guests: count,
  therapists: count,
  rejects: count,
  laundry: centavos,
  expenses: centavos,
});

const monthBody = z.object({
  days: z.array(dayFields.extend({ date: isoDate })).min(1).max(31),
  receptionistPay: centavos,
  expenses: z.array(z.object({ categoryId: z.string().min(1), description: z.string().trim().min(1).max(200), amount: centavos })).max(20),
  royalty: z.object({ serviceSales: centavos, voucherSales: centavos, grossSales: centavos, bp: z.number().int().min(0).max(10_000), amount: centavos, paid: z.boolean() }).nullable(),
});

const filingsBody = z.object({
  filings: z.array(z.object({ quarter: z.string().regex(/^\d{4}-Q[1-4]$/), grossSales: centavos, amountPaid: centavos, filedOn: isoDate })).max(8),
});

const weeksBody = z.object({
  rows: z
    .array(z.object({ weekStart: isoDate, staffId: z.string().min(1), gross: centavos, daysWorked: z.number().int().min(0).max(7), net: z.number().int().min(-10_000_000).max(100_000_000) }))
    .min(1)
    .max(100),
});

const payslipsBody = z.object({
  staffId: z.string().min(1),
  payslips: z
    .array(
      z.object({
        weekStart: isoDate,
        weekEnd: isoDate,
        paidOn: isoDate.nullable(),
        dailyRate: centavos,
        daysWorked: z.number().int().min(0).max(8),
        basic: centavos,
        overtimeHours: count,
        overtimePay: centavos,
        premiumPay: centavos,
        lateUndertime: centavos,
        sss: centavos,
        hdmf: centavos,
        phic: centavos,
        caRepayment: centavos,
        gross: centavos,
        net: z.number().int().min(-10_000_000).max(100_000_000),
        caBalance: centavos.nullable(),
        days: z.array(z.object({ date: isoDate, worked: z.boolean(), timeIn: z.string().nullable(), timeOut: z.string().nullable(), hours: z.number(), lateHours: z.number(), overtimeHours: z.number(), note: z.string().max(200).nullable() })).max(16),
      }),
    )
    .min(1)
    .max(60),
});

/** Days already run on the system, which a Daily Summary must never overlap (ADR 0006). */
async function daysWithSales(db: AuthedEnv['Variables']['db'], from: string, to: string) {
  const rows = await db
    .selectDistinct({ day: sales.businessDay })
    .from(sales)
    .where(and(eq(sales.status, 'paid'), gte(sales.businessDay, from), lte(sales.businessDay, to)));
  return new Set(rows.map((r) => r.day));
}

/** Everything before Go-live: the owner's records, kept apart from real Sales and Payrolls. */
export const backfillRoutes = new Hono<AuthedEnv>()
  .use('/backfill/*', requireAuth, requireCapability('settings.manage'))
  .use('/daily-summaries/*', requireAuth, requireCapability('settings.manage'))
  .use('/past-payslips', requireAuth)
  .use('/past-payslips/*', requireAuth)

  /** What has been loaded so far. */
  .get('/backfill/status', async (c) => {
    const db = c.var.db;
    const [months, weeks, slips, filings] = await Promise.all([
      db
        .select({
          month: sql<string>`substr(${dailySummaries.date}, 1, 7)`,
          days: sql<number>`count(*)`,
          received: sql<number>`sum(${dailySummaries.cash} + ${dailySummaries.gcash} + ${dailySummaries.voucher} - ${dailySummaries.foc})`,
        })
        .from(dailySummaries)
        .groupBy(sql`substr(${dailySummaries.date}, 1, 7)`)
        .orderBy(sql`substr(${dailySummaries.date}, 1, 7)`),
      db.select({ n: sql<number>`count(distinct ${pastTherapistWeeks.weekStart})` }).from(pastTherapistWeeks).get(),
      db.select({ n: sql<number>`count(*)` }).from(pastPayslips).get(),
      db.select({ n: sql<number>`count(*)` }).from(percentageTaxFilings).get(),
    ]);
    return c.json({ months, therapistWeeks: Number(weeks?.n ?? 0), pastPayslips: Number(slips?.n ?? 0), filings: Number(filings?.n ?? 0) });
  })

  /** One month from the workbook, replacing what was loaded for it before. */
  .put('/backfill/months/:month', zValidator('param', z.object({ month })), zValidator('json', monthBody, invalidInput), async (c) => {
    const db = c.var.db;
    const m = c.req.valid('param').month;
    const input = c.req.valid('json');
    const { start, end } = monthRange(m);
    if (input.days.some((d) => d.date < start || d.date > end)) return fail(c, 400, 'wrong_month', `Every day must be in ${m}.`);
    const real = await daysWithSales(db, start, end);
    const clash = input.days.filter((d) => real.has(d.date)).map((d) => d.date);
    if (clash.length) return fail(c, 409, 'has_sales', `These days already have real sales: ${clash.join(', ')}.`);

    const now = nowIso();
    const by = c.var.user.id;
    const statement = await db.select().from(royaltyStatements).where(eq(royaltyStatements.month, m)).get();
    const royalty = input.royalty && !(statement?.status === 'confirmed' && !statement.fixed) ? input.royalty : null;
    const status = royalty?.paid ? ('confirmed' as const) : ('draft' as const);
    const royaltyValues = royalty && {
      month: m,
      monthStart: start,
      monthEnd: end,
      serviceSales: royalty.serviceSales,
      voucherSales: royalty.voucherSales,
      grossSales: royalty.grossSales,
      bp: royalty.bp,
      amount: royalty.amount,
      fixed: true,
      status,
      computedAt: now,
      confirmedAt: royalty.paid ? now : null,
      confirmedBy: royalty.paid ? by : null,
    };
    await db.batch([
      auditInsert(db, { actorUserId: by, action: 'backfill.month', entity: 'backfill_month', entityId: m, after: { days: input.days.length, receptionistPay: input.receptionistPay, expenses: input.expenses, royalty: input.royalty } }),
      db.delete(dailySummaries).where(and(gte(dailySummaries.date, start), lte(dailySummaries.date, end))),
      db.delete(expenses).where(eq(expenses.backfillMonth, m)),
      ...(royaltyValues ? [db.delete(expenses).where(eq(expenses.royaltyMonth, m))] : []),
      ...input.days.map((d) => db.insert(dailySummaries).values({ ...d, updatedAt: now, updatedBy: by })),
      db
        .insert(pastMonths)
        .values({ month: m, receptionistPay: input.receptionistPay, updatedAt: now, updatedBy: by })
        .onConflictDoUpdate({ target: pastMonths.month, set: { receptionistPay: input.receptionistPay, updatedAt: now, updatedBy: by } }),
      ...input.expenses.map((e) =>
        db.insert(expenses).values({ id: crypto.randomUUID(), categoryId: e.categoryId, date: end, amount: e.amount, description: e.description, status: 'confirmed', backfillMonth: m, createdAt: now, createdBy: by, confirmedAt: now, confirmedBy: by }),
      ),
      ...(royaltyValues
        ? [
            db.insert(royaltyStatements).values(royaltyValues).onConflictDoUpdate({ target: royaltyStatements.month, set: royaltyValues }),
            db.insert(expenses).values({
              id: crypto.randomUUID(),
              categoryId: 'royalty',
              date: end,
              amount: royaltyValues.amount,
              description: `Royalty ${m}`,
              status: royalty!.paid ? 'confirmed' : 'pending',
              royaltyMonth: m,
              backfillMonth: m,
              createdAt: now,
              createdBy: by,
              confirmedAt: royaltyValues.confirmedAt,
              confirmedBy: royaltyValues.confirmedBy,
            }),
          ]
        : []),
    ]);
    return c.json({ ok: true });
  })

  /** 2551Q filings already paid; their cost is in the month's BIR Expense. A filing made in the system stays as it is. */
  .put('/backfill/filings', zValidator('json', filingsBody, invalidInput), async (c) => {
    const db = c.var.db;
    const { filings } = c.req.valid('json');
    const existing = await db.select({ quarter: percentageTaxFilings.quarter, expenseId: percentageTaxFilings.expenseId }).from(percentageTaxFilings);
    const inSystem = new Set(existing.filter((f) => f.expenseId).map((f) => f.quarter));
    const now = nowIso();
    const fresh = filings.filter((f) => !inSystem.has(f.quarter));
    if (fresh.length) {
      await db.batch(
        fresh.map((f) => {
          const values = { quarter: f.quarter, grossSales: f.grossSales, computed: f.amountPaid, amountPaid: f.amountPaid, filedOn: f.filedOn, createdAt: now, createdBy: c.var.user.id };
          return db.insert(percentageTaxFilings).values(values).onConflictDoUpdate({ target: percentageTaxFilings.quarter, set: values });
        }) as [never, ...never[]],
      );
    }
    return c.json({ saved: fresh.length, skipped: filings.filter((f) => inSystem.has(f.quarter)).map((f) => f.quarter) });
  })

  /** Weekly Commission per Therapist, for the Year-end Bonus and opening balances. */
  .put('/backfill/therapist-weeks', zValidator('json', weeksBody, invalidInput), async (c) => {
    const db = c.var.db;
    const { rows } = c.req.valid('json');
    const now = nowIso();
    await db.batch(
      rows.map((r) => {
        const values = { id: crypto.randomUUID(), ...r, createdAt: now };
        return db
          .insert(pastTherapistWeeks)
          .values(values)
          .onConflictDoUpdate({ target: [pastTherapistWeeks.weekStart, pastTherapistWeeks.staffId], set: { gross: r.gross, daysWorked: r.daysWorked, net: r.net } });
      }) as [never, ...never[]],
    );
    return c.json({ saved: rows.length });
  })

  /** The Receptionist's Past Payslips, stored exactly as recorded. */
  .put('/backfill/past-payslips', zValidator('json', payslipsBody, invalidInput), async (c) => {
    const db = c.var.db;
    const { staffId, payslips } = c.req.valid('json');
    const person = await db.select({ id: staff.id }).from(staff).where(eq(staff.id, staffId)).get();
    if (!person) return fail(c, 404, 'not_found', 'Staff member not found.');
    const now = nowIso();
    await db.batch(
      payslips.map(({ days, ...p }) => {
        const values = { ...p, daysJson: JSON.stringify(days) };
        return db
          .insert(pastPayslips)
          .values({ id: crypto.randomUUID(), staffId, ...values, createdAt: now })
          .onConflictDoUpdate({ target: [pastPayslips.staffId, pastPayslips.weekStart], set: values });
      }) as [never, ...never[]],
    );
    return c.json({ saved: payslips.length });
  })

  .get('/daily-summaries/:date', zValidator('param', z.object({ date: isoDate })), async (c) => {
    const row = await c.var.db.select().from(dailySummaries).where(eq(dailySummaries.date, c.req.valid('param').date)).get();
    return c.json({ summary: row ?? null });
  })

  /** One day added or fixed by hand, e.g. Nov 1–7. */
  .put('/daily-summaries/:date', zValidator('param', z.object({ date: isoDate })), zValidator('json', dayFields, invalidInput), async (c) => {
    const db = c.var.db;
    const { date } = c.req.valid('param');
    if ((await daysWithSales(db, date, date)).size) return fail(c, 409, 'has_sales', 'This day has real sales, so it can’t have a Daily Summary.');
    const values = { ...c.req.valid('json'), updatedAt: nowIso(), updatedBy: c.var.user.id };
    const before = await db.select().from(dailySummaries).where(eq(dailySummaries.date, date)).get();
    await db.batch([
      db.insert(dailySummaries).values({ date, ...values }).onConflictDoUpdate({ target: dailySummaries.date, set: values }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'daily_summary.save', entity: 'daily_summary', entityId: date, before: before ?? null, after: values }),
    ]);
    return c.json({ ok: true });
  })

  .delete('/daily-summaries/:date', zValidator('param', z.object({ date: isoDate })), async (c) => {
    const db = c.var.db;
    const { date } = c.req.valid('param');
    const before = await db.select().from(dailySummaries).where(eq(dailySummaries.date, date)).get();
    if (!before) return fail(c, 404, 'not_found', 'No Daily Summary for that day.');
    await db.batch([
      db.delete(dailySummaries).where(eq(dailySummaries.date, date)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'daily_summary.delete', entity: 'daily_summary', entityId: date, before }),
    ]);
    return c.json({ ok: true });
  })

  /** Every Past Payslip, for the Super Admin. */
  .get('/past-payslips', requireCapability('settings.manage'), async (c) => {
    const rows = await c.var.db
      .select({ id: pastPayslips.id, weekStart: pastPayslips.weekStart, weekEnd: pastPayslips.weekEnd, paidOn: pastPayslips.paidOn, net: pastPayslips.net, displayName: staff.displayName })
      .from(pastPayslips)
      .innerJoin(staff, eq(staff.id, pastPayslips.staffId))
      .orderBy(desc(pastPayslips.weekStart));
    return c.json({ payslips: rows });
  })

  /** One Past Payslip: the Super Admin, or the person it belongs to. */
  .get('/past-payslips/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select({ slip: pastPayslips, fullName: sql<string>`${staff.firstName} || ' ' || ${staff.lastName}`, userId: staff.userId }).from(pastPayslips).innerJoin(staff, eq(staff.id, pastPayslips.staffId)).where(eq(pastPayslips.id, c.req.param('id'))).get();
    const allowed = row && (row.userId === c.var.user.id || c.var.user.role === 'super_admin');
    if (!allowed) return fail(c, 404, 'not_found', 'Payslip not found.');
    const { daysJson, ...slip } = row.slip;
    return c.json({ payslip: { ...slip, fullName: row.fullName, days: JSON.parse(daysJson) as unknown[] } });
  });

/** A person's Past Payslips, newest first, for My Pay. */
export function pastPayslipsOf(db: AuthedEnv['Variables']['db'], staffId: string) {
  return db
    .select({ id: pastPayslips.id, weekStart: pastPayslips.weekStart, weekEnd: pastPayslips.weekEnd, paidOn: pastPayslips.paidOn, net: pastPayslips.net })
    .from(pastPayslips)
    .where(eq(pastPayslips.staffId, staffId))
    .orderBy(desc(pastPayslips.weekStart));
}
