import { manilaInstant } from './business-day';

/** The week run on paper before the Front Desk went live, entered afterwards as real Sales (ADR 0009). */
export const CATCH_UP_DAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'] as const;

/** A time on a Business Day; before 6:00am belongs to the night that day opened, so it is the next calendar date. */
export function onBusinessDay(date: string, time: string): Date {
  const at = manilaInstant(date, time);
  if (time < '06:00') at.setUTCDate(at.getUTCDate() + 1);
  return at;
}
