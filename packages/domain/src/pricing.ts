import { percentOf, type Centavos } from './money';
import { promoApplies, type CommissionRate, type Promo } from './catalogue';
import type { HhMm, IsoDate } from './calendar';

/** Senior Citizen and PWD Discount, by law. */
export const STATUTORY_DISCOUNT_BP = 2000;

export type StatutoryKind = 'senior' | 'pwd';
export type DiscountType = 'none' | StatutoryKind | 'promo' | 'voucher' | 'complimentary';
export type FocKind = 'none' | 'prepaid' | 'real';

export type QuoteInput = {
  serviceId: string;
  regularPrice: Centavos;
  /** When the Service started, Manila. */
  startDate: IsoDate;
  startTime: HhMm;
  promos: readonly (Promo & { id: string; name: string })[];
  /** The Guest showed a Senior Citizen or PWD ID. */
  statutory?: StatutoryKind | null;
  /** Super Admin is giving this Service free. */
  complimentary?: boolean;
  /** The Guest is paying with a Voucher for this Service; `isFree` if it is the sixth of a Bundle. */
  voucher?: { serial: string; isFree: boolean } | null;
  addonPrices?: readonly Centavos[];
};

export type Quote = {
  regularPrice: Centavos;
  discount: { type: DiscountType; bp: number; amount: Centavos; promoId: string | null; label: string };
  /** What the Guest pays for the Service itself, after the Discount. */
  serviceAmount: Centavos;
  addonsTotal: Centavos;
  amountDue: Centavos;
  focKind: FocKind;
};

const NONE = { type: 'none', bp: 0, promoId: null, label: 'No discount' } as const;

/**
 * Prices one Service: at most one Discount, the largest the Guest qualifies
 * for (Statutory wins a tie, since it is the Guest's legal entitlement).
 * A Voucher or Complimentary Service covers the whole Service and excludes
 * every other Discount. Add-ons go on top and are never discounted.
 */
export function quoteSale(input: QuoteInput): Quote {
  const addonsTotal = (input.addonPrices ?? []).reduce((s, p) => s + p, 0) as Centavos;
  const price = input.regularPrice;

  let best: Omit<Quote['discount'], 'amount'> = NONE;
  if (input.voucher) {
    best = { type: 'voucher', bp: 10_000, promoId: null, label: `${input.voucher.isFree ? 'Free voucher' : 'Voucher'} ${input.voucher.serial}` };
  } else if (input.complimentary) {
    best = { type: 'complimentary', bp: 10_000, promoId: null, label: 'Complimentary Service' };
  } else {
    const service = { serviceId: input.serviceId, startDate: input.startDate, startTime: input.startTime };
    for (const p of input.promos) {
      if (promoApplies(p, service) && p.percentBp > best.bp) best = { type: 'promo', bp: p.percentBp, promoId: p.id, label: p.name };
    }
    if (input.statutory && STATUTORY_DISCOUNT_BP >= best.bp) {
      best = {
        type: input.statutory,
        bp: STATUTORY_DISCOUNT_BP,
        promoId: null,
        label: input.statutory === 'senior' ? 'Senior Citizen' : 'PWD',
      };
    }
  }

  const covered = best.type === 'complimentary' || best.type === 'voucher';
  const amount = covered ? price : percentOf(price, best.bp / 100);
  const serviceAmount = (price - amount) as Centavos;
  return {
    regularPrice: price,
    discount: { ...best, amount },
    serviceAmount,
    addonsTotal,
    amountDue: (serviceAmount + addonsTotal) as Centavos,
    focKind: best.type === 'complimentary' || input.voucher?.isFree ? 'real' : best.type === 'voucher' ? 'prepaid' : 'none',
  };
}

/** Commission is always on the Regular Price, whatever the Guest paid. */
export function commissionFor(regularPrice: Centavos, rate: CommissionRate, isHoliday: boolean): { bp: number; amount: Centavos } {
  const bp = isHoliday ? rate.holidayBp : rate.normalBp;
  return { bp, amount: percentOf(regularPrice, bp / 100) };
}

export type PaymentMethod = 'cash' | 'gcash';
export type PaymentLine = { method: PaymentMethod; amount: Centavos; gcashRef?: string | null };

/** Why these payments can't settle `amountDue`, or null if they do. */
export function paymentProblem(amountDue: Centavos, payments: readonly PaymentLine[]): string | null {
  if (amountDue === 0) return payments.length === 0 ? null : 'Nothing is due, so record no payment.';
  if (payments.length === 0) return 'Record how the Guest paid.';
  for (const p of payments) {
    if (!Number.isInteger(p.amount) || p.amount <= 0) return 'Each payment must be more than zero.';
    if (p.method === 'gcash' && !p.gcashRef?.trim()) return 'Enter the GCash reference number.';
  }
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (paid !== amountDue) return `Payments add up to ${paid / 100} but ${amountDue / 100} is due.`;
  return null;
}
