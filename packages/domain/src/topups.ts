import { percentOf, type Centavos } from './money';

export const TOP_UP_STEP_MIN = 30;

export const TOP_UP_PARTS = ['head', 'back', 'foot'] as const;
export type TopUpPart = (typeof TOP_UP_PARTS)[number];

/** The 30-minute massage a 1.5-hour Service is topped up with. */
export const TOP_UP_PART_SERVICE: Record<TopUpPart, string> = { head: 'head-30', back: 'back-30', foot: 'foot-30' };

/** Services whose extra 30 minutes cost what the owner set for the 30-minute version. */
const THIRTY_MINUTE_VERSION: Record<string, string> = { 'foot-60': 'foot-30', 'back-60': 'back-30' };

export type TopUpRule = { kind: 'half' } | { kind: 'price_of'; serviceId: string } | { kind: 'pick_part' };

/** The 1-hour Service whose price a full extra hour of this massage costs. */
const ONE_HOUR_VERSION: Record<string, string> = { 'foot-30': 'foot-60', 'back-30': 'back-60' };

/** The Service whose price a full extra hour costs, when it isn't simply two 30-minute Top-ups. */
export function topUpHourService(rule: TopUpRule, part: TopUpPart | null): string | null {
  if (rule.kind === 'price_of') return ONE_HOUR_VERSION[rule.serviceId] ?? null;
  if (rule.kind === 'pick_part' && part) return ONE_HOUR_VERSION[TOP_UP_PART_SERVICE[part]] ?? null;
  return null;
}

/** The total for `steps` of 30 minutes: each full hour at the 1-hour price when there is one. */
export function topUpTotal(steps: number, thirtyMin: number, oneHour: number | null): number {
  if (oneHour === null) return steps * thirtyMin;
  return Math.floor(steps / 2) * oneHour + (steps % 2) * thirtyMin;
}

/** That total split across each 30-minute step, so the steps always add up to it. */
export function topUpStepPrices(steps: number, thirtyMin: number, oneHour: number | null): Centavos[] {
  const out: number[] = [];
  for (let done = 0; done < steps; done += 2) {
    if (done + 1 === steps || oneHour === null) {
      out.push(thirtyMin);
      if (done + 1 < steps) out.push(thirtyMin);
    } else {
      const first = Math.ceil(oneHour / 2);
      out.push(first, oneHour - first);
    }
  }
  return out as Centavos[];
}

/** How a Service's Top-up is priced; null for a Combo, which can't be topped up. */
export function topUpRule(service: { id: string; kind: 'single' | 'combo'; durationMin: number }): TopUpRule | null {
  if (service.kind === 'combo') return null;
  const version = THIRTY_MINUTE_VERSION[service.id];
  if (version) return { kind: 'price_of', serviceId: version };
  if (service.durationMin <= TOP_UP_STEP_MIN) return { kind: 'price_of', serviceId: service.id };
  if (service.durationMin <= 60) return { kind: 'half' };
  return { kind: 'pick_part' };
}

/** What one 30-minute Top-up costs, or null if a price it depends on isn't set. */
export function topUpPrice(
  rule: TopUpRule,
  regularPrice: Centavos,
  part: TopUpPart | null,
  priceOf: (serviceId: string) => Centavos | undefined,
): Centavos | null {
  switch (rule.kind) {
    case 'half':
      return percentOf(regularPrice, 50);
    case 'price_of':
      return priceOf(rule.serviceId) ?? null;
    case 'pick_part':
      return part ? (priceOf(TOP_UP_PART_SERVICE[part]) ?? null) : null;
  }
}
