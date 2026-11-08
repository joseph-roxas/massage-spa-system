import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { effectiveOn, topUpHourService, topUpPrice, topUpRule, type Centavos, type TopUpPart } from '@spa/domain';
import { servicePrices, services } from '@spa/db';

type Service = typeof services.$inferSelect;
export type TopUpProblem = { status: 400 | 409; code: string; message: string };

/** The Regular Price of any Service on a Business Day. */
export async function priceBook(db: DrizzleD1Database, day: string) {
  const all = await db.select().from(servicePrices);
  return (serviceId: string) => effectiveOn(all.filter((p) => p.serviceId === serviceId), day)?.regularPrice as Centavos | undefined;
}

/** What one 30-minute Top-up on this Service costs on this day, or why it can't be had. */
export async function priceTopUp(db: DrizzleD1Database, service: Service, day: string, chosen: TopUpPart | null): Promise<{ price: Centavos; hourPrice: Centavos | null; part: TopUpPart | null } | { problem: TopUpProblem }> {
  const rule = topUpRule(service);
  if (!rule) return { problem: { status: 409, code: 'combo', message: 'A combo can’t be topped up. Add a service instead.' } };
  const part = rule.kind === 'pick_part' ? chosen : null;
  if (rule.kind === 'pick_part' && !part) return { problem: { status: 400, code: 'part_required', message: 'Choose head, back or foot.' } };
  const priceOf = await priceBook(db, day);
  const price = topUpPrice(rule, priceOf(service.id) ?? (0 as Centavos), part, priceOf);
  if (price === null) return { problem: { status: 409, code: 'no_price', message: 'That 30-minute price is not set. Ask the Super Admin.' } };
  const hourService = topUpHourService(rule, part);
  return { price, hourPrice: hourService ? (priceOf(hourService) ?? null) : null, part };
}
