import type { IsoDate } from './calendar';
import type { Centavos } from './money';

/**
 * SSS, PhilHealth and Pag-IBIG rates, kept in Settings so they can follow
 * the agencies' circulars. Money in centavos, rates in basis points.
 */
export type ContributionRates = {
  /** 15% of the Monthly Salary Credit: employee 5%, employer 10%, plus employer-only EC. */
  sss: { eeBp: number; erBp: number; mscMin: number; mscMax: number; mscStep: number; ecLow: number; ecHigh: number; ecHighFromMsc: number };
  /** 5% of the salary between the floor and ceiling, split equally. */
  phic: { bp: number; floor: number; ceiling: number };
  /** 2% each on the fund salary up to its maximum; 1% for the employee at or below `lowUpTo`. */
  pagibig: { eeBp: number; eeLowBp: number; lowUpTo: number; erBp: number; fundSalaryMax: number };
};

/** SSS Circular 2024-006, PhilHealth Advisory 2025-0002, HDMF Circular 460 (rates in force from 2025). */
export const DEFAULT_CONTRIBUTION_RATES: ContributionRates = {
  sss: { eeBp: 500, erBp: 1000, mscMin: 500_000, mscMax: 3_500_000, mscStep: 50_000, ecLow: 1_000, ecHigh: 3_000, ecHighFromMsc: 1_500_000 },
  phic: { bp: 500, floor: 1_000_000, ceiling: 10_000_000 },
  pagibig: { eeBp: 200, eeLowBp: 100, lowUpTo: 150_000, erBp: 200, fundSalaryMax: 1_000_000 },
};

const pct = (amount: number, bp: number) => Math.round((amount * bp) / 10_000);

/** The SSS Monthly Salary Credit for a monthly salary: the nearest ₱500 step, within the minimum and maximum. */
export function sssMsc(salary: number, r: ContributionRates['sss']): Centavos {
  const msc = Math.round(salary / r.mscStep) * r.mscStep;
  return Math.min(r.mscMax, Math.max(r.mscMin, msc)) as Centavos;
}

export type Share = { ee: Centavos; er: Centavos };
export type Contributions = { sss: Share; phic: Share; pagibig: Share; ee: Centavos; er: Centavos };

const NONE: Share = { ee: 0 as Centavos, er: 0 as Centavos };

/**
 * The monthly employee and employer shares for a monthly salary basis. An
 * agency counts only when the staff member's ID number for it is on file.
 */
export function monthlyContributions(salary: number, r: ContributionRates, ids: { sss: boolean; phic: boolean; pagibig: boolean }): Contributions {
  const msc = sssMsc(salary, r.sss);
  const sss: Share = ids.sss ? { ee: pct(msc, r.sss.eeBp) as Centavos, er: (pct(msc, r.sss.erBp) + (msc >= r.sss.ecHighFromMsc ? r.sss.ecHigh : r.sss.ecLow)) as Centavos } : NONE;

  const premium = pct(Math.min(r.phic.ceiling, Math.max(r.phic.floor, salary)), r.phic.bp);
  const phicEe = Math.round(premium / 2);
  const phic: Share = ids.phic ? { ee: phicEe as Centavos, er: (premium - phicEe) as Centavos } : NONE;

  const fund = Math.min(salary, r.pagibig.fundSalaryMax);
  const pagibig: Share = ids.pagibig
    ? { ee: pct(fund, salary <= r.pagibig.lowUpTo ? r.pagibig.eeLowBp : r.pagibig.eeBp) as Centavos, er: pct(fund, r.pagibig.erBp) as Centavos }
    : NONE;

  return { sss, phic, pagibig, ee: (sss.ee + phic.ee + pagibig.ee) as Centavos, er: (sss.er + phic.er + pagibig.er) as Centavos };
}

/** The Saturdays of a month: each ends a Pay Week that belongs to that month. */
export function payWeekEndsIn(month: string): IsoDate[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const out: IsoDate[] = [];
  for (let d = new Date(Date.UTC(y, m - 1, 1)); d.getUTCMonth() === m - 1; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * This Pay Week's part of a monthly share: split evenly over the Pay Weeks
 * ending in the month, the last one taking the leftover centavos, so the
 * month adds up exactly to what is remitted.
 */
export function weeklyPart(monthly: number, weekEnd: IsoDate): Centavos {
  const ends = payWeekEndsIn(weekEnd.slice(0, 7));
  const each = Math.floor(monthly / ends.length);
  return (ends.indexOf(weekEnd) === ends.length - 1 ? monthly - each * (ends.length - 1) : each) as Centavos;
}
