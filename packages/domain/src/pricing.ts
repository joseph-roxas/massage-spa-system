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
  /**
   * The Promo picked at checkout: an id, or null for none. Left out, the
   * best Promo that applies is used (and a Statutory Discount beats it).
   */
  promoId?: string | null;
  /** The Guest showed a Senior Citizen or PWD ID. */
  statutory?: StatutoryKind | null;
  /** Super Admin is giving this Service free. */
  complimentary?: boolean;
  /** The Guest is paying with a Voucher for this Service; `isFree` if this Redemption is a Real FOC. */
  voucher?: { serial: string; isFree: boolean } | null;
  /** Everything added by Top-ups, at full price. */
  topUpsTotal?: Centavos;
  /** Each 30-minute Top-up step's price, in the order added; a Promo covers the first full hour of them. */
  topUpSteps?: readonly Centavos[];
};

/** A Promo covers its Service and one more full hour of Top-ups (two 30-minute steps); a half hour, or time past that, is full price. */
export const PROMO_TOP_UP_STEPS = 2;

/** The Top-ups a Promo also takes its percentage off. */
export function promoCoveredTopUps(steps: readonly number[]): Centavos {
  return (steps.length >= PROMO_TOP_UP_STEPS ? steps.slice(0, PROMO_TOP_UP_STEPS).reduce((s, x) => s + x, 0) : 0) as Centavos;
}

export type Quote = {
  regularPrice: Centavos;
  topUpsTotal: Centavos;
  discount: { type: DiscountType; bp: number; amount: Centavos; promoId: string | null; label: string };
  /** What the Guest pays for the Service itself, after the Discount. */
  serviceAmount: Centavos;
  amountDue: Centavos;
  focKind: FocKind;
};

const NONE = { type: 'none', bp: 0, promoId: null, label: 'No discount' } as const;

/**
 * Prices one Service: at most one Discount. With no Promo picked, it is the
 * largest the Guest qualifies for (Statutory wins a tie, since it is the
 * Guest's legal entitlement); a picked Promo applies only if it covers the Service.
 * A Voucher or Complimentary Service covers the whole Service and excludes
 * every other Discount.
 *
 * Top-ups: a Statutory Discount and a Complimentary Service cover them too. A
 * Promo also covers one more full hour of them (its start time decides it for
 * the whole), never a half hour or time past 2 hours. A Voucher is for the
 * original Service only, so the Guest pays them.
 */
export function quoteSale(input: QuoteInput): Quote {
  const price = input.regularPrice;
  const topUpsTotal = (input.topUpsTotal ?? (input.topUpSteps ?? []).reduce((s, x) => s + x, 0)) as Centavos;
  const whole = (price + topUpsTotal) as Centavos;

  let best: Omit<Quote['discount'], 'amount'> = NONE;
  if (input.voucher) {
    best = { type: 'voucher', bp: 10_000, promoId: null, label: `${input.voucher.isFree ? 'Free voucher' : 'Voucher'} ${input.voucher.serial}` };
  } else if (input.complimentary) {
    best = { type: 'complimentary', bp: 10_000, promoId: null, label: 'Complimentary Service' };
  } else {
    const service = { serviceId: input.serviceId, startDate: input.startDate, startTime: input.startTime };
    const candidates = input.promoId === undefined ? input.promos : input.promos.filter((p) => p.id === input.promoId);
    for (const p of candidates) {
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

  const amount =
    best.type === 'complimentary'
      ? whole
      : best.type === 'voucher'
        ? price
        : percentOf(best.type === 'promo' ? ((price + promoCoveredTopUps(input.topUpSteps ?? [])) as Centavos) : whole, best.bp / 100);
  const serviceAmount = (whole - amount) as Centavos;
  return {
    regularPrice: price,
    topUpsTotal,
    discount: { ...best, amount },
    serviceAmount,
    amountDue: serviceAmount,
    focKind: best.type === 'complimentary' || input.voucher?.isFree ? 'real' : best.type === 'voucher' ? 'prepaid' : 'none',
  };
}

/** Commission is on the Regular Price less any Owner's Set-aside, whatever the Guest paid. */
export function commissionFor(regularPrice: Centavos, rate: CommissionRate, isHoliday: boolean, setAside: number = 0): { bp: number; amount: Centavos } {
  const bp = isHoliday ? rate.holidayBp : rate.normalBp;
  return { bp, amount: percentOf((regularPrice - setAside) as Centavos, bp / 100) };
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

/**
 * One payment for a whole stay, split over its Sales in order: each Sale takes
 * what it is owed from the payment lines as they come (Cash first if Cash came
 * first). The lines must add up to the dues; a Sale owing nothing gets none.
 */
export function splitPayments(dues: readonly Centavos[], lines: readonly PaymentLine[]): PaymentLine[][] {
  const left = lines.map((l) => ({ ...l }));
  return dues.map((due) => {
    const mine: PaymentLine[] = [];
    let owed: number = due;
    for (const l of left) {
      if (owed === 0) break;
      const take = Math.min(owed, l.amount);
      if (take === 0) continue;
      mine.push({ ...l, amount: take as Centavos });
      l.amount = (l.amount - take) as Centavos;
      owed -= take;
    }
    return mine;
  });
}
