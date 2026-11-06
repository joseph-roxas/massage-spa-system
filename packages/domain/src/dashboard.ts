import type { IsoDate } from './calendar';
import type { Centavos } from './money';

/** A period's figure so far plus the daily average for the days left. */
export function projected(soFar: number, daysDone: number, daysTotal: number): Centavos {
  if (daysDone <= 0) return soFar as Centavos;
  return Math.round(soFar + (soFar / daysDone) * Math.max(0, daysTotal - daysDone)) as Centavos;
}

/** Days from `from` to `to`, both counted. */
export function daysIn(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The month `count` months before or after a YYYY-MM month. */
export function shiftMonth(month: string, count: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + count, 1));
  return d.toISOString().slice(0, 7);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Average Guests per weekday, Monday first. A month has more of some weekdays, so totals would mislead. */
export function weekdayAverages(days: readonly { date: IsoDate; guests: number }[]): { day: string; average: number }[] {
  const totals = WEEKDAYS.map(() => ({ guests: 0, days: 0 }));
  for (const d of days) {
    const slot = totals[(new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7]!;
    slot.guests += d.guests;
    slot.days += 1;
  }
  return WEEKDAYS.map((day, i) => ({ day, average: totals[i]!.days ? Math.round((totals[i]!.guests / totals[i]!.days) * 10) / 10 : 0 }));
}

export type ConsumablesTrend =
  | { status: 'building'; perGuest: Centavos }
  | { status: 'normal' | 'high'; perGuest: Centavos; average: Centavos; changeBp: number };

const TOO_MUCH_BP = 2000;

/**
 * Consumables cost per Guest against the average of the earlier full months.
 * Above +20% is using too much. With no full month yet, it is still building a baseline.
 */
export function consumablesTrend(perGuest: number, earlier: readonly number[]): ConsumablesTrend {
  if (!earlier.length) return { status: 'building', perGuest: perGuest as Centavos };
  const average = Math.round(earlier.reduce((s, x) => s + x, 0) / earlier.length);
  const changeBp = average ? Math.round(((perGuest - average) / average) * 10_000) : 0;
  return { status: changeBp > TOO_MUCH_BP ? 'high' : 'normal', perGuest: perGuest as Centavos, average: average as Centavos, changeBp };
}
