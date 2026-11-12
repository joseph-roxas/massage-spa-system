import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { DEFAULT_REFUND_PLAN, payWeekEndsIn, refundChecklist, type IsoDate, type RefundPlan } from '@spa/domain';
import { deductionRefunds, payRules, payrolls, staff } from '@spa/db';

export const REFUND_PLAN_KEY = 'deduction_refund_plan';

/** The last month the refund covers; its last Pay Weeks must be final before it is worked out. */
const COVERED_TO = '2026-11';

const weekStartOf = (end: string) => {
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
};

export async function refundPlan(db: DrizzleD1Database): Promise<RefundPlan> {
  const row = await db.select().from(payRules).where(eq(payRules.key, REFUND_PLAN_KEY)).get();
  return row ? { ...DEFAULT_REFUND_PLAN, ...(JSON.parse(row.valueJson) as Partial<RefundPlan>) } : DEFAULT_REFUND_PLAN;
}

/** The refund's to-do list and whether the Super Admin should be reminded (ADR 0010). */
export async function refundStatus(db: DrizzleD1Database, today: string) {
  const lastWeek = { therapist: weekStartOf(payWeekEndsIn(COVERED_TO, 0).at(-1)!), receptionist: weekStartOf(payWeekEndsIn(COVERED_TO, 6).at(-1)!) };
  const [plan, people, refunds] = await Promise.all([
    refundPlan(db),
    db
      .select()
      .from(staff)
      .where(and(eq(staff.active, true), eq(staff.isOnCall, false), eq(staff.notEnrolled, false), inArray(staff.kind, ['therapist', 'receptionist']))),
    db.select().from(deductionRefunds),
  ]);
  const ids = [...new Set([...people.map((p) => p.id), ...refunds.map((r) => r.staffId)])];
  const rows = ids.length ? await db.select({ staffId: payrolls.staffId, weekStart: payrolls.weekStart, status: payrolls.status }).from(payrolls).where(inArray(payrolls.staffId, ids)) : [];
  const statusOf = (staffId: string, weekStart: string) => rows.find((r) => r.staffId === staffId && r.weekStart === weekStart)?.status ?? null;
  const novemberFinal = people.every((p) => {
    const s = statusOf(p.id, lastWeek[p.kind as 'therapist' | 'receptionist']);
    return s === 'approved' || s === 'released';
  });
  return {
    payoutDate: plan.payoutDate,
    ticked: plan.ticked,
    ...refundChecklist({
      today: today as IsoDate,
      plan,
      novemberFinal,
      entered: refunds.length,
      eligible: people.length,
      payrolls: refunds.map((r) => statusOf(r.staffId, r.weekStart)),
    }),
  };
}
