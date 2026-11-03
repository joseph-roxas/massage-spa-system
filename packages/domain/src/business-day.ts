import { toManila, type IsoDate } from './calendar';

/**
 * Activity before this Manila time belongs to the previous Business Day, so a
 * late close at 1:30am still counts toward the day that opened at 2pm.
 * Day Close then locks that day; a closed day takes no new sales.
 */
export const BUSINESS_DAY_CUTOFF = '06:00';

export function businessDayOf(instant: Date): IsoDate {
  const m = toManila(instant);
  if (m.time >= BUSINESS_DAY_CUTOFF) return m.date;
  const prev = new Date(`${m.date}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  return prev.toISOString().slice(0, 10);
}

/** The instant a Manila wall-clock time happens, e.g. ("2026-11-03", "14:05"). */
export function manilaInstant(date: IsoDate, time: string): Date {
  return new Date(`${date}T${time}:00+08:00`);
}
