import type { IsoDate } from './calendar';

/** A Guest is a Regular after `visits` Visits within the last `days` days. */
export type RegularRule = { visits: number; days: number };

export const DEFAULT_REGULAR_RULE: RegularRule = { visits: 3, days: 90 };

export type VisitStats = {
  visits: number;
  lastVisit: IsoDate | null;
  /** Visits inside the Regular window. */
  recentVisits: number;
  isRegular: boolean;
  /** Average days from one Visit to the next; null with fewer than two Visits. */
  avgDaysBetween: number | null;
};

const dayNumber = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

/**
 * What a Guest's Visits say about them. `visitDays` are the Business Days with a
 * checked-out Booking; repeats are one Visit.
 */
export function visitStats(visitDays: readonly IsoDate[], today: IsoDate, rule: RegularRule): VisitStats {
  const days = [...new Set(visitDays)].sort();
  const since = dayNumber(today) - rule.days;
  const recentVisits = days.filter((d) => dayNumber(d) > since).length;
  const span = days.length > 1 ? dayNumber(days.at(-1)!) - dayNumber(days[0]!) : null;
  return {
    visits: days.length,
    lastVisit: days.at(-1) ?? null,
    recentVisits,
    isRegular: recentVisits >= rule.visits,
    avgDaysBetween: span === null ? null : Math.round((span / (days.length - 1)) * 10) / 10,
  };
}

/** A saved SC/PWD ID shown only by its last four characters. */
export function maskId(id: string | null): string | null {
  if (!id) return null;
  const tail = id.replace(/\s+/g, '').slice(-4);
  return `••••${tail}`;
}
