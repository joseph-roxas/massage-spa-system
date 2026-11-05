import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  businessDayOf,
  can,
  caRepaymentFor,
  cashAdvanceCap,
  commissionRateOn,
  daysOf,
  lastCompletedPayWeek,
  payLines,
  payWeekOf,
  receptionistDay,
  receptionistPayroll,
  therapistPayroll,
  thirteenthMonth,
  weekdayOf,
  yearEndBonus,
  type Capability,
  type PayrollTotals,
  type PayWeek,
  type ReceptionistDay,
  type ReceptionistRules,
  type TherapistDay,
} from '@spa/domain';
import {
  bonuses,
  businessDays,
  caLedger,
  cashAdvances,
  cashOuts,
  cashTransfers,
  commissionRates,
  dtr,
  holidays,
  payrollAdjustments,
  payrolls,
  PAYROLL_KINDS,
  sales,
  staff,
} from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor, requireOpenDay } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { contributionRates, weeklyDeductions } from '../lib/contributions';
import { currentTransferDay } from '../lib/sales-cash';
import { nowIso } from '../lib/time';
import { centavos, isoDate } from '../lib/validation';
import { receptionistRules, reliefDays } from '../lib/relief';
import { requireAuth, requireCapability } from '../auth/middleware';

type Db = DrizzleD1Database;
type Staff = typeof staff.$inferSelect;
type PayrollRow = typeof payrolls.$inferSelect;
type Kind = (typeof PAYROLL_KINDS)[number];

const weekStart = isoDate.refine((d) => weekdayOf(d) === 0, 'A Pay Week starts on a Sunday.');
const weekParam = z.object({ start: weekStart });
const year = z.number().int().min(2020).max(2100);

/** Who may see and prepare each kind of Payroll, and who approves it. */
const PREPARE: Record<Kind, Capability> = { therapist: 'payroll.therapist.generate', receptionist: 'payroll.receptionist.manage', reliever: 'payroll.receptionist.manage' };
const APPROVE: Record<Kind, Capability> = { therapist: 'payroll.therapist.approve', receptionist: 'payroll.receptionist.manage', reliever: 'payroll.receptionist.manage' };
// Outside Relievers take no Cash Advances; the entry is only there to complete the map.
const ADVANCE: Record<Kind, Capability> = { therapist: 'cash_advance.therapist', receptionist: 'payroll.receptionist.manage', reliever: 'payroll.receptionist.manage' };

const kindOf = (s: Staff): Kind => s.kind;
const today = () => businessDayOf(new Date());

/** Relief pay per day for a person's closed Relief Shifts in a Pay Week. */
async function reliefWeek(db: Db, person: Staff, week: PayWeek) {
  const entries = await db
    .select()
    .from(dtr)
    .where(and(eq(dtr.staffId, person.id), eq(dtr.isRelief, true), gte(dtr.businessDay, week.start), lte(dtr.businessDay, week.end)));
  return reliefDays(db, entries);
}

/** Σ of the ledger: opening + advances − repayments. */
async function caBalances(db: Db, staffIds?: string[]) {
  const rows = await db
    .select({ staffId: caLedger.staffId, balance: sql<number>`sum(case when ${caLedger.entry} = 'repayment' then -${caLedger.amount} else ${caLedger.amount} end)` })
    .from(caLedger)
    .where(staffIds ? inArray(caLedger.staffId, staffIds) : undefined)
    .groupBy(caLedger.staffId);
  return new Map(rows.map((r) => [r.staffId, Number(r.balance)]));
}

async function caBalance(db: Db, staffId: string) {
  return (await caBalances(db, [staffId])).get(staffId) ?? 0;
}

/** Each person's Adjustments for a Pay Week. */
async function adjustmentsFor(db: Db, weekStart: string, staffIds?: string[]) {
  const rows = await db
    .select()
    .from(payrollAdjustments)
    .where(and(eq(payrollAdjustments.weekStart, weekStart), staffIds ? inArray(payrollAdjustments.staffId, staffIds) : undefined))
    .orderBy(asc(payrollAdjustments.createdAt));
  const byStaff = new Map<string, typeof rows>();
  for (const r of rows) byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);
  return byStaff;
}

const sumOf = (rows: readonly { amount: number }[] | undefined) => (rows ?? []).reduce((s, r) => s + r.amount, 0);

/** A Therapist's week as it stands now, from sales, DTR and CAs taken against it. */
async function therapistWeek(db: Db, person: Staff, week: PayWeek) {
  const [sold, worked, advances, rates, commissionRows, adjustments, relief] = await Promise.all([
    db
      .select({ businessDay: sales.businessDay, amount: sales.commissionAmount, regularPrice: sales.regularPrice, isHoliday: sales.isHoliday })
      .from(sales)
      .where(and(eq(sales.therapistId, person.id), eq(sales.status, 'paid'), gte(sales.businessDay, week.start), lte(sales.businessDay, week.end))),
    db
      .selectDistinct({ day: dtr.businessDay })
      .from(dtr)
      .where(and(eq(dtr.staffId, person.id), gte(dtr.businessDay, week.start), lte(dtr.businessDay, week.end))),
    db.select().from(cashAdvances).where(and(eq(cashAdvances.staffId, person.id), eq(cashAdvances.againstWeekStart, week.start))),
    contributionRates(db),
    db.select().from(commissionRates),
    adjustmentsFor(db, week.start, [person.id]),
    reliefWeek(db, person, week),
  ]);
  const taken = advances.reduce((s, a) => s + a.amount, 0);
  // What the Holiday rate added on top of the normal rate, for the Payslip.
  const commissions = sold.map((s) => {
    const rate = s.isHoliday ? commissionRateOn(commissionRows, person.therapistClass ?? 'regular', s.businessDay) : undefined;
    const normal = rate ? Math.round((s.regularPrice * rate.normalBp) / 10_000) : s.amount;
    return { businessDay: s.businessDay, amount: s.amount, holidayExtra: Math.max(0, s.amount - normal) };
  });
  const pay = therapistPayroll({
    week,
    commissions,
    daysWorked: worked.map((w) => w.day),
    gov: weeklyDeductions(person, rates, week.end),
    cashAdvances: taken,
    adjustments: sumOf(adjustments.get(person.id)),
    relief: relief.map((d) => ({ date: d.date, pay: d.total })),
  });
  return { pay, taken, advances };
}

/** The Receptionist's days, or the first DTR entry still missing its clock-out. */
async function receptionistDays(db: Db, person: Staff, week: PayWeek, rules: ReceptionistRules) {
  const [entries, hols, days] = await Promise.all([
    db
      .select()
      .from(dtr)
      .where(and(eq(dtr.staffId, person.id), gte(dtr.businessDay, week.start), lte(dtr.businessDay, week.end))),
    db.select().from(holidays).where(and(gte(holidays.date, week.start), lte(holidays.date, week.end))),
    db.select().from(businessDays).where(and(gte(businessDays.date, week.start), lte(businessDays.date, week.end))),
  ]);
  const open = entries.find((e) => !e.clockOut);
  if (open) return { openEntryDay: open.businessDay };
  const result: ReceptionistDay[] = daysOf(week).map((date) => {
    const bd = days.find((d) => d.date === date);
    return receptionistDay({
      date,
      holiday: hols.find((h) => h.date === date)?.type ?? null,
      entries: entries.filter((e) => e.businessDay === date).map((e) => ({ clockIn: new Date(e.clockIn), clockOut: new Date(e.clockOut!) })),
      earlyCloseAt: bd?.earlyCloseStatus === 'recorded' && bd.earlyCloseAt ? new Date(bd.earlyCloseAt) : null,
      dailyRate: person.dailyRate ?? 0,
      rules,
    });
  });
  return { days: result };
}

/**
 * Which week a Therapist's CA counts against: last week while its Payroll is
 * still unapproved, otherwise this week.
 */
async function caTargetWeek(db: Db, staffId: string): Promise<PayWeek> {
  const last = lastCompletedPayWeek(today());
  const row = await db.select({ status: payrolls.status }).from(payrolls).where(and(eq(payrolls.staffId, staffId), eq(payrolls.weekStart, last.start))).get();
  return !row || row.status === 'draft' ? last : payWeekOf(today());
}

async function therapistCap(db: Db, person: Staff) {
  const week = await caTargetWeek(db, person.id);
  const { pay, taken } = await therapistWeek(db, person, week);
  const netBefore = pay.net + taken;
  return { week, net: netBefore, taken, cap: cashAdvanceCap(netBefore, taken) };
}

function canSee(c: Context<AuthedEnv>, kind: Kind) {
  return can(c.var.user.role, PREPARE[kind]);
}

/** Payrolls with names, days, Adjustments and Payslip lines. Adjustment reasons only `withReasons`. */
const withNames = async (db: Db, rows: PayrollRow[], withReasons = false) => {
  const ids = [...new Set(rows.map((r) => r.staffId))];
  const weeks = [...new Set(rows.map((r) => r.weekStart))];
  const [people, adjustments] = await Promise.all([
    ids.length ? db.select().from(staff).where(inArray(staff.id, ids)) : Promise.resolve([]),
    Promise.all(weeks.map(async (w) => [w, await adjustmentsFor(db, w, ids)] as const)).then((xs) => new Map(xs)),
  ]);
  return rows.map(({ breakdownJson, ...r }) => {
    const p = people.find((x) => x.id === r.staffId)!;
    const days = JSON.parse(breakdownJson) as (TherapistDay | ReceptionistDay)[];
    const adj = (adjustments.get(r.weekStart)?.get(r.staffId) ?? []).map((a) => ({ id: a.id, label: a.label, amount: a.amount, ...(withReasons ? { reason: a.reason } : {}) }));
    const lines = payLines({ ...(r as unknown as PayrollTotals), kind: r.kind, days, adjustments: sumOf(adj) } as Parameters<typeof payLines>[0]);
    return { ...r, displayName: p.displayName, fullName: `${p.firstName} ${p.lastName}`, therapistClass: p.therapistClass, days, adjustments: adj, lines };
  });
};

const adjustmentBody = z.object({
  label: z.string().trim().min(2).max(60),
  /** Signed centavos: negative takes pay off. */
  amount: z
    .number()
    .int()
    .min(-10_000_000)
    .max(10_000_000)
    .refine((n) => n !== 0, 'Enter an amount.'),
  reason: z.string().trim().min(3).max(300),
});

const generateBody = z.object({ kind: z.enum(PAYROLL_KINDS) });
const advanceBody = z.object({
  staffId: z.string().min(1),
  amount: z.number().int().min(100).max(10_000_000),
  fromDrawer: z.boolean().default(true),
  note: z.string().trim().max(200).optional(),
  /** Super Admin only: allow more than the cap. */
  override: z.boolean().default(false),
});

export const payrollRoutes = new Hono<AuthedEnv>()
  .use('/payroll/*', requireAuth)
  .use('/payrolls/*', requireAuth)
  .use('/cash-advances', requireAuth)
  .use('/cash-advances/*', requireAuth)
  .use('/bonuses', requireAuth)
  .use('/bonuses/*', requireAuth)
  .use('/me/*', requireAuth, requireCapability('payroll.view_own'))

  // ------------------------------------------------------------------ My Pay

  /** The logged-in staff member's released Payslips and Cash Advance history. */
  .get('/me/pay', async (c) => {
    const db = c.var.db;
    const person = await db.select().from(staff).where(eq(staff.userId, c.var.user.id)).get();
    if (!person) return c.json({ staff: null, payslips: [], ca: null });
    const [released, ledger, advances, balance] = await Promise.all([
      db
        .select({ id: payrolls.id, weekStart: payrolls.weekStart, net: payrolls.net, releasedAt: payrolls.releasedAt })
        .from(payrolls)
        .where(and(eq(payrolls.staffId, person.id), eq(payrolls.status, 'released')))
        .orderBy(desc(payrolls.weekStart)),
      db.select().from(caLedger).where(eq(caLedger.staffId, person.id)).orderBy(asc(caLedger.createdAt)),
      db.select().from(cashAdvances).where(eq(cashAdvances.staffId, person.id)),
      caBalance(db, person.id),
    ]);
    const weekOf = new Map(released.map((p) => [p.id, p.weekStart]));
    // Oldest first, as she would read a passbook.
    const entries = ledger.map((l) => ({
      id: l.id,
      entry: l.entry,
      amount: l.amount,
      date: advances.find((a) => a.id === l.cashAdvanceId)?.businessDay ?? l.createdAt.slice(0, 10),
      weekStart: l.payrollId ? (weekOf.get(l.payrollId) ?? null) : null,
    }));
    const owed = entries.filter((e) => e.entry !== 'repayment').reduce((s, e) => s + e.amount, 0);
    return c.json({
      staff: { displayName: person.displayName, kind: person.kind, dailyRate: person.dailyRate, caRepayment: person.caRepayment },
      payslips: released,
      ca: { entries, totalTaken: owed, totalRepaid: owed - balance, balance },
    });
  })

  .get('/me/payslips/:id', async (c) => {
    const db = c.var.db;
    const person = await db.select({ id: staff.id }).from(staff).where(eq(staff.userId, c.var.user.id)).get();
    const row = person
      ? await db
          .select()
          .from(payrolls)
          .where(and(eq(payrolls.id, c.req.param('id')), eq(payrolls.staffId, person.id), eq(payrolls.status, 'released')))
          .get()
      : undefined;
    if (!row) return fail(c, 404, 'not_found', 'Payslip not found.');
    const [payroll] = await withNames(db, [row]);
    return c.json({ payroll, week: payWeekOf(row.weekStart) });
  })

  /** A Pay Week: whether it can be generated yet and the Payrolls this user may see. */
  .get('/payroll/weeks/:start', zValidator('param', weekParam, invalidInput), async (c) => {
    const kinds = PAYROLL_KINDS.filter((k) => canSee(c, k));
    if (!kinds.length) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const db = c.var.db;
    const week = payWeekOf(c.req.valid('param').start);
    const [rows, unclosed] = await Promise.all([
      db.select().from(payrolls).where(and(eq(payrolls.weekStart, week.start), inArray(payrolls.kind, kinds))).orderBy(asc(payrolls.kind)),
      db
        .select({ date: businessDays.date })
        .from(businessDays)
        .where(and(gte(businessDays.date, week.start), lte(businessDays.date, week.end), isNull(businessDays.closedAt))),
    ]);
    const list = await withNames(db, rows, can(c.var.user.role, 'payroll.therapist.approve'));
    list.sort((a, b) => a.kind.localeCompare(b.kind) || a.displayName.localeCompare(b.displayName));
    return c.json({ week, ended: today() > week.end, unclosedDays: unclosed.map((d) => d.date), kinds, payrolls: list.map(({ days: _, ...r }) => r) });
  })

  /** (Re)computes the week's drafts. Approved and released Payrolls are left alone. */
  .post('/payroll/weeks/:start/generate', zValidator('param', weekParam, invalidInput), zValidator('json', generateBody, invalidInput), async (c) => {
    const { kind } = c.req.valid('json');
    if (!canSee(c, kind)) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const db = c.var.db;
    const week = payWeekOf(c.req.valid('param').start);
    if (today() <= week.end) return fail(c, 409, 'week_not_over', 'This Pay Week has not ended yet.');
    const unclosed = await db
      .select({ date: businessDays.date })
      .from(businessDays)
      .where(and(gte(businessDays.date, week.start), lte(businessDays.date, week.end), isNull(businessDays.closedAt)))
      .get();
    if (unclosed) return fail(c, 409, 'day_open', `The Business Day of ${unclosed.date} is not closed yet. Close it first.`);

    const [people, existing] = await Promise.all([
      db
        .select()
        .from(staff)
        .where(
          kind === 'therapist'
            ? and(eq(staff.kind, 'therapist'), eq(staff.isOnCall, false))
            : kind === 'reliever'
              ? and(eq(staff.kind, 'reliever'), eq(staff.reliefPay, 'weekly'))
              : eq(staff.kind, 'receptionist'),
        ),
      db.select().from(payrolls).where(and(eq(payrolls.weekStart, week.start), eq(payrolls.kind, kind))),
    ]);
    const fixed = new Set(existing.filter((p) => p.status !== 'draft').map((p) => p.staffId));
    const now = nowIso();
    const rows: (typeof payrolls.$inferInsert)[] = [];

    if (kind === 'reliever') {
      // Outside Relievers on long cover: Relief pay only, no Government Deductions or CAs.
      const adjustments = await adjustmentsFor(db, week.start);
      for (const person of people.filter((p) => !fixed.has(p.id))) {
        const days = await reliefWeek(db, person, week);
        if (!days.length) continue;
        const { basic, ...pay } = receptionistPayroll({ days, gov: { sss: 0, phic: 0, pagibig: 0 }, caRepayment: 0, adjustments: sumOf(adjustments.get(person.id)) });
        rows.push({ id: crypto.randomUUID(), weekStart: week.start, staffId: person.id, kind, ...pay, basic, breakdownJson: JSON.stringify(days), generatedAt: now, generatedBy: c.var.user.id });
      }
    } else if (kind === 'therapist') {
      for (const person of people.filter((p) => !fixed.has(p.id))) {
        const { pay, taken } = await therapistWeek(db, person, week);
        if (!pay.gross && !taken && pay.govSss === 0) continue; // nothing happened this week
        rows.push({ id: crypto.randomUUID(), weekStart: week.start, staffId: person.id, kind, ...pay, breakdownJson: JSON.stringify(pay.days), generatedAt: now, generatedBy: c.var.user.id });
      }
    } else {
      const rules = await receptionistRules(db);
      const balances = await caBalances(db);
      const rates = await contributionRates(db);
      const adjustments = await adjustmentsFor(db, week.start);
      for (const person of people.filter((p) => !fixed.has(p.id))) {
        const result = await receptionistDays(db, person, week, rules);
        if (!result.days) return fail(c, 409, 'dtr_open', `${person.displayName} has no clock-out on ${result.openEntryDay}. Fix the DTR first.`);
        if (!person.active && !result.days.some((d) => d.worked)) continue;
        const balance = balances.get(person.id) ?? 0;
        // A draft keeps the repayment chosen for it; a new one takes the standing CA Repayment.
        const draft = existing.find((p) => p.staffId === person.id);
        const repayment = Math.min(draft ? draft.caDeduction : caRepaymentFor(person.caRepayment, balance), balance);
        const { basic, ...pay } = receptionistPayroll({
          days: result.days,
          gov: weeklyDeductions(person, rates, week.end),
          caRepayment: repayment,
          adjustments: sumOf(adjustments.get(person.id)),
        });
        rows.push({ id: crypto.randomUUID(), weekStart: week.start, staffId: person.id, kind, ...pay, basic, breakdownJson: JSON.stringify(result.days), generatedAt: now, generatedBy: c.var.user.id });
      }
    }

    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.generate', entity: 'pay_week', entityId: `${week.start}:${kind}`, after: { count: rows.length } }),
      db.delete(payrolls).where(and(eq(payrolls.weekStart, week.start), eq(payrolls.kind, kind), eq(payrolls.status, 'draft'))),
      ...rows.map((r) => db.insert(payrolls).values(r)),
    ]);
    return c.json({ generated: rows.length });
  })

  .get('/payrolls/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    const [payroll] = await withNames(db, [row], can(c.var.user.role, APPROVE[row.kind]));
    const advances =
      row.kind === 'therapist'
        ? await db.select().from(cashAdvances).where(and(eq(cashAdvances.staffId, row.staffId), eq(cashAdvances.againstWeekStart, row.weekStart))).orderBy(asc(cashAdvances.createdAt))
        : [];
    return c.json({ payroll, advances, caBalance: await caBalance(db, row.staffId), week: payWeekOf(row.weekStart) });
  })

  /** The Receptionist's CA repayment for this week, chosen by the Super Admin. */
  .put('/payrolls/:id/ca-repayment', zValidator('json', z.object({ amount: centavos }), invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (row.kind !== 'receptionist') return fail(c, 409, 'not_receptionist', 'Therapist CAs are deducted in full.');
    if (row.status !== 'draft') return fail(c, 409, 'not_draft', 'Only a draft Payroll can change.');
    const { amount } = c.req.valid('json');
    const balance = await caBalance(db, row.staffId);
    if (amount > balance) return fail(c, 400, 'above_balance', 'That is more than the CA balance.');
    const net = row.net + row.caDeduction - amount;
    await db.batch([
      db.update(payrolls).set({ caDeduction: amount, net }).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.ca_repayment', entity: 'payroll', entityId: row.id, before: { caDeduction: row.caDeduction }, after: { caDeduction: amount } }),
    ]);
    return c.json({ ok: true, net });
  })

  /** Adds an Adjustment to a draft; the Super Admin only. */
  .post('/payrolls/:id/adjustments', zValidator('json', adjustmentBody, invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (!can(c.var.user.role, APPROVE[row.kind])) return fail(c, 403, 'forbidden', 'Only the Super Admin adds Adjustments.');
    if (row.status !== 'draft') return fail(c, 409, 'not_draft', 'Only a draft Payroll can change.');
    const input = c.req.valid('json');
    const id = crypto.randomUUID();
    const adjustment = { id, weekStart: row.weekStart, staffId: row.staffId, ...input, createdAt: nowIso(), createdBy: c.var.user.id };
    await db.batch([
      db.insert(payrollAdjustments).values(adjustment),
      db.update(payrolls).set({ gross: row.gross + input.amount, net: row.net + input.amount }).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.adjustment.add', entity: 'payroll', entityId: row.id, after: adjustment, reason: input.reason }),
    ]);
    return c.json({ id }, 201);
  })

  .delete('/payrolls/:id/adjustments/:adjustmentId', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (!can(c.var.user.role, APPROVE[row.kind])) return fail(c, 403, 'forbidden', 'Only the Super Admin removes Adjustments.');
    if (row.status !== 'draft') return fail(c, 409, 'not_draft', 'Only a draft Payroll can change.');
    const adj = await db
      .select()
      .from(payrollAdjustments)
      .where(and(eq(payrollAdjustments.id, c.req.param('adjustmentId')), eq(payrollAdjustments.weekStart, row.weekStart), eq(payrollAdjustments.staffId, row.staffId)))
      .get();
    if (!adj) return fail(c, 404, 'not_found', 'Adjustment not found.');
    await db.batch([
      db.delete(payrollAdjustments).where(eq(payrollAdjustments.id, adj.id)),
      db.update(payrolls).set({ gross: row.gross - adj.amount, net: row.net - adj.amount }).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.adjustment.remove', entity: 'payroll', entityId: row.id, before: adj }),
    ]);
    return c.json({ ok: true });
  })

  .post('/payrolls/:id/approve', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (!can(c.var.user.role, APPROVE[row.kind])) return fail(c, 403, 'forbidden', 'Only the Super Admin approves Payroll.');
    if (row.status !== 'draft') return fail(c, 409, 'not_draft', 'This Payroll is already approved.');
    const set = { status: 'approved' as const, approvedAt: nowIso(), approvedBy: c.var.user.id };
    await db.batch([
      db.update(payrolls).set(set).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.approve', entity: 'payroll', entityId: row.id, after: { net: row.net } }),
    ]);
    return c.json({ ok: true });
  })

  /** Back to draft, e.g. to regenerate after a correction. */
  .post('/payrolls/:id/unapprove', zValidator('json', z.object({ reason: z.string().trim().min(3).max(300) }), invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (!can(c.var.user.role, APPROVE[row.kind])) return fail(c, 403, 'forbidden', 'Only the Super Admin approves Payroll.');
    if (row.status !== 'approved') return fail(c, 409, 'not_approved', 'Only an approved, unreleased Payroll can go back to draft.');
    await db.batch([
      db.update(payrolls).set({ status: 'draft', approvedAt: null, approvedBy: null }).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.unapprove', entity: 'payroll', entityId: row.id, reason: c.req.valid('json').reason }),
    ]);
    return c.json({ ok: true });
  })

  /** Paid out, by default from Sales Cash at the shop. The CA deduction is now repaid. */
  .post('/payrolls/:id/release', zValidator('json', z.object({ fromShopCash: z.boolean().default(true) }).default({ fromShopCash: true }), invalidInput), async (c) => {
    const db = c.var.db;
    const { fromShopCash } = c.req.valid('json');
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (row.status !== 'approved') return fail(c, 409, 'not_approved', row.status === 'draft' ? 'The Super Admin must approve this Payroll first.' : 'Already released.');
    const now = nowIso();
    const paidFromShop = fromShopCash && row.net > 0;
    const day = paidFromShop ? await currentTransferDay(db) : null;
    await db.batch([
      db.update(payrolls).set({ status: 'released', releasedAt: now, releasedBy: c.var.user.id }).where(and(eq(payrolls.id, row.id), eq(payrolls.status, 'approved'))),
      ...(paidFromShop
        ? [db.insert(cashTransfers).values({ id: crypto.randomUUID(), kind: 'payroll', amount: row.net, businessDay: day!, payrollId: row.id, createdAt: now, createdBy: c.var.user.id })]
        : []),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.release', entity: 'payroll', entityId: row.id, after: { net: row.net } }),
      ...(row.caDeduction > 0
        ? [db.insert(caLedger).values({ id: crypto.randomUUID(), staffId: row.staffId, entry: 'repayment', amount: row.caDeduction, payrollId: row.id, createdAt: now, createdBy: c.var.user.id })]
        : []),
    ]);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------ Cash Advances

  /** What everyone this user handles owes, and for Therapists how much more they may take. */
  .get('/cash-advances/balances', async (c) => {
    const kinds = PAYROLL_KINDS.filter((k) => can(c.var.user.role, ADVANCE[k]));
    if (!kinds.length) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const db = c.var.db;
    const people = (await db.select().from(staff).where(eq(staff.isOnCall, false)).orderBy(asc(staff.displayName))).filter((p) => p.kind !== 'reliever' && kinds.includes(kindOf(p)));
    const balances = await caBalances(db);
    const out = [];
    for (const p of people) {
      const balance = balances.get(p.id) ?? 0;
      if (!p.active && !balance) continue;
      out.push({
        staffId: p.id,
        displayName: p.displayName,
        kind: kindOf(p),
        balance,
        ...(kindOf(p) === 'therapist' ? { cap: await therapistCap(db, p) } : { caRepayment: p.caRepayment }),
      });
    }
    return c.json({ balances: out });
  })

  .get('/cash-advances', zValidator('query', z.object({ staffId: z.string().min(1) }), invalidInput), async (c) => {
    const db = c.var.db;
    const person = await db.select().from(staff).where(eq(staff.id, c.req.valid('query').staffId)).get();
    if (!person || !can(c.var.user.role, ADVANCE[kindOf(person)])) return fail(c, 404, 'not_found', 'Staff not found.');
    const ledger = await db.select().from(caLedger).where(eq(caLedger.staffId, person.id)).orderBy(desc(caLedger.createdAt)).limit(100);
    const advances = await db.select().from(cashAdvances).where(eq(cashAdvances.staffId, person.id)).orderBy(desc(cashAdvances.createdAt)).limit(100);
    return c.json({ ledger, advances, balance: await caBalance(db, person.id) });
  })

  .post('/cash-advances', zValidator('json', advanceBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const person = await db.select().from(staff).where(eq(staff.id, input.staffId)).get();
    if (!person?.active) return fail(c, 404, 'not_found', 'Staff not found.');
    const kind = kindOf(person);
    if (!can(c.var.user.role, ADVANCE[kind])) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    if (person.isOnCall) return fail(c, 409, 'on_call', 'On-call Therapists are paid daily and cannot take a Cash Advance.');
    if (person.kind === 'reliever') return fail(c, 409, 'reliever', 'Outside Relievers cannot take a Cash Advance.');

    let against: string | null = null;
    let overrideBy: string | null = null;
    if (kind === 'therapist') {
      const cap = await therapistCap(db, person);
      against = cap.week.start;
      if (input.amount > cap.cap) {
        if (!input.override || !can(c.var.user.role, 'cash_advance.override')) {
          return fail(c, 409, 'above_cap', `${person.displayName} can take at most ₱${(cap.cap / 100).toFixed(2)} now.`);
        }
        overrideBy = c.var.user.id;
      }
    }

    const day = today();
    if (input.fromDrawer) {
      const blocked = await openDayFor(c, day);
      if (blocked) return blocked;
    }
    const id = crypto.randomUUID();
    const cashOutId = input.fromDrawer ? crypto.randomUUID() : null;
    const now = nowIso();
    const draft = against
      ? await db.select().from(payrolls).where(and(eq(payrolls.staffId, person.id), eq(payrolls.weekStart, against), eq(payrolls.status, 'draft'))).get()
      : undefined;
    const row = { id, staffId: person.id, amount: input.amount, businessDay: day, againstWeekStart: against, cashOutId, overrideBy, note: input.note || null, createdAt: now, createdBy: c.var.user.id };
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'cash_advance.create', entity: 'cash_advance', entityId: id, after: row }),
      ...(cashOutId
        ? [db.insert(cashOuts).values({ id: cashOutId, businessDay: day, category: 'cash_advance', amount: input.amount, purpose: `Cash Advance: ${person.displayName}`, staffId: person.id, createdAt: now, createdBy: c.var.user.id })]
        : []),
      db.insert(cashAdvances).values(row),
      db.insert(caLedger).values({ id: crypto.randomUUID(), staffId: person.id, entry: 'advance', amount: input.amount, cashAdvanceId: id, createdAt: now, createdBy: c.var.user.id }),
      // A draft for that week already exists: keep it in step.
      ...(draft
        ? [db.update(payrolls).set({ caDeduction: draft.caDeduction + input.amount, net: draft.net - input.amount }).where(eq(payrolls.id, draft.id))]
        : []),
    ]);
    return c.json({ id, againstWeekStart: against }, 201);
  })

  /** A mistaken CA can be removed while its day is open and its Payroll is not approved. */
  .delete('/cash-advances/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(cashAdvances).where(eq(cashAdvances.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Cash Advance not found.');
    const person = (await db.select().from(staff).where(eq(staff.id, row.staffId)).get())!;
    if (!can(c.var.user.role, ADVANCE[kindOf(person)])) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const blocked = await requireOpenDay(c, row.businessDay);
    if (blocked) return blocked;
    const payroll = row.againstWeekStart
      ? await db.select().from(payrolls).where(and(eq(payrolls.staffId, row.staffId), eq(payrolls.weekStart, row.againstWeekStart))).get()
      : undefined;
    if (payroll && payroll.status !== 'draft') return fail(c, 409, 'payroll_approved', 'Its Payroll is already approved.');
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'cash_advance.delete', entity: 'cash_advance', entityId: row.id, before: row }),
      db.delete(caLedger).where(eq(caLedger.cashAdvanceId, row.id)),
      db.delete(cashAdvances).where(eq(cashAdvances.id, row.id)),
      ...(row.cashOutId ? [db.delete(cashOuts).where(eq(cashOuts.id, row.cashOutId))] : []),
      ...(payroll ? [db.update(payrolls).set({ caDeduction: payroll.caDeduction - row.amount, net: payroll.net + row.amount }).where(eq(payrolls.id, payroll.id))] : []),
    ]);
    return c.json({ ok: true });
  })

  /** Go-live: what someone already owed before the system. Replaces any earlier opening balance. */
  .put('/cash-advances/opening', zValidator('json', z.object({ staffId: z.string().min(1), amount: centavos }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'cash_advance.override')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets opening balances.');
    const db = c.var.db;
    const { staffId, amount } = c.req.valid('json');
    const person = await db.select().from(staff).where(eq(staff.id, staffId)).get();
    if (!person) return fail(c, 404, 'not_found', 'Staff not found.');
    const before = await db.select().from(caLedger).where(and(eq(caLedger.staffId, staffId), eq(caLedger.entry, 'opening'))).get();
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'cash_advance.opening', entity: 'staff', entityId: staffId, before: before?.amount ?? 0, after: amount }),
      db.delete(caLedger).where(and(eq(caLedger.staffId, staffId), eq(caLedger.entry, 'opening'))),
      ...(amount > 0 ? [db.insert(caLedger).values({ id: crypto.randomUUID(), staffId, entry: 'opening', amount, createdAt: nowIso(), createdBy: c.var.user.id })] : []),
    ]);
    return c.json({ ok: true, balance: await caBalance(db, staffId) });
  })

  // ------------------------------------------------------------------ Bonuses

  .get('/bonuses', zValidator('query', z.object({ year: z.coerce.number().pipe(year) }), invalidInput), async (c) => {
    const kinds = (['year_end_bonus', 'thirteenth_month'] as const).filter((k) => can(c.var.user.role, APPROVE[k === 'year_end_bonus' ? 'therapist' : 'receptionist']));
    if (!kinds.length) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const db = c.var.db;
    const rows = await db
      .select({ bonus: bonuses, displayName: staff.displayName })
      .from(bonuses)
      .innerJoin(staff, eq(staff.id, bonuses.staffId))
      .where(and(eq(bonuses.year, c.req.valid('query').year), inArray(bonuses.kind, kinds)))
      .orderBy(asc(bonuses.kind), asc(staff.displayName));
    return c.json({ bonuses: rows.map((r) => ({ ...r.bonus, displayName: r.displayName })) });
  })

  /** Year-end Bonus for every Therapist: the year's Commission × the chosen percentage. */
  .post('/bonuses/year-end', zValidator('json', z.object({ year, bp: z.number().int().min(1).max(10_000) }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'payroll.therapist.approve')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets bonuses.');
    const { year: y, bp } = c.req.valid('json');
    const db = c.var.db;
    const totals = await db
      .select({ staffId: sales.therapistId, total: sql<number>`sum(${sales.commissionAmount})` })
      .from(sales)
      .innerJoin(staff, eq(staff.id, sales.therapistId))
      .where(and(eq(sales.status, 'paid'), eq(staff.isOnCall, false), gte(sales.businessDay, `${y}-01-01`), lte(sales.businessDay, `${y}-12-31`)))
      .groupBy(sales.therapistId);
    return saveBonuses(c, y, 'year_end_bonus', totals.map((t) => ({ staffId: t.staffId, basis: Number(t.total), bp, amount: yearEndBonus(Number(t.total), bp) })));
  })

  /** 13th Month Pay for the Receptionist: the year's basic pay ÷ 12, from approved Payrolls. */
  .post('/bonuses/thirteenth-month', zValidator('json', z.object({ year }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'payroll.receptionist.manage')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets bonuses.');
    const { year: y } = c.req.valid('json');
    const db = c.var.db;
    // A Pay Week can straddle New Year, so count each day in its own year.
    const rows = await db
      .select({ staffId: payrolls.staffId, breakdownJson: payrolls.breakdownJson })
      .from(payrolls)
      .where(and(eq(payrolls.kind, 'receptionist'), ne(payrolls.status, 'draft'), gte(payrolls.weekStart, `${y - 1}-12-25`), lte(payrolls.weekStart, `${y}-12-31`)));
    const basis = new Map<string, number>();
    for (const r of rows) {
      const days = JSON.parse(r.breakdownJson) as ReceptionistDay[];
      const inYear = days.filter((d) => d.date.startsWith(`${y}-`)).reduce((s, d) => s + d.basic, 0);
      basis.set(r.staffId, (basis.get(r.staffId) ?? 0) + inYear);
    }
    return saveBonuses(c, y, 'thirteenth_month', [...basis].map(([staffId, b]) => ({ staffId, basis: b, bp: null, amount: thirteenthMonth(b) })));
  })

  .post('/bonuses/:id/paid', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(bonuses).where(eq(bonuses.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Bonus not found.');
    if (!can(c.var.user.role, APPROVE[row.kind === 'year_end_bonus' ? 'therapist' : 'receptionist'])) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    if (row.paidAt) return fail(c, 409, 'already_paid', 'Already marked paid.');
    await db.batch([
      db.update(bonuses).set({ paidAt: nowIso() }).where(eq(bonuses.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'bonus.paid', entity: 'bonus', entityId: row.id, after: { amount: row.amount } }),
    ]);
    return c.json({ ok: true });
  });

/** Replaces the year's unpaid bonuses of that kind; paid ones stay as they were. */
async function saveBonuses(
  c: Context<AuthedEnv>,
  y: number,
  kind: (typeof bonuses.$inferSelect)['kind'],
  lines: { staffId: string; basis: number; bp: number | null; amount: number }[],
) {
  const db = c.var.db;
  const paid = new Set(
    (await db.select({ staffId: bonuses.staffId }).from(bonuses).where(and(eq(bonuses.year, y), eq(bonuses.kind, kind), sql`${bonuses.paidAt} is not null`))).map((r) => r.staffId),
  );
  const now = nowIso();
  const fresh = lines.filter((l) => !paid.has(l.staffId) && l.basis > 0);
  await db.batch([
    auditInsert(db, { actorUserId: c.var.user.id, action: `bonus.${kind}`, entity: 'bonus_year', entityId: String(y), after: fresh }),
    db.delete(bonuses).where(and(eq(bonuses.year, y), eq(bonuses.kind, kind), isNull(bonuses.paidAt))),
    ...fresh.map((l) => db.insert(bonuses).values({ id: crypto.randomUUID(), year: y, kind, ...l, createdAt: now, createdBy: c.var.user.id })),
  ]);
  return c.json({ computed: fresh.length });
}
