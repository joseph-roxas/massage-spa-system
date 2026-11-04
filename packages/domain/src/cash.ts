import type { IsoDate } from './calendar';
import type { Centavos } from './money';
import { weekdayOf } from './payroll';

/** The Petty Cash Fund kept at the shop, apart from Sales Cash. */
export const PETTY_CASH_FUND = 80_000 as Centavos;

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What's left in the Petty Cash Fund: ₱800 plus Top-ups, less petty Cash-outs. */
export function pettyCashBalance(topUps: number, pettyCashOuts: number): Centavos {
  return (PETTY_CASH_FUND + topUps - pettyCashOuts) as Centavos;
}

/** Sunday or Monday: the week's Petty Cash Top-up is due. */
export function isTopUpDay(date: IsoDate): boolean {
  return weekdayOf(date) <= 1;
}

/** The Top-up that brings the fund back to ₱800, or 0. */
export function topUpNeeded(balance: number): Centavos {
  return Math.max(0, PETTY_CASH_FUND - balance) as Centavos;
}

/**
 * Where a running count of Sales Cash starts: the latest closed day's
 * counted cash, or the Super Admin's opening count if that is later.
 * Every cash movement from `fromDay` on is added to `amount`.
 */
export function salesCashAnchor(
  lastClosed: { date: IsoDate; countedCash: number } | null,
  opening: { date: IsoDate; amount: number } | null,
): { amount: Centavos; fromDay: IsoDate } {
  if (opening && (!lastClosed || opening.date > lastClosed.date)) return { amount: opening.amount as Centavos, fromDay: opening.date };
  if (lastClosed) return { amount: lastClosed.countedCash as Centavos, fromDay: addDays(lastClosed.date, 1) };
  return { amount: 0 as Centavos, fromDay: '0000-01-01' };
}

/** The Business Day a cash movement made now counts toward: today, or the next day once today is closed. */
export function transferDay(today: IsoDate, todayClosed: boolean): IsoDate {
  return todayClosed ? addDays(today, 1) : today;
}

export type HandoverReminder =
  /** Keep holding Sales Cash: Payroll or Laundry is still to be paid. */
  | 'hold'
  /** Everything is paid: hand all Sales Cash to the owner. */
  | 'hand_over'
  /** Nothing to hand over. */
  | 'none';

/**
 * Sales Cash stays at the shop to pay Payroll and Laundry; once the last
 * completed Pay Week's Payroll is all released and Laundry is paid, the rest
 * goes to the owner.
 */
export function handoverReminder(input: { salesCash: number; payrollReleased: boolean; laundryPaid: boolean }): HandoverReminder {
  if (input.salesCash <= 0) return 'none';
  return input.payrollReleased && input.laundryPaid ? 'hand_over' : 'hold';
}
