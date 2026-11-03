/** A calendar date in Asia/Manila, `YYYY-MM-DD`. Compares correctly as a string. */
export type IsoDate = string;
/** A wall-clock time in Asia/Manila, `HH:MM` (24h). Compares correctly as a string. */
export type HhMm = string;

/** Manila is UTC+8 all year (no daylight saving), so a fixed offset is exact. */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export type ManilaMoment = {
  date: IsoDate;
  time: HhMm;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
};

export function toManila(instant: Date): ManilaMoment {
  const shifted = new Date(instant.getTime() + MANILA_OFFSET_MS);
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: shifted.getUTCDay() };
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isHhMm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
