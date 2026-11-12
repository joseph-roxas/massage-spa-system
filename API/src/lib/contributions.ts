import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { monthlyContributions, withDefaultRates, weeklyPart, type ContributionRates, type Contributions } from '@spa/domain';
import { payRules, staff } from '@spa/db';

type Staff = typeof staff.$inferSelect;

/** The rates in Settings over the defaults. */
export async function contributionRates(db: DrizzleD1Database): Promise<ContributionRates> {
  const row = await db.select().from(payRules).where(eq(payRules.key, 'contribution_rates')).get();
  return withDefaultRates(row ? (JSON.parse(row.valueJson) as Partial<ContributionRates>) : null);
}

/** A staff member's monthly shares from their salary basis, or null (On-call, or no basis set). */
export function contributionsOf(person: Staff, rates: ContributionRates): Contributions | null {
  if (person.isOnCall || person.notEnrolled || person.contributionBase == null) return null;
  return monthlyContributions(person.contributionBase, rates, { sss: !!person.sssNo?.trim(), phic: !!person.phicNo?.trim(), pagibig: !!person.pagibigNo?.trim() });
}

/**
 * The week's Government Deductions: the monthly employee share split over the
 * Pay Weeks ending in the month, or the older fixed weekly amounts.
 */
export function weeklyDeductions(person: Staff, rates: ContributionRates, weekEnd: string) {
  if (person.notEnrolled) return { sss: 0, phic: 0, pagibig: 0 };
  const c = contributionsOf(person, rates);
  if (!c) return { sss: person.govSss, phic: person.govPhic, pagibig: person.govPagibig };
  return { sss: weeklyPart(c.sss.ee, weekEnd), phic: weeklyPart(c.phic.ee, weekEnd), pagibig: weeklyPart(c.pagibig.ee, weekEnd) };
}
