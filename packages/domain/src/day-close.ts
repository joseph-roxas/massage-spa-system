import type { Centavos } from './money';
import type { PaymentMethod } from './pricing';

/** Closing the shop before this is an Early Close. */
export const SHOP_CLOSING_TIME = '23:00';

export type DayTotals = {
  /** Sales Cash already in the shop when this count started (ADR 0003). */
  carriedIn: Centavos;
  cashIn: Centavos;
  gcashIn: Centavos;
  /** Cash-outs paid from Sales Cash; petty cash comes from its own fund. */
  cashOut: Centavos;
  /** Payroll paid from the shop, Petty Cash Top-ups and Cash Handovers. */
  transfersOut: Centavos;
  /** All Sales Cash that should be in the shop. */
  expectedCash: Centavos;
  expectedGcash: Centavos;
};

export function dayTotals(
  payments: readonly { method: PaymentMethod; amount: number }[],
  cashOuts: readonly { amount: number }[],
  carry: { carriedIn?: number; transfersOut?: number } = {},
): DayTotals {
  const sum = (xs: readonly { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0) as Centavos;
  const cashIn = sum(payments.filter((p) => p.method === 'cash'));
  const gcashIn = sum(payments.filter((p) => p.method === 'gcash'));
  const cashOut = sum(cashOuts);
  const carriedIn = (carry.carriedIn ?? 0) as Centavos;
  const transfersOut = (carry.transfersOut ?? 0) as Centavos;
  return {
    carriedIn,
    cashIn,
    gcashIn,
    cashOut,
    transfersOut,
    expectedCash: (carriedIn + cashIn - cashOut - transfersOut) as Centavos,
    expectedGcash: gcashIn,
  };
}

/**
 * What each On-call Therapist is still owed for the day: their Commission
 * less any on-call Cash-outs already paid to them.
 */
export function onCallOwed(
  commissions: readonly { staffId: string; amount: number }[],
  paid: readonly { staffId: string; amount: number }[],
): { staffId: string; amount: Centavos }[] {
  const owed = new Map<string, number>();
  for (const c of commissions) owed.set(c.staffId, (owed.get(c.staffId) ?? 0) + c.amount);
  for (const p of paid) owed.set(p.staffId, (owed.get(p.staffId) ?? 0) - p.amount);
  return [...owed]
    .filter(([, amount]) => amount > 0)
    .map(([staffId, amount]) => ({ staffId, amount: amount as Centavos }));
}
