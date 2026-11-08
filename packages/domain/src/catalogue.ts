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

/** The Owner's Set-aside on a Service from a date; Services with none have no entries. */
export type ServiceSetAside = Effective & { amount: Centavos };

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

/** "14:00" → "2:00pm". */
export function clock(t: HhMm): string {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Why a Promo doesn't cover a Service starting at the given Manila date and
 * time, or null if it does. `serviceName` names the Promo's own Service.
 */
export function promoProblem(
  promo: Promo & { serviceName?: string },
  service: { serviceId: string; startDate: IsoDate; startTime: HhMm },
): string | null {
  if (!promo.active) return 'Not running';
  if (promo.serviceId !== service.serviceId) return `Only for ${promo.serviceName ?? 'another service'}`;
  if (service.startDate < promo.validFrom) return `Starts ${promo.validFrom}`;
  if (service.startDate > promo.validTo) return `Ended ${promo.validTo}`;
  if (service.startTime < promo.startTime || service.startTime >= promo.endTime) {
    return `Only for services starting ${clock(promo.startTime)}–${clock(promo.endTime)}`;
  }
  return null;
}

/** Whether a Promo covers a Service starting at the given Manila date and time. */
export function promoApplies(promo: Promo, service: { serviceId: string; startDate: IsoDate; startTime: HhMm }): boolean {
  return promoProblem(promo, service) === null;
}
