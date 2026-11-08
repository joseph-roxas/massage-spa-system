import { z } from 'zod';
import { isHhMm, isIsoDate, properName, toManila } from '@spa/domain';

export const isoDate = z.string().refine(isIsoDate, 'Use a real date as YYYY-MM-DD.');
export const hhmm = z.string().refine(isHhMm, 'Use a 24-hour time as HH:MM.');
/** Money in centavos. */
export const centavos = z.number().int().min(0).max(100_000_000);
/** Percentage in basis points: 10000 = 100%. */
export const basisPoints = z.number().int().min(0).max(10_000);
export const name = z.string().trim().min(1).max(120);
/** A first name or surname, saved with each word capitalized. */
export const personName = name.transform(properName);

export function todayInManila(): string {
  return toManila(new Date()).date;
}

/** For changes that take effect on a date: today or later, so recorded history never shifts. */
export const notInPast = (field: string) =>
  isoDate.refine((d) => d >= todayInManila(), `${field} cannot be in the past.`);
