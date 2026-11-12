import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  bonusDeduction,
  bonusPeriod,
  businessDayOf,
  can,
  caRepaymentFor,
  cashAdvanceCap,
  commissionRateOn,
  daysOf,
  lastCompletedPayWeek,
  openingWeeks,
  weekNumber,
  weeksOwed,
  type DeferredWeek,
  payLines,
  payWeekOf,
  receptionistDay,
  receptionistPayroll,
  refundSplit,
  REFUND_STEPS,
  suggestBonus,
  therapistPayroll,
  thirteenthMonth,
  weekdayOf,
  weekFrom,
  weekKindsOf,
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
  deductionLedger,
  deductionRefunds,
  dtr,
  holidays,
  openingBasicPay,
  payrollAdjustments,
  payrolls,
  PAYROLL_KINDS,
  pastPayslips,
  pastTherapistWeeks,
  payRules,
  sales,
  staff,
} from '@spa/db';
import { statementFor } from './finance';
import type { AuthedEnv } from '../env';
import { pastPayslipsOf } from './backfill';
import { auditInsert } from '../lib/audit';
import { openDayFor, requireOpenDay } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { contributionRates, weeklyDeductions } from '../lib/contributions';
import { REFUND_PLAN_KEY, refundStatus } from '../lib/refund';
import { goLiveDate, takeHomeFloor } from '../lib/pay-rules';
import { currentTransferDay } from '../lib/sales-cash';
import { nowIso } from '../lib/time';
import { centavos, isoDate } from '../lib/validation';
import { receptionistRules, reliefDays } from '../lib/relief';
import { requireAuth, requireCapability } from '../auth/middleware';

type Db = DrizzleD1Database;
type Staff = typeof staff.$inferSelect;
type PayrollRow = typeof payrolls.$inferSelect;
type Kind = (typeof PAYROLL_KINDS)[number];

const weekStart = isoDate.refine((d) => weekdayOf(d) <= 1, 'A Pay Week starts on a Sunday, or a Monday for Therapists.');
const weekParam = z.object({ start: weekStart });
const year = z.number().int().min(2020).max(2100);

/** Who may see and prepare each kind of Payroll, and who approves it. */
const PREPARE: Record<Kind, Capability> = { therapist: 'payroll.therapist.generate', receptionist: 'payroll.receptionist.manage', reliever: 'payroll.receptionist.manage' };
const APPROVE: Record<Kind, Capability> = { therapist: 'payroll.therapist.approve', receptionist: 'payroll.receptionist.manage', reliever: 'payroll.receptionist.manage' };
// Outside Relievers take no Cash Advances; the entry is only there to complete the map.
const ADVANCE: Record<Kind, Capability> = { therapist: 'cash_advance.therapist', receptionist: 'payroll.receptionist.manage', reliever: 'payroll.receptionist.manage' };

const kindOf = (s: Staff): Kind => s.kind;
const today = () => businessDayOf(new Date());
/** The Pay Week start `n` weeks after `start`. */
const shiftWeek = (start: string, n: number) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
};

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

/** Default share of the year's profit for the Year-end Bonus suggestion: 30%. */
const DEFAULT_PROFIT_SHARE_BP = 3000;

const sumOf = (rows: readonly { amount: number }[] | undefined) => (rows ?? []).reduce((s, r) => s + r.amount, 0);

/** What a Therapist owes in Government Deductions: opening + deferred − collected − bonus − refund. */
async function deductionBalances(db: Db, staffIds?: string[]) {
  const rows = await db
    .select({ staffId: deductionLedger.staffId, balance: sql<number>`sum(case when ${deductionLedger.entry} in ('collected', 'bonus', 'refund') then -${deductionLedger.amount} else ${deductionLedger.amount} end)` })
    .from(deductionLedger)
    .where(staffIds ? inArray(deductionLedger.staffId, staffIds) : undefined)
    .groupBy(deductionLedger.staffId);
  return new Map(rows.map((r) => [r.staffId, Number(r.balance)]));
}

type LedgerLine = { staffId: string; entry: string; amount: number; weeksJson: string | null; weekStart: string | null };

async function ledgerLines(db: Db, staffIds: string[]): Promise<LedgerLine[]> {
  if (!staffIds.length) return [];
  return db
    .select({ staffId: deductionLedger.staffId, entry: deductionLedger.entry, amount: deductionLedger.amount, weeksJson: deductionLedger.weeksJson, weekStart: payrolls.weekStart })
    .from(deductionLedger)
    .leftJoin(payrolls, eq(payrolls.id, deductionLedger.payrollId))
    .where(inArray(deductionLedger.staffId, staffIds));
}

const openingWeeksOf = (line: LedgerLine | undefined): DeferredWeek[] => (line?.weeksJson ? (JSON.parse(line.weeksJson) as DeferredWeek[]) : []);
const numbered = (weeks: readonly DeferredWeek[]) => weeks.map((w) => ({ ...w, number: weekNumber(w.weekStart) }));

/** The weeks a Therapist still owes and their total. A draft counts as if approved, so its Payslip is right when handed out. */
function deductionsOwed(lines: readonly LedgerLine[], staffId: string, draft?: { weekStart: string; govDeferred: number; govCollected: number }) {
  const weeks: DeferredWeek[] = [];
  let paid = draft?.govCollected ?? 0;
  let unlisted = 0; // an opening balance typed in without picking its weeks
  if (draft?.govDeferred) weeks.push({ weekStart: draft.weekStart, amount: draft.govDeferred });
  for (const l of lines.filter((x) => x.staffId === staffId)) {
    if (l.entry === 'opening') {
      const listed = openingWeeksOf(l);
      const sum = sumOf(listed);
      weeks.push(...listed);
      if (l.amount > sum) unlisted += l.amount - sum;
      else paid += sum - l.amount;
    } else if (l.entry === 'deferred') weeks.push({ weekStart: l.weekStart ?? '', amount: l.amount });
    else paid += l.amount;
  }
  const left = weeksOwed(weeks, paid);
  return { total: sumOf(left) + unlisted, weeks: numbered(left.filter((w) => w.weekStart)) };
}

/** Business Days holding a Pay Week's Payroll back; days before Go-live were never run here. */
async function unclosedDaysIn(db: Db, week: PayWeek) {
  const from = await goLiveDate(db);
  return db
    .select({ date: businessDays.date })
    .from(businessDays)
    .where(and(gte(businessDays.date, week.start > from ? week.start : from), lte(businessDays.date, week.end), isNull(businessDays.closedAt)));
}

/** A Pay Week that starts before Go-live and ends after it has Commission only the owner's records hold. */
const straddles = (week: PayWeek, goLive: string) => week.start < goLive && goLive <= week.end;

/** A Therapist's week as it stands now, from sales, DTR and CAs taken against it. */
async function therapistWeek(db: Db, person: Staff, week: PayWeek, override?: number | null) {
  const [sold, worked, advances, rates, commissionRows, adjustments, relief, balances, floor, before] = await Promise.all([
    db
      .select({ businessDay: sales.businessDay, amount: sales.commissionAmount, regularPrice: sales.regularPrice, setAside: sales.setAside, isHoliday: sales.isHoliday })
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
    deductionBalances(db, [person.id]),
    takeHomeFloor(db),
    db.select({ gross: pastTherapistWeeks.gross }).from(pastTherapistWeeks).where(and(eq(pastTherapistWeeks.staffId, person.id), eq(pastTherapistWeeks.weekStart, week.start))).get(),
  ]);
  const taken = advances.reduce((s, a) => s + a.amount, 0);
  // What the Holiday rate added on top of the normal rate, for the Payslip.
  const commissions = sold.map((s) => {
    const rate = s.isHoliday ? commissionRateOn(commissionRows, person.therapistClass ?? 'regular', s.businessDay) : undefined;
    const normal = rate ? Math.round(((s.regularPrice - s.setAside) * rate.normalBp) / 10_000) : s.amount;
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
    commissionBefore: before?.gross ?? 0,
    // Away for the whole week still owes its Government Deductions; someone who has left or not yet started doesn't.
    deferral: { balance: balances.get(person.id) ?? 0, floor, override, owesWhenAway: person.active && (!person.hireDate || person.hireDate <= week.end) },
  });
  return { pay, taken, advances };
}

/** The columns a Therapist's Payroll row keeps from a computed week. */
const therapistColumns = ({ days, ...pay }: Awaited<ReturnType<typeof therapistWeek>>['pay']) => ({ ...pay, breakdownJson: JSON.stringify(days) });

/** Keeps a Therapist's draft in step after a Cash Advance or Adjustment changes what room there is for deductions. */
async function refreshDraft(db: Db, row: PayrollRow) {
  if (row.kind !== 'therapist') return;
  const current = await db.select().from(payrolls).where(eq(payrolls.id, row.id)).get();
  if (current?.status !== 'draft') return;
  const person = (await db.select().from(staff).where(eq(staff.id, row.staffId)).get())!;
  const { pay } = await therapistWeek(db, person, weekFrom(row.weekStart), current.govOverride);
  await db.update(payrolls).set(therapistColumns(pay)).where(eq(payrolls.id, row.id));
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
  const last = lastCompletedPayWeek(today(), 'therapist');
  const row = await db.select({ status: payrolls.status }).from(payrolls).where(and(eq(payrolls.staffId, staffId), eq(payrolls.weekStart, last.start))).get();
  return !row || row.status === 'draft' ? last : payWeekOf(today(), 'therapist');
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

type RefundRow = typeof deductionRefunds.$inferSelect;
const refundOut = (r: RefundRow) => ({ weekStart: r.weekStart, sss: r.sss, phic: r.phic, pagibig: r.pagibig, total: r.sss + r.phic + r.pagibig, applied: r.applied, cash: r.cash, adjustmentId: r.adjustmentId });

/** The label a Government Deduction Refund's cash carries on the Payslip. */
const REFUND_LABEL = 'Government Deduction Refund';
const pesoText = (n: number) => `${n < 0 ? '-' : ''}₱${(Math.abs(n) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Refunds cover both kinds of staff, so only someone who approves both sets them: the Super Admin. */
const canRefund = (c: Context<AuthedEnv>) => can(c.var.user.role, 'payroll.therapist.approve') && can(c.var.user.role, 'payroll.receptionist.manage');
const agencyAmount = z.number().int().min(-10_000_000).max(10_000_000);
const refundPlanBody = z.object({
  payoutDate: isoDate,
  ticked: z.array(z.enum(REFUND_STEPS.filter((s) => s.manual).map((s) => s.key) as [string, ...string[]])).max(10),
});
const refundBody = z.object({ staffId: z.string().min(1), weekStart: isoDate, sss: agencyAmount, phic: agencyAmount, pagibig: agencyAmount });

/** Payrolls with names, days, Adjustments and Payslip lines. Adjustment reasons only `withReasons`. */
const withNames = async (db: Db, rows: PayrollRow[], withReasons = false) => {
  const ids = [...new Set(rows.map((r) => r.staffId))];
  const weeks = [...new Set(rows.map((r) => r.weekStart))];
  const [people, adjustments, ledger, refunds] = await Promise.all([
    ids.length ? db.select().from(staff).where(inArray(staff.id, ids)) : Promise.resolve([]),
    Promise.all(weeks.map(async (w) => [w, await adjustmentsFor(db, w, ids)] as const)).then((xs) => new Map(xs)),
    ledgerLines(db, [...new Set(rows.filter((r) => r.kind === 'therapist').map((r) => r.staffId))]),
    ids.length ? db.select().from(deductionRefunds).where(inArray(deductionRefunds.staffId, ids)) : Promise.resolve([]),
  ]);
  return rows.map(({ breakdownJson, ...r }) => {
    const refund = refunds.find((x) => x.staffId === r.staffId && x.weekStart === r.weekStart);
    const p = people.find((x) => x.id === r.staffId)!;
    const days = JSON.parse(breakdownJson) as (TherapistDay | ReceptionistDay)[];
    const adj = (adjustments.get(r.weekStart)?.get(r.staffId) ?? []).map((a) => ({ id: a.id, label: a.label, amount: a.amount, ...(withReasons ? { reason: a.reason } : {}) }));
    const lines = payLines({ ...(r as unknown as PayrollTotals), govDeferred: r.govDeferred, govCollected: r.govCollected, commissionBefore: r.commissionBefore, kind: r.kind, days, adjustments: sumOf(adj) } as Parameters<typeof payLines>[0]);
    const deferredOwed = r.kind === 'therapist' ? deductionsOwed(ledger, r.staffId, r.status === 'draft' ? r : undefined) : null;
    return {
      ...r,
      displayName: p.displayName,
      fullName: `${p.firstName} ${p.lastName}`,
      therapistClass: p.therapistClass,
      days,
      adjustments: adj,
      lines,
      deferredOwed,
      refund: refund ? refundOut(refund) : null,
    };
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
    if (!person) return c.json({ staff: null, payslips: [], pastPayslips: [], ca: null });
    const [released, ledger, advances, balance, past] = await Promise.all([
      db
        .select({ id: payrolls.id, weekStart: payrolls.weekStart, net: payrolls.net, releasedAt: payrolls.releasedAt })
        .from(payrolls)
        .where(and(eq(payrolls.staffId, person.id), eq(payrolls.status, 'released')))
        .orderBy(desc(payrolls.weekStart)),
      db.select().from(caLedger).where(eq(caLedger.staffId, person.id)).orderBy(asc(caLedger.createdAt)),
      db.select().from(cashAdvances).where(eq(cashAdvances.staffId, person.id)),
      caBalance(db, person.id),
      pastPayslipsOf(db, person.id),
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
      pastPayslips: past,
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
    return c.json({ payroll, week: weekFrom(row.weekStart) });
  })

  /** A Pay Week: whether it can be generated yet and the Payrolls this user may see. */
  .get('/payroll/weeks/:start', zValidator('param', weekParam, invalidInput), async (c) => {
    const { start } = c.req.valid('param');
    const kinds = weekKindsOf(start).filter((k) => canSee(c, k));
    if (!kinds.length && !PAYROLL_KINDS.some((k) => canSee(c, k))) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const db = c.var.db;
    const week = weekFrom(start);
    const [rows, unclosed, goLive] = await Promise.all([
      kinds.length ? db.select().from(payrolls).where(and(eq(payrolls.weekStart, week.start), inArray(payrolls.kind, kinds))).orderBy(asc(payrolls.kind)) : Promise.resolve([]),
      unclosedDaysIn(db, week),
      goLiveDate(db),
    ]);
    // Everyone's Commission for the days before Go-live, entered by hand.
    const needsBefore = kinds.includes('therapist') && straddles(week, goLive);
    const beforeGoLive = needsBefore
      ? (
          await db
            .select({ staffId: staff.id, displayName: staff.displayName, amount: pastTherapistWeeks.gross })
            .from(staff)
            .leftJoin(pastTherapistWeeks, and(eq(pastTherapistWeeks.staffId, staff.id), eq(pastTherapistWeeks.weekStart, week.start)))
            .where(and(eq(staff.kind, 'therapist'), eq(staff.isOnCall, false), eq(staff.active, true)))
            .orderBy(asc(staff.displayName))
        ).map((p) => ({ ...p, amount: p.amount ?? null }))
      : null;
    const list = await withNames(db, rows, can(c.var.user.role, 'payroll.therapist.approve'));
    list.sort((a, b) => a.kind.localeCompare(b.kind) || a.displayName.localeCompare(b.displayName));
    // A Pay Week from before Go-live exists only in the owner's records.
    const fromRecords =
      kinds.includes('therapist') && !rows.length && week.start < payWeekOf(goLive, 'therapist').start
        ? await db
            .select({ staffId: staff.id, displayName: staff.displayName, gross: pastTherapistWeeks.gross, daysWorked: pastTherapistWeeks.daysWorked, net: pastTherapistWeeks.net })
            .from(pastTherapistWeeks)
            .innerJoin(staff, eq(staff.id, pastTherapistWeeks.staffId))
            .where(eq(pastTherapistWeeks.weekStart, week.start))
            .orderBy(asc(staff.displayName))
        : [];
    return c.json({ week, ended: today() > week.end, unclosedDays: unclosed.map((d) => d.date), kinds, beforeGoLive, fromRecords, payrolls: list.map(({ days: _, ...r }) => r) });
  })

  /** A Therapist's Commission for the Pay Week's days before Go-live, from the owner's report. */
  .put(
    '/payroll/weeks/:start/before-go-live',
    zValidator('param', weekParam, invalidInput),
    zValidator('json', z.object({ staffId: z.string().min(1), amount: centavos, daysWorked: z.number().int().min(0).max(7).default(0) }), invalidInput),
    async (c) => {
      if (!canSee(c, 'therapist')) return fail(c, 403, 'forbidden', 'You do not have access to this.');
      const db = c.var.db;
      const week = weekFrom(c.req.valid('param').start);
      if (!straddles(week, await goLiveDate(db))) return fail(c, 409, 'not_first_week', 'Only the week of go-live has Commission from before it.');
      const { staffId, amount, daysWorked } = c.req.valid('json');
      const fixed = await db.select({ status: payrolls.status }).from(payrolls).where(and(eq(payrolls.staffId, staffId), eq(payrolls.weekStart, week.start))).get();
      if (fixed && fixed.status !== 'draft') return fail(c, 409, 'not_draft', 'This Payroll is already approved.');
      await db.batch([
        auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.before_go_live', entity: 'staff', entityId: staffId, after: { week: week.start, amount } }),
        db
          .insert(pastTherapistWeeks)
          .values({ id: crypto.randomUUID(), weekStart: week.start, staffId, gross: amount, daysWorked, net: amount, createdAt: nowIso() })
          .onConflictDoUpdate({ target: [pastTherapistWeeks.weekStart, pastTherapistWeeks.staffId], set: { gross: amount, daysWorked, net: amount } }),
      ]);
      return c.json({ ok: true });
    },
  )

  /** (Re)computes the week's drafts. Approved and released Payrolls are left alone. */
  .post('/payroll/weeks/:start/generate', zValidator('param', weekParam, invalidInput), zValidator('json', generateBody, invalidInput), async (c) => {
    const { kind } = c.req.valid('json');
    if (!canSee(c, kind)) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const db = c.var.db;
    const week = weekFrom(c.req.valid('param').start);
    if (!weekKindsOf(week.start).includes(kind)) return fail(c, 409, 'wrong_week', kind === 'therapist' ? 'A Therapist’s Pay Week starts on a Monday.' : 'This Pay Week starts on a Sunday.');
    if (today() <= week.end) return fail(c, 409, 'week_not_over', 'This Pay Week has not ended yet.');
    const [unclosed] = await unclosedDaysIn(db, week);
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
        // A draft keeps the Super Admin's own deduction figure.
        const draft = existing.find((p) => p.staffId === person.id);
        const { pay, taken } = await therapistWeek(db, person, week, draft?.govOverride);
        if (!pay.gross && !taken && pay.govSss === 0) continue; // nothing happened this week
        rows.push({ id: crypto.randomUUID(), weekStart: week.start, staffId: person.id, kind, ...therapistColumns(pay), govAgreed: draft?.govAgreed ?? false, generatedAt: now, generatedBy: c.var.user.id });
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
    const deferred = row.kind === 'therapist' ? ((await deductionBalances(db, [row.staffId])).get(row.staffId) ?? 0) : 0;
    return c.json({ payroll, advances, caBalance: await caBalance(db, row.staffId), deductionBalance: deferred, week: weekFrom(row.weekStart) });
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

  /** The Super Admin's own figure for this Payroll's Government Deductions; null goes back to the Take-home Floor. `agreed`: the Therapist agreed to it. */
  .put('/payrolls/:id/deductions', zValidator('json', z.object({ amount: centavos.nullable(), agreed: z.boolean().default(false) }), invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (!can(c.var.user.role, APPROVE[row.kind])) return fail(c, 403, 'forbidden', 'Only the Super Admin can change this.');
    if (row.kind !== 'therapist') return fail(c, 409, 'not_therapist', 'Only a Therapist’s Payroll has Deferred Deductions.');
    if (row.status !== 'draft') return fail(c, 409, 'not_draft', 'Only a draft Payroll can change.');
    const person = (await db.select().from(staff).where(eq(staff.id, row.staffId)).get())!;
    const { amount, agreed } = c.req.valid('json');
    const govAgreed = agreed && amount !== null;
    const { pay } = await therapistWeek(db, person, weekFrom(row.weekStart), amount);
    await db.batch([
      db.update(payrolls).set({ ...therapistColumns(pay), govAgreed }).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.deductions', entity: 'payroll', entityId: row.id, before: { govOverride: row.govOverride }, after: { govOverride: amount, govAgreed } }),
    ]);
    return c.json({ ok: true, net: pay.net });
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
    await refreshDraft(db, row);
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
    const refund = await db.select({ id: deductionRefunds.id }).from(deductionRefunds).where(eq(deductionRefunds.adjustmentId, adj.id)).get();
    if (refund) return fail(c, 409, 'refund', 'This is a Government Deduction Refund. Remove it on the Deferred Deductions page.');
    await db.batch([
      db.delete(payrollAdjustments).where(eq(payrollAdjustments.id, adj.id)),
      db.update(payrolls).set({ gross: row.gross - adj.amount, net: row.net - adj.amount }).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.adjustment.remove', entity: 'payroll', entityId: row.id, before: adj }),
    ]);
    await refreshDraft(db, row);
    return c.json({ ok: true });
  })

  .post('/payrolls/:id/approve', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(payrolls).where(eq(payrolls.id, c.req.param('id'))).get();
    if (!row || !canSee(c, row.kind)) return fail(c, 404, 'not_found', 'Payroll not found.');
    if (!can(c.var.user.role, APPROVE[row.kind])) return fail(c, 403, 'forbidden', 'Only the Super Admin approves Payroll.');
    if (row.status !== 'draft') return fail(c, 409, 'not_draft', 'This Payroll is already approved.');
    const set = { status: 'approved' as const, approvedAt: nowIso(), approvedBy: c.var.user.id };
    const ledger: (typeof deductionLedger.$inferInsert)[] = [];
    if (row.kind === 'therapist') {
      const person = (await db.select().from(staff).where(eq(staff.id, row.staffId)).get())!;
      const week = weekFrom(row.weekStart);
      if (straddles(week, await goLiveDate(db))) {
        const entered = await db.select({ id: pastTherapistWeeks.id }).from(pastTherapistWeeks).where(and(eq(pastTherapistWeeks.staffId, row.staffId), eq(pastTherapistWeeks.weekStart, week.start))).get();
        if (!entered) return fail(c, 409, 'before_go_live_missing', `Enter ${person.displayName}’s Commission from before go-live first.`);
      }
      // Another week approved since, or a late change: the figures must be current before they count.
      const { pay } = await therapistWeek(db, person, week, row.govOverride);
      if (pay.net !== row.net) return fail(c, 409, 'stale', `${person.displayName}’s figures have changed. Recompute the drafts first.`);
      const entry = (kind: 'deferred' | 'collected', amount: number) => ledger.push({ id: crypto.randomUUID(), staffId: row.staffId, entry: kind, amount, payrollId: row.id, createdAt: set.approvedAt, createdBy: c.var.user.id });
      if (row.govDeferred) entry('deferred', row.govDeferred);
      if (row.govCollected) entry('collected', row.govCollected);
    }
    await db.batch([
      db.update(payrolls).set(set).where(eq(payrolls.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'payroll.approve', entity: 'payroll', entityId: row.id, after: { net: row.net } }),
      ...ledger.map((l) => db.insert(deductionLedger).values(l)),
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
      db.delete(deductionLedger).where(eq(deductionLedger.payrollId, row.id)),
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
    const recorded = await db.select().from(pastPayslips).where(isNotNull(pastPayslips.caBalance)).orderBy(desc(pastPayslips.weekStart));
    const out = [];
    for (const p of people) {
      const balance = balances.get(p.id) ?? 0;
      if (!p.active && !balance) continue;
      out.push({
        staffId: p.id,
        displayName: p.displayName,
        kind: kindOf(p),
        balance,
        ...(kindOf(p) === 'therapist' ? { cap: await therapistCap(db, p) } : { caRepayment: p.caRepayment, suggestedOpening: recorded.find((r) => r.staffId === p.id)?.caBalance ?? null }),
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
    if (draft) await refreshDraft(db, draft);
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
    if (payroll) await refreshDraft(db, payroll);
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

  // ------------------------------------------------- Deferred Deductions

  /** What each Therapist owes, with what the 2026 record suggests they owed at Go-live. */
  .get('/deferred-deductions', async (c) => {
    if (!can(c.var.user.role, 'payroll.therapist.approve')) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const db = c.var.db;
    const [people, balances, weeks, goLive] = await Promise.all([
      db.select().from(staff).where(and(eq(staff.kind, 'therapist'), eq(staff.isOnCall, false))).orderBy(asc(staff.displayName)),
      deductionBalances(db),
      db.select().from(pastTherapistWeeks),
      goLiveDate(db),
    ]);
    const ledger = await ledgerLines(db, people.map((p) => p.id));
    const firstWeek = payWeekOf(goLive, 'therapist').start;
    return c.json({
      takeHomeFloor: await takeHomeFloor(db),
      people: people
        .filter((p) => p.active || balances.get(p.id))
        .map((p) => {
          const opening = ledger.find((l) => l.staffId === p.id && l.entry === 'opening');
          // Weeks before they started were never owed.
          const record = weeks.filter((w) => w.staffId === p.id && w.weekStart < firstWeek && (!p.hireDate || weekFrom(w.weekStart).end >= p.hireDate));
          const suggestedWeeks = numbered(p.notEnrolled ? [] : openingWeeks(record));
          return {
            staffId: p.id,
            displayName: p.displayName,
            notEnrolled: p.notEnrolled,
            balance: balances.get(p.id) ?? 0,
            opening: opening?.amount ?? null,
            openingWeeks: opening ? numbered(openingWeeksOf(opening)) : null,
            suggested: sumOf(suggestedWeeks),
            suggestedWeeks,
            owedWeeks: deductionsOwed(ledger, p.id).weeks,
          };
        }),
    });
  })

  /** What a Therapist already owed at Go-live. Replaces any earlier opening balance. */
  .put('/deferred-deductions/opening', zValidator('json', z.object({ staffId: z.string().min(1), amount: centavos, weeks: z.array(z.object({ weekStart: isoDate, amount: centavos })).max(60).default([]) }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'payroll.therapist.approve')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets opening balances.');
    const db = c.var.db;
    const { staffId, amount, weeks } = c.req.valid('json');
    const person = await db.select().from(staff).where(eq(staff.id, staffId)).get();
    if (person?.kind !== 'therapist') return fail(c, 404, 'not_found', 'Therapist not found.');
    const before = await db.select().from(deductionLedger).where(and(eq(deductionLedger.staffId, staffId), eq(deductionLedger.entry, 'opening'))).get();
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'deferred_deductions.opening', entity: 'staff', entityId: staffId, before: before?.amount ?? 0, after: amount }),
      db.delete(deductionLedger).where(and(eq(deductionLedger.staffId, staffId), eq(deductionLedger.entry, 'opening'))),
      ...(amount > 0 ? [db.insert(deductionLedger).values({ id: crypto.randomUUID(), staffId, entry: 'opening', amount, weeksJson: weeks.length ? JSON.stringify(weeks) : null, createdAt: nowIso(), createdBy: c.var.user.id })] : []),
    ]);
    return c.json({ ok: true });
  })

  // ------------------------------------------- Government Deduction Refund (ADR 0010)

  /** Everyone with Government Deductions, what they owe now, and any refund already set. */
  .get('/deduction-refunds', async (c) => {
    if (!canRefund(c)) return fail(c, 403, 'forbidden', 'Only the Super Admin sets refunds.');
    const db = c.var.db;
    const [people, balances, refunds] = await Promise.all([
      db
        .select()
        .from(staff)
        .where(and(inArray(staff.kind, ['therapist', 'receptionist']), eq(staff.isOnCall, false)))
        .orderBy(asc(staff.kind), asc(staff.displayName)),
      deductionBalances(db),
      db.select().from(deductionRefunds),
    ]);
    const shown = people.filter((p) => refunds.some((r) => r.staffId === p.id) || (p.active && !p.notEnrolled));
    const ledger = await ledgerLines(db, shown.filter((p) => p.kind === 'therapist').map((p) => p.id));
    const rows = shown.length
      ? await db
          .select({ staffId: payrolls.staffId, weekStart: payrolls.weekStart, status: payrolls.status })
          .from(payrolls)
          .where(inArray(payrolls.staffId, shown.map((p) => p.id)))
      : [];
    const statusOf = (staffId: string, start: string) => rows.find((r) => r.staffId === staffId && r.weekStart === start)?.status ?? null;
    return c.json({
      plan: await refundStatus(db, today()),
      people: shown.map((p) => {
        const kind = p.kind as 'therapist' | 'receptionist';
        const refund = refunds.find((r) => r.staffId === p.id);
        // The last finished Pay Week and the four after it.
        const first = lastCompletedPayWeek(today(), kind).start;
        return {
          staffId: p.id,
          displayName: p.displayName,
          kind,
          owed: kind === 'therapist' ? (balances.get(p.id) ?? 0) : 0,
          owedWeeks: kind === 'therapist' ? deductionsOwed(ledger, p.id).weeks : [],
          weeks: [0, 1, 2, 3, 4].map((i) => {
            const start = shiftWeek(first, i);
            return { weekStart: start, number: weekNumber(start), status: statusOf(p.id, start) };
          }),
          refund: refund ? { ...refundOut(refund), status: statusOf(p.id, refund.weekStart) } : null,
        };
      }),
    });
  })

  /** The payout date and the to-do steps the Super Admin has ticked. */
  .put('/deduction-refunds/plan', zValidator('json', refundPlanBody, invalidInput), async (c) => {
    if (!canRefund(c)) return fail(c, 403, 'forbidden', 'Only the Super Admin sets refunds.');
    const db = c.var.db;
    const value = c.req.valid('json');
    const now = nowIso();
    await db.batch([
      db
        .insert(payRules)
        .values({ key: REFUND_PLAN_KEY, valueJson: JSON.stringify(value), updatedAt: now, updatedBy: c.var.user.id })
        .onConflictDoUpdate({ target: payRules.key, set: { valueJson: JSON.stringify(value), updatedAt: now, updatedBy: c.var.user.id } }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'deduction_refund.plan', entity: 'pay_rule', entityId: REFUND_PLAN_KEY, after: value }),
    ]);
    return c.json(await refundStatus(db, today()));
  })

  /** Sets a staff member's refund: it clears what they owe first, and the rest is added to the chosen Payroll. */
  .post('/deduction-refunds', zValidator('json', refundBody, invalidInput), async (c) => {
    if (!canRefund(c)) return fail(c, 403, 'forbidden', 'Only the Super Admin sets refunds.');
    const db = c.var.db;
    const input = c.req.valid('json');
    const person = await db.select().from(staff).where(eq(staff.id, input.staffId)).get();
    if (!person || (person.kind !== 'therapist' && person.kind !== 'receptionist') || person.isOnCall) return fail(c, 404, 'not_found', 'Staff member not found.');
    const kind = person.kind;
    if (payWeekOf(input.weekStart, kind).start !== input.weekStart)
      return fail(c, 422, 'invalid_week', kind === 'therapist' ? 'A Therapist’s Pay Week starts on a Monday.' : 'The Receptionist’s Pay Week starts on a Sunday.');
    const total = input.sss + input.phic + input.pagibig;
    if (total <= 0) return fail(c, 422, 'nothing_to_refund', 'The refund must be more than zero. Someone who was not over-deducted gets nothing.');
    if (await db.select({ id: deductionRefunds.id }).from(deductionRefunds).where(eq(deductionRefunds.staffId, person.id)).get())
      return fail(c, 409, 'already_set', `${person.displayName} already has a refund. Remove it first to change it.`);
    const row = await db
      .select()
      .from(payrolls)
      .where(and(eq(payrolls.staffId, person.id), eq(payrolls.weekStart, input.weekStart)))
      .get();
    if (row && row.status !== 'draft') return fail(c, 409, 'not_draft', 'That week’s Payroll is already approved. Pick a later week, or send the Payroll back to draft first.');
    const owed = kind === 'therapist' ? ((await deductionBalances(db, [person.id])).get(person.id) ?? 0) : 0;
    const { applied, cash } = refundSplit(total, owed);
    const now = nowIso();
    const adjustment =
      cash > 0
        ? {
            id: crypto.randomUUID(),
            weekStart: input.weekStart,
            staffId: person.id,
            label: REFUND_LABEL,
            amount: cash,
            reason: `SSS ${pesoText(input.sss)}, PhilHealth ${pesoText(input.phic)}, Pag-IBIG ${pesoText(input.pagibig)}; ${pesoText(applied)} applied to Deferred Deductions (ADR 0010).`,
            createdAt: now,
            createdBy: c.var.user.id,
          }
        : null;
    const refund = {
      id: crypto.randomUUID(),
      staffId: person.id,
      weekStart: input.weekStart,
      sss: input.sss,
      phic: input.phic,
      pagibig: input.pagibig,
      applied,
      cash,
      adjustmentId: adjustment?.id ?? null,
      createdAt: now,
      createdBy: c.var.user.id,
    };
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'deduction_refund.set', entity: 'staff', entityId: person.id, after: refund }),
      ...(adjustment ? [db.insert(payrollAdjustments).values(adjustment)] : []),
      db.insert(deductionRefunds).values(refund),
      ...(applied > 0 ? [db.insert(deductionLedger).values({ id: crypto.randomUUID(), staffId: person.id, entry: 'refund', amount: applied, createdAt: now, createdBy: c.var.user.id })] : []),
      ...(row && adjustment ? [db.update(payrolls).set({ gross: row.gross + cash, net: row.net + cash }).where(eq(payrolls.id, row.id))] : []),
    ]);
    if (row) await refreshDraft(db, row);
    return c.json(refundOut(refund), 201);
  })

  /** Takes a refund back while its Payroll is still a draft. */
  .delete('/deduction-refunds/:staffId', async (c) => {
    if (!canRefund(c)) return fail(c, 403, 'forbidden', 'Only the Super Admin sets refunds.');
    const db = c.var.db;
    const refund = await db.select().from(deductionRefunds).where(eq(deductionRefunds.staffId, c.req.param('staffId'))).get();
    if (!refund) return fail(c, 404, 'not_found', 'No refund to remove.');
    const row = await db
      .select()
      .from(payrolls)
      .where(and(eq(payrolls.staffId, refund.staffId), eq(payrolls.weekStart, refund.weekStart)))
      .get();
    if (row && row.status !== 'draft') return fail(c, 409, 'not_draft', 'That week’s Payroll is already approved. Send it back to draft first.');
    await db.batch([
      db.delete(deductionRefunds).where(eq(deductionRefunds.id, refund.id)),
      ...(refund.adjustmentId ? [db.delete(payrollAdjustments).where(eq(payrollAdjustments.id, refund.adjustmentId))] : []),
      db.delete(deductionLedger).where(and(eq(deductionLedger.staffId, refund.staffId), eq(deductionLedger.entry, 'refund'))),
      ...(row && refund.cash ? [db.update(payrolls).set({ gross: row.gross - refund.cash, net: row.net - refund.cash }).where(eq(payrolls.id, row.id))] : []),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'deduction_refund.remove', entity: 'staff', entityId: refund.staffId, before: refund }),
    ]);
    if (row) await refreshDraft(db, row);
    return c.json({ ok: true });
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

  /** The percentage that shares the chosen part of the profit, what each choice costs, and who it goes to. */
  .get(
    '/bonuses/year-end/suggestion',
    zValidator('query', z.object({ year: z.coerce.number().pipe(year), share: z.coerce.number().int().min(0).max(10_000).default(DEFAULT_PROFIT_SHARE_BP) }), invalidInput),
    async (c) => {
      if (!can(c.var.user.role, 'payroll.therapist.approve')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets bonuses.');
      const { year: y, share } = c.req.valid('query');
      const db = c.var.db;
      const period = await bonusWindow(db, y);
      const [totals, balances, statement, thirteenth] = await Promise.all([
        commissionByTherapist(db, period),
        deductionBalances(db),
        statementFor(db, period.start, period.end),
        thirteenthFor(db, y),
      ]);
      const names = new Map((await db.select({ id: staff.id, displayName: staff.displayName }).from(staff)).map((p) => [p.id, p.displayName]));
      const commission = [...totals.values()].reduce((s, t) => s + t, 0);
      // Bonuses already paid are what is being decided, so they don't count against the profit.
      const paidOut = statement.costs.filter((l) => l.label === 'Year-end bonus' || l.label === '13th month pay').reduce((s, l) => s + l.amount, 0);
      const before = statement.net + paidOut;
      const profit = before - thirteenth;
      return c.json({
        period,
        shareBp: share,
        commission,
        profitBefore: before,
        thirteenthMonth: thirteenth,
        profit,
        ...suggestBonus({ profit, commission, shareBp: share }),
        lines: [...totals]
          .map(([staffId, total]) => ({ staffId, displayName: names.get(staffId) ?? '', commission: total, deferred: Math.max(0, balances.get(staffId) ?? 0) }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      });
    },
  )

  /** Year-end Bonus for every Therapist: Commission since the last cut-off × the chosen percentage, less Deferred Deductions. */
  .post('/bonuses/year-end', zValidator('json', z.object({ year, bp: z.number().int().min(1).max(10_000) }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'payroll.therapist.approve')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets bonuses.');
    const { year: y, bp } = c.req.valid('json');
    const db = c.var.db;
    const period = await bonusWindow(db, y);
    if (period.end < period.start) return fail(c, 409, 'no_finished_weeks', 'No Pay Week has finished since the last cut-off.');
    const [totals, balances] = await Promise.all([commissionByTherapist(db, period), deductionBalances(db)]);
    return saveBonuses(c, y, 'year_end_bonus', [...totals].map(([staffId, basis]) => {
      const amount = yearEndBonus(basis, bp);
      return { staffId, basis, bp, amount, deduction: bonusDeduction(amount, balances.get(staffId) ?? 0), periodStart: period.start, periodEnd: period.end };
    }));
  })

  /** 13th Month Pay for the Receptionist: the year's basic pay ÷ 12, opening figure included. */
  .post('/bonuses/thirteenth-month', zValidator('json', z.object({ year }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'payroll.receptionist.manage')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets bonuses.');
    const { year: y } = c.req.valid('json');
    const basis = await basicPayFor(c.var.db, y);
    return saveBonuses(c, y, 'thirteenth_month', [...basis].map(([staffId, b]) => ({ staffId, basis: b, bp: null, amount: thirteenthMonth(b) })));
  })

  /** Basic pay earned before Go-live, with what the Past Payslips add up to. */
  .get('/bonuses/opening-basic', zValidator('query', z.object({ year: z.coerce.number().pipe(year) }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'payroll.receptionist.manage')) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    const y = c.req.valid('query').year;
    const db = c.var.db;
    const [people, openings, past] = await Promise.all([
      db.select().from(staff).where(eq(staff.kind, 'receptionist')).orderBy(asc(staff.displayName)),
      db.select().from(openingBasicPay).where(eq(openingBasicPay.year, y)),
      db
        .select({ staffId: pastPayslips.staffId, total: sql<number>`sum(${pastPayslips.basic} - ${pastPayslips.lateUndertime})` })
        .from(pastPayslips)
        .where(and(gte(pastPayslips.weekStart, `${y}-01-01`), lte(pastPayslips.weekStart, `${y}-12-31`)))
        .groupBy(pastPayslips.staffId),
    ]);
    return c.json({
      people: people
        .filter((p) => p.active || openings.some((o) => o.staffId === p.id) || past.some((r) => r.staffId === p.id))
        .map((p) => ({
          staffId: p.id,
          displayName: p.displayName,
          amount: openings.find((o) => o.staffId === p.id)?.amount ?? null,
          suggested: Number(past.find((r) => r.staffId === p.id)?.total ?? 0),
        })),
    });
  })

  .put('/bonuses/opening-basic', zValidator('json', z.object({ year, staffId: z.string().min(1), amount: centavos }), invalidInput), async (c) => {
    if (!can(c.var.user.role, 'payroll.receptionist.manage')) return fail(c, 403, 'forbidden', 'Only the Super Admin sets opening figures.');
    const { year: y, staffId, amount } = c.req.valid('json');
    const db = c.var.db;
    const person = await db.select().from(staff).where(eq(staff.id, staffId)).get();
    if (!person || person.kind !== 'receptionist') return fail(c, 404, 'not_found', 'Receptionist not found.');
    const scope = and(eq(openingBasicPay.year, y), eq(openingBasicPay.staffId, staffId));
    const before = await db.select().from(openingBasicPay).where(scope).get();
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'bonus.opening_basic', entity: 'staff', entityId: staffId, before: before?.amount ?? 0, after: { year: y, amount } }),
      db.delete(openingBasicPay).where(scope),
      db.insert(openingBasicPay).values({ id: crypto.randomUUID(), year: y, staffId, amount, updatedAt: nowIso(), updatedBy: c.var.user.id }),
    ]);
    return c.json({ ok: true });
  })

  .post('/bonuses/:id/paid', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(bonuses).where(eq(bonuses.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Bonus not found.');
    if (!can(c.var.user.role, APPROVE[row.kind === 'year_end_bonus' ? 'therapist' : 'receptionist'])) return fail(c, 403, 'forbidden', 'You do not have access to this.');
    if (row.paidAt) return fail(c, 409, 'already_paid', 'Already marked paid.');
    if (row.kind === 'year_end_bonus') {
      const owed = (await deductionBalances(db, [row.staffId])).get(row.staffId) ?? 0;
      if (bonusDeduction(row.amount, owed) !== row.deduction) return fail(c, 409, 'stale', 'Deferred Deductions changed since this was computed. Compute again first.');
    }
    const now = nowIso();
    await db.batch([
      db.update(bonuses).set({ paidAt: now }).where(eq(bonuses.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'bonus.paid', entity: 'bonus', entityId: row.id, after: { amount: row.amount, deduction: row.deduction } }),
      ...(row.deduction > 0
        ? [db.insert(deductionLedger).values({ id: crypto.randomUUID(), staffId: row.staffId, entry: 'bonus', amount: row.deduction, createdAt: now, createdBy: c.var.user.id })]
        : []),
    ]);
    return c.json({ ok: true });
  });

/** The cut-off: fixed once any of the year's bonuses is paid, otherwise the last finished Pay Week. */
async function bonusWindow(db: Db, y: number): Promise<PayWeek> {
  const ofYear = (year: number) => and(eq(bonuses.year, year), eq(bonuses.kind, 'year_end_bonus'));
  const kept = await db.select({ start: bonuses.periodStart, end: bonuses.periodEnd }).from(bonuses).where(and(ofYear(y), isNotNull(bonuses.paidAt))).limit(1).get();
  if (kept?.start && kept.end) return { start: kept.start, end: kept.end };
  const last = await db.select({ end: sql<string | null>`max(${bonuses.periodEnd})` }).from(bonuses).where(ofYear(y - 1)).get();
  return bonusPeriod(y, last?.end ?? null, businessDayOf(new Date()));
}

/** Commission per Therapist: weekly sheet data plus live Sales. On-call Therapists get no bonus. */
async function commissionByTherapist(db: Db, period: PayWeek) {
  const [live, past] = await Promise.all([
    db
      .select({ staffId: sales.therapistId, total: sql<number>`sum(${sales.commissionAmount})` })
      .from(sales)
      .innerJoin(staff, eq(staff.id, sales.therapistId))
      .where(and(eq(sales.status, 'paid'), eq(staff.isOnCall, false), gte(sales.businessDay, period.start), lte(sales.businessDay, period.end)))
      .groupBy(sales.therapistId),
    db
      .select({ staffId: pastTherapistWeeks.staffId, total: sql<number>`sum(${pastTherapistWeeks.gross})` })
      .from(pastTherapistWeeks)
      .innerJoin(staff, eq(staff.id, pastTherapistWeeks.staffId))
      .where(and(eq(staff.isOnCall, false), gte(pastTherapistWeeks.weekStart, period.start), lte(pastTherapistWeeks.weekStart, period.end)))
      .groupBy(pastTherapistWeeks.staffId),
  ]);
  const totals = new Map<string, number>();
  for (const r of [...live, ...past]) if (r.staffId) totals.set(r.staffId, (totals.get(r.staffId) ?? 0) + Number(r.total));
  return totals;
}

/** A year's basic pay per Receptionist: the opening figure plus approved Payrolls. */
async function basicPayFor(db: Db, y: number) {
  // A Pay Week can straddle New Year, so count each day in its own year.
  const [rows, openings] = await Promise.all([
    db
      .select({ staffId: payrolls.staffId, breakdownJson: payrolls.breakdownJson })
      .from(payrolls)
      .where(and(eq(payrolls.kind, 'receptionist'), ne(payrolls.status, 'draft'), gte(payrolls.weekStart, `${y - 1}-12-25`), lte(payrolls.weekStart, `${y}-12-31`))),
    db.select().from(openingBasicPay).where(eq(openingBasicPay.year, y)),
  ]);
  const basis = new Map(openings.map((o) => [o.staffId, o.amount]));
  for (const r of rows) {
    const days = JSON.parse(r.breakdownJson) as ReceptionistDay[];
    const inYear = days.filter((d) => d.date.startsWith(`${y}-`)).reduce((s, d) => s + d.basic, 0);
    basis.set(r.staffId, (basis.get(r.staffId) ?? 0) + inYear);
  }
  return basis;
}

/** The year's 13th Month Pay: as computed, otherwise what the basic pay so far gives. */
async function thirteenthFor(db: Db, y: number) {
  const saved = await db.select({ amount: bonuses.amount }).from(bonuses).where(and(eq(bonuses.year, y), eq(bonuses.kind, 'thirteenth_month')));
  if (saved.length) return saved.reduce((s, b) => s + b.amount, 0);
  return [...(await basicPayFor(db, y)).values()].reduce((s, b) => s + thirteenthMonth(b), 0);
}

/** Replaces the year's unpaid bonuses of that kind; paid ones stay as they were. */
async function saveBonuses(
  c: Context<AuthedEnv>,
  y: number,
  kind: (typeof bonuses.$inferSelect)['kind'],
  lines: { staffId: string; basis: number; bp: number | null; amount: number; deduction?: number; periodStart?: string; periodEnd?: string }[],
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
