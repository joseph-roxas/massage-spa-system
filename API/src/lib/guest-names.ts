import { eq, isNotNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { properName } from '@spa/domain';
import { appMeta, bookings, guests, voucherSales } from '@spa/db';
import { auditInsert } from './audit';

/** Set by migration 0035 to 'to_tidy'; 'done' once every saved Guest name is capitalized. */
export const GUEST_NAMES_KEY = 'guest_names';

let checked = false;

/**
 * Capitalizes every Guest name saved before names were capitalized on entry:
 * Guest Records, the name on each Booking and each Voucher buyer. Runs once,
 * on the first request after the migration; properName is idempotent, so a
 * second run from another isolate changes nothing.
 */
export async function tidyGuestNamesOnce(db: DrizzleD1Database): Promise<number> {
  if (checked) return 0;
  const changed = await tidyGuestNames(db);
  checked = true;
  return changed;
}

/** The tidy itself, if migration 0035 asked for it; the number of rows changed. */
export async function tidyGuestNames(db: DrizzleD1Database): Promise<number> {
  const flag = await db.select().from(appMeta).where(eq(appMeta.key, GUEST_NAMES_KEY)).get();
  if (flag?.value !== 'to_tidy') return 0;
  const [records, booked, bought] = await Promise.all([
    db.select({ id: guests.id, name: guests.name }).from(guests),
    db.selectDistinct({ name: bookings.guestName }).from(bookings).where(isNotNull(bookings.guestName)),
    db.selectDistinct({ name: voucherSales.buyerName }).from(voucherSales).where(isNotNull(voucherSales.buyerName)),
  ]);
  const writes = [
    ...records.filter((g) => properName(g.name) !== g.name).map((g) => db.update(guests).set({ name: properName(g.name) }).where(eq(guests.id, g.id))),
    ...booked.filter((b) => b.name && properName(b.name) !== b.name).map((b) => db.update(bookings).set({ guestName: properName(b.name!) }).where(eq(bookings.guestName, b.name!))),
    ...bought.filter((v) => v.name && properName(v.name) !== v.name).map((v) => db.update(voucherSales).set({ buyerName: properName(v.name!) }).where(eq(voucherSales.buyerName, v.name!))),
  ];
  await db.batch([
    ...writes,
    db.update(appMeta).set({ value: 'done' }).where(eq(appMeta.key, GUEST_NAMES_KEY)),
    auditInsert(db, { actorUserId: null, action: 'guest.names_capitalized', entity: 'guest', entityId: 'all', after: { changed: writes.length } }),
  ] as unknown as Parameters<typeof db.batch>[0]);
  return writes.length;
}
