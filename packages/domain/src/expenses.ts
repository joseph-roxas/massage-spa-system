import type { IsoDate } from './calendar';
import type { Centavos } from './money';

/** A calendar month, `YYYY-MM`. */
export type Month = string;

export const DEFAULT_ROYALTY_BP = 300;

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function monthOf(date: IsoDate): Month {
  return date.slice(0, 7);
}

/** First and last day of the month, as the Royalty statement describes it. */
export function monthRange(month: Month): { start: IsoDate; end: IsoDate } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

export function previousMonth(month: Month): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** The date a monthly expense falls on; a day past the month's end becomes its last day. */
export function recurringDate(month: Month, dayOfMonth: number): IsoDate {
  const { end } = monthRange(month);
  return `${month}-${String(Math.min(dayOfMonth, Number(end.slice(8)))).padStart(2, '0')}`;
}

/**
 * Royalty Gross Sales: what Guests paid for Services after Discounts (no
 * Add-ons, so Voucher Redemptions and Real FOCs add nothing) plus Vouchers
 * sold in the month.
 */
export function royaltyGross(serviceAmounts: readonly number[], voucherSales: readonly number[]): Centavos {
  const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
  return (sum(serviceAmounts) + sum(voucherSales)) as Centavos;
}

export function royaltyAmount(gross: number, bp: number): Centavos {
  return Math.round((gross * bp) / 10_000) as Centavos;
}
