import type { IsoDate } from './calendar';

/** How far back a Laundry Breakdown may reach: the 14 days up to today. */
export const LAUNDRY_DAYS_BACK = 13;

export type LaundryDay = { day: IsoDate; amount: number };

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first day a Laundry Breakdown made today may cover. */
export const earliestLaundryDay = (today: IsoDate): IsoDate => addDays(today, -LAUNDRY_DAYS_BACK);

/** The Laundry payment: the total of its days, never typed. */
export const laundryTotal = (days: readonly LaundryDay[]): number => days.reduce((s, d) => s + d.amount, 0);

/** Why a Laundry Breakdown can't be saved, or null. */
export function laundryBreakdownProblem(days: readonly LaundryDay[], today: IsoDate): string | null {
  if (!days.length) return 'Add at least one day of laundry.';
  const from = earliestLaundryDay(today);
  const seen = new Set<string>();
  for (const d of days) {
    if (d.day > today) return 'Laundry can’t be paid for a day that hasn’t come yet.';
    if (d.day < from) return 'Only the last 14 days of laundry can be entered.';
    if (seen.has(d.day)) return 'Each day can appear only once. Add its amounts together.';
    if (!(d.amount > 0)) return 'Each day needs an amount due.';
    seen.add(d.day);
  }
  return null;
}

/** Days in this breakdown already covered by an earlier Laundry payment: a warning only. */
export const laundryDaysPaidBefore = (days: readonly LaundryDay[], paid: readonly IsoDate[]): IsoDate[] => days.map((d) => d.day).filter((d) => paid.includes(d));

/** Days, sorted, from a stored breakdown. */
export function parseLaundryBreakdown(json: string | null): LaundryDay[] | null {
  if (!json) return null;
  return (JSON.parse(json) as LaundryDay[]).slice().sort((a, b) => a.day.localeCompare(b.day));
}
