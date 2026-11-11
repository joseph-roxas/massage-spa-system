import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { businessDayOf, DEFAULT_REGULAR_RULE, properName, visitStats, type RegularRule, type VisitStats } from '@spa/domain';
import { bookings, guests, payRules, sales } from '@spa/db';
import { nowIso } from './time';

type Db = DrizzleD1Database;
export type GuestRow = typeof guests.$inferSelect;

/** The Regular rule in Settings, or the default. */
export async function regularRule(db: Db): Promise<RegularRule> {
  const row = await db.select().from(payRules).where(eq(payRules.key, 'regular_guest_rule')).get();
  return row ? (JSON.parse(row.valueJson) as RegularRule) : DEFAULT_REGULAR_RULE;
}

/**
 * Visit stats per Guest: a Visit is a Business Day with a checked-out (paid) Booking.
 * Without `ids`, every Guest; D1 takes at most 100 bound values, so ids go in chunks.
 */
export async function visitStatsFor(db: Db, ids?: readonly string[]): Promise<Map<string, VisitStats>> {
  const rule = await regularRule(db);
  const query = (filter?: readonly string[]) =>
    db
      .selectDistinct({ guestId: bookings.guestId, day: bookings.businessDay })
      .from(bookings)
      .innerJoin(sales, and(eq(sales.bookingId, bookings.id), eq(sales.status, 'paid')))
      .where(filter ? inArray(bookings.guestId, [...filter]) : undefined);
  const rows = ids
    ? (await Promise.all(Array.from({ length: Math.ceil(ids.length / 90) }, (_, i) => query(ids.slice(i * 90, i * 90 + 90))))).flat()
    : await query();
  const days = new Map<string, string[]>();
  for (const r of rows) if (r.guestId) days.set(r.guestId, [...(days.get(r.guestId) ?? []), r.day]);
  const today = businessDayOf(new Date());
  const out = new Map<string, VisitStats>();
  for (const id of ids ?? [...days.keys()]) out.set(id, visitStats(days.get(id) ?? [], today, rule));
  return out;
}

export type GuestChoice = { guestId?: string | null; saveGuest?: boolean; name: string | null; phone: string | null };

/**
 * Who a Booking or Voucher sale is for. A picked Guest Record wins and its name
 * and phone are copied; `saveGuest` makes a new record from the typed name.
 * Returns the insert to run in the same batch, if any.
 */
export async function resolveGuest(db: Db, typed: GuestChoice, actor: string) {
  // Names are kept with each word capitalized, whatever was typed.
  const choice = { ...typed, name: typed.name?.trim() ? properName(typed.name) : typed.name };
  if (choice.guestId) {
    const g = await db
      .select()
      .from(guests)
      .where(and(eq(guests.id, choice.guestId), isNull(guests.mergedInto)))
      .get();
    if (!g) return { ok: false, problem: 'That Guest Record is not found.' } as const;
    return { ok: true, guestId: g.id, name: g.name, phone: choice.phone || g.phone, insert: null } as const;
  }
  if (choice.saveGuest && choice.name) {
    const id = crypto.randomUUID();
    return {
      ok: true,
      guestId: id,
      name: choice.name,
      phone: choice.phone,
      insert: db.insert(guests).values({ id, name: choice.name, phone: choice.phone, createdAt: nowIso(), createdBy: actor }),
    } as const;
  }
  return { ok: true, guestId: null, name: choice.name, phone: choice.phone, insert: null } as const;
}
