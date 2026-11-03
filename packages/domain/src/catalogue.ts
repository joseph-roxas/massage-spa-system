import type { Centavos } from './money';
import type { HhMm, IsoDate } from './calendar';

/** Anything that takes effect on a date and stays until replaced, e.g. a price or a commission rate. */
export type Effective = { effectiveFrom: IsoDate };

/** The entry in force on `date`: the latest one whose effectiveFrom is on or before it. */
export function effectiveOn<T extends Effective>(entries: readonly T[], date: IsoDate): T | undefined {
  let best: T | undefined;
  for (const e of entries) {
    if (e.effectiveFrom <= date && (!best || e.effectiveFrom > best.effectiveFrom)) best = e;
  }
  return best;
}

export type ServicePrice = Effective & { regularPrice: Centavos };

export type TherapistClass = 'regular' | 'lmt';

/** Percentages in basis points: 3000 = 30%. */
export type CommissionRate = Effective & {
  therapistClass: TherapistClass;
  normalBp: number;
  holidayBp: number;
};

export function commissionRateOn(
  rates: readonly CommissionRate[],
  therapistClass: TherapistClass,
  date: IsoDate,
): CommissionRate | undefined {
  return effectiveOn(
    rates.filter((r) => r.therapistClass === therapistClass),
    date,
  );
}

export type Promo = {
  serviceId: string;
  /** Basis points: 1000 = 10%. */
  percentBp: number;
  /** Window on the Service's start time: startTime inclusive, endTime exclusive. */
  startTime: HhMm;
  endTime: HhMm;
  /** Inclusive on both ends. */
  validFrom: IsoDate;
  validTo: IsoDate;
  active: boolean;
};

/** Whether a Promo covers a Service starting at the given Manila date and time. */
export function promoApplies(
  promo: Promo,
  service: { serviceId: string; startDate: IsoDate; startTime: HhMm },
): boolean {
  return (
    promo.active &&
    promo.serviceId === service.serviceId &&
    service.startDate >= promo.validFrom &&
    service.startDate <= promo.validTo &&
    service.startTime >= promo.startTime &&
    service.startTime < promo.endTime
  );
}
