import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { branding, bonuses, cashOuts, pastPayslips, pastTherapistWeeks, payrolls, staff } from '@spa/db';
import { businessDayOf, PAY_PERIODS, payPeriodRange, payWeekMiddle, payWeekOf } from '@spa/domain';
import type { AuthedEnv } from '../env';
import { requireAuth, requireCapability } from '../auth/middleware';
import { invalidInput } from '../lib/http';
import { isoDate } from '../lib/validation';
import { goLiveDate } from '../lib/pay-rules';

type Line = { staffId: string; kind: string; day: string; gross: number; gov: number; ca: number; net: number };

/**
 * What the shop paid in a week, month or year: live Payrolls plus the records
 * from before Go-live. A Payroll counts in the period holding its middle day.
 */
export const payrollTotalsRoutes = new Hono<AuthedEnv>().get(
  '/payroll/totals',
  requireAuth,
  requireCapability('payroll.therapist.approve'),
  zValidator('query', z.object({ period: z.enum(PAY_PERIODS), date: isoDate.optional() }), invalidInput),
  async (c) => {
    const db = c.var.db;
    const { period, date } = c.req.valid('query');
    const { from, to } = payPeriodRange(period, date ?? businessDayOf(new Date()));
    const goLive = await goLiveDate(db);
    const earliest = new Date(Date.parse(`${from}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10); // a week whose middle is `from`
    const [live, pastWeeks, pastSlips, people, onCall, paidBonuses, business] = await Promise.all([
      db.select().from(payrolls).where(and(gte(payrolls.weekStart, earliest), lte(payrolls.weekStart, to))),
      db.select().from(pastTherapistWeeks).where(and(gte(pastTherapistWeeks.weekStart, earliest), lte(pastTherapistWeeks.weekStart, to))),
      db.select().from(pastPayslips).where(and(gte(pastPayslips.weekStart, earliest), lte(pastPayslips.weekStart, to))),
      db.select().from(staff),
      db
        .select({ total: sql<number>`sum(${cashOuts.amount})` })
        .from(cashOuts)
        .where(and(eq(cashOuts.category, 'on_call_commission'), gte(cashOuts.businessDay, from), lte(cashOuts.businessDay, to)))
        .get(),
      period === 'year'
        ? db
            .select({ kind: bonuses.kind, amount: bonuses.amount })
            .from(bonuses)
            .where(and(eq(bonuses.year, Number(from.slice(0, 4))), isNotNull(bonuses.paidAt)))
        : Promise.resolve([]),
      db.select({ businessName: branding.businessName, tin: branding.tin, address: branding.address }).from(branding).get(),
    ]);

    const firstLiveWeek = payWeekOf(goLive, 'therapist').start;
    const inPeriod = (day: string) => day >= from && day <= to;
    const liveKeys = new Set(live.map((p) => `${p.staffId}:${p.weekStart}`));
    const lines: Line[] = [
      ...live
        .map((p) => ({ staffId: p.staffId, kind: p.kind, day: payWeekMiddle(p.weekStart), gross: p.gross, gov: p.govSss + p.govPhic + p.govPagibig - p.govDeferred + p.govCollected, ca: p.caDeduction, net: p.net }))
        .filter((l) => inPeriod(l.day)),
      // Weeks before Go-live, from the owner's records; a week with no earnings paid nothing.
      ...pastWeeks
        .filter((w) => w.weekStart < firstLiveWeek && w.gross > 0 && !liveKeys.has(`${w.staffId}:${w.weekStart}`))
        .map((w) => ({ staffId: w.staffId, kind: 'therapist', day: payWeekMiddle(w.weekStart), gross: w.gross, gov: w.gross - w.net, ca: 0, net: w.net }))
        .filter((l) => inPeriod(l.day)),
      ...pastSlips
        .filter((s) => !liveKeys.has(`${s.staffId}:${s.weekStart}`))
        .map((s) => ({ staffId: s.staffId, kind: 'receptionist', day: payWeekMiddle(s.weekStart), gross: s.gross, gov: s.sss + s.phic + s.hdmf, ca: s.caRepayment, net: s.net }))
        .filter((l) => inPeriod(l.day)),
    ];

    const byPerson = new Map<string, Omit<Line, 'staffId' | 'day' | 'kind'> & { kind: string }>();
    for (const l of lines) {
      const row = byPerson.get(l.staffId) ?? { kind: l.kind, gross: 0, gov: 0, ca: 0, net: 0 };
      row.gross += l.gross;
      row.gov += l.gov;
      row.ca += l.ca;
      row.net += l.net;
      byPerson.set(l.staffId, row);
    }
    const months = new Map<string, { month: string; therapists: number; receptionist: number; relievers: number; total: number }>();
    for (const l of lines) {
      const month = l.day.slice(0, 7);
      const row = months.get(month) ?? { month, therapists: 0, receptionist: 0, relievers: 0, total: 0 };
      if (l.kind === 'therapist') row.therapists += l.gross;
      else if (l.kind === 'receptionist') row.receptionist += l.gross;
      else row.relievers += l.gross;
      row.total += l.gross;
      months.set(month, row);
    }
    const ORDER: Record<string, number> = { therapist: 0, receptionist: 1, reliever: 2 };
    return c.json({
      period,
      from,
      to,
      drafts: live.filter((p) => p.status === 'draft' && inPeriod(payWeekMiddle(p.weekStart))).length,
      business: { name: business?.businessName ?? null, tin: business?.tin ?? null, address: business?.address ?? null },
      people: [...byPerson]
        .map(([staffId, row]) => {
          const p = people.find((x) => x.id === staffId)!;
          return { staffId, displayName: p.displayName, firstName: p.firstName, middleName: p.middleName, lastName: p.lastName, civilStatus: p.civilStatus, notEnrolled: p.notEnrolled, salaryBasis: p.contributionBase, ...row };
        })
        .sort((a, b) => (ORDER[a.kind] ?? 3) - (ORDER[b.kind] ?? 3) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)),
      months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      onCall: Number(onCall?.total ?? 0),
      bonuses: {
        yearEnd: paidBonuses.filter((b) => b.kind === 'year_end_bonus').reduce((s, b) => s + b.amount, 0),
        thirteenth: paidBonuses.filter((b) => b.kind === 'thirteenth_month').reduce((s, b) => s + b.amount, 0),
      },
    });
  },
);
