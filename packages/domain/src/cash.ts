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

/** Saturday: the week's Petty Cash Top-up is due, with Payroll and Laundry, before the Cash Handover. */
export function isTopUpDay(date: IsoDate): boolean {
  return weekdayOf(date) === 6;
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
  /** Keep holding Sales Cash: Payroll, Laundry or the Petty Cash Top-up is still to be paid. */
  | 'hold'
  /** Hand all Sales Cash to the owner now. */
  | 'hand_over'
  /** Nothing to hand over. */
  | 'none';

/**
 * Wednesday-to-Friday sales are held for Payroll, Laundry and the Petty Cash
 * Top-up, so Thursday and Friday always hold. Saturday hands over once last
 * week's Payroll is released, Laundry is paid and petty cash is back at
 * ₱800. Sunday to Wednesday hand over whatever has built up.
 */
export function handoverReminder(input: { today: IsoDate; salesCash: number; payrollReleased: boolean; laundryPaid: boolean; pettyCashFull: boolean }): HandoverReminder {
  if (input.salesCash <= 0) return 'none';
  const day = weekdayOf(input.today);
  if (day === 4 || day === 5) return 'hold';
  if (day === 6) return input.payrollReleased && input.laundryPaid && input.pettyCashFull ? 'hand_over' : 'hold';
  return 'hand_over';
}
