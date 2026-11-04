import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, toManila } from '@spa/domain';
import { client, loggedIn, PERSON, seedUser, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Quote = { regularPrice: number; discount: { type: string; amount: number }; serviceAmount: number; addonsTotal: number; amountDue: number; focKind: string };
type Preview = {
  blockers: { bookingId: string; problem: string }[];
  owed: { staffId: string; amount: number }[];
  totals: { cashIn: number; gcashIn: number; cashOut: number; expectedCash: number; expectedGcash: number };
};

let n = 0;
async function therapist(admin: Client, opts: { isOnCall?: boolean } = {}): Promise<string> {
  const name = `S${++n}`;
  const { id } = await json<{ id: string }>(
    await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass: 'regular', ...opts }),
  );
  await admin.post(`/settings/staff/${id}/pin`, { pin: '1234' });
  await admin.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' });
  return id;
}

/** A walk-in served by `therapistId` and finished, ready for checkout. */
async function served(desk: Client, therapistId: string, serviceId = 'swedish-60'): Promise<string> {
  const { id } = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId }));
  const s = await json<{ therapist: { staffId: string } | null; room: { roomId: number; flexMode: string | null } }>(await desk.get(`/bookings/${id}/suggest`));
  const start = await desk.post(`/bookings/${id}/start`, {
    therapistId,
    roomId: s.room.roomId,
    flexMode: s.room.flexMode,
    overrideReason: s.therapist?.staffId === therapistId ? undefined : 'test picks the therapist',
  });
  expect(start.status).toBe(200);
  expect((await desk.post(`/bookings/${id}/done`)).status).toBe(200);
  return id;
}

const today = () => businessDayOf(new Date());
const cash = (amount: number) => [{ method: 'cash', amount }];

beforeEach(async () => {
  // Each test runs a fresh Business Day.
  await env.DB.batch([
    env.DB.prepare(`UPDATE dtr SET clock_out = ? WHERE clock_out IS NULL`).bind(new Date().toISOString()),
    env.DB.prepare(`DELETE FROM voucher_payments`),
    env.DB.prepare(`UPDATE vouchers SET redeemed_sale_id = NULL`),
    env.DB.prepare(`DELETE FROM payments`),
    env.DB.prepare(`DELETE FROM sale_addons`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM cash_outs`),
    env.DB.prepare(`DELETE FROM cash_transfers`),
    env.DB.prepare(`DELETE FROM business_days`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM vouchers`),
    env.DB.prepare(`DELETE FROM voucher_endorsements`),
    env.DB.prepare(`DELETE FROM voucher_sales`),
  ]);
});

describe('checkout', () => {
  it('gives the largest Discount, adds Add-ons on top and pays Commission on the Regular Price', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const booking = await served(desk, t);

    const checkout = { bookingId: booking, statutory: { kind: 'senior', idNumber: 'SC-12345' }, addonIds: ['extra-oil'] };
    const q = await json<Quote>(await desk.post('/sales/quote', { bookingId: booking, statutory: 'senior', addonIds: ['extra-oil'] }));
    // 20% Senior beats the 10% Happy Hours whenever both apply.
    expect(q).toMatchObject({ regularPrice: 50000, discount: { type: 'senior', amount: 10000 }, serviceAmount: 40000, addonsTotal: 5000, amountDue: 45000 });

    const res = await desk.post('/sales', {
      ...checkout,
      bookletInvoiceNo: '000123',
      payments: [
        { method: 'cash', amount: 20000 },
        { method: 'gcash', amount: 25000, gcashRef: '1009 223 4456' },
      ],
    });
    expect(res.status).toBe(201);

    const { sales } = await json<{ sales: { bookingId: string; discountRef: string; commissionBp: number; commissionAmount: number; payments: unknown[]; addons: unknown[] }[] }>(
      await desk.get(`/sales?day=${today()}`),
    );
    const sale = sales.find((s) => s.bookingId === booking)!;
    expect(sale.discountRef).toBe('SC-12345');
    expect(sale.commissionAmount).toBe((50000 * sale.commissionBp) / 10000);
    expect(sale.payments).toHaveLength(2);
    expect(sale.addons).toHaveLength(1);

    // Once only.
    expect((await desk.post('/sales', { bookingId: booking, payments: cash(50000) })).status).toBe(409);
  });

  it('lists running Promos with why each does not apply, and applies only the one picked', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO promos (id, name, service_id, percent_bp, start_time, end_time, valid_from, valid_to, active, created_at)
         VALUES ('all-day', 'All-day 15%', 'swedish-60', 1500, '00:00', '24:00', '2000-01-01', '2999-12-31', 1, '2026-11-04T00:00:00.000Z'),
                ('thai-only', 'Thai 5%', 'thai-60', 500, '00:00', '24:00', '2000-01-01', '2999-12-31', 1, '2026-11-04T00:00:00.000Z')`,
      ),
    ]);
    try {
      const booking = await served(desk, await therapist(admin));
      type Q = Quote & { promos: { id: string; problem: string | null }[] };

      const auto = await json<Q>(await desk.post('/sales/quote', { bookingId: booking }));
      expect(auto.discount).toMatchObject({ type: 'promo', promoId: 'all-day', amount: 7500 });
      expect(auto.promos.find((p) => p.id === 'all-day')!.problem).toBeNull();
      expect(auto.promos.find((p) => p.id === 'thai-only')!.problem).toMatch(/^Only for /);

      const none = await json<Q>(await desk.post('/sales/quote', { bookingId: booking, promoId: null }));
      expect(none.discount.type).toBe('none');
      expect((await desk.post('/sales/quote', { bookingId: booking, promoId: 'thai-only' })).status).toBe(409);

      expect((await desk.post('/sales', { bookingId: booking, promoId: null, payments: cash(50000) })).status).toBe(201);
    } finally {
      await env.DB.prepare(`DELETE FROM promos WHERE id IN ('all-day', 'thai-only')`).run();
    }
  });

  it('refuses payments that do not settle the amount due', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const booking = await served(desk, await therapist(admin), 'thai-60');

    const short = await desk.post('/sales', { bookingId: booking, payments: cash(40000) });
    expect(short.status).toBe(400);
    const noRef = await desk.post('/sales', { bookingId: booking, payments: [{ method: 'gcash', amount: 50000 }] });
    expect((await json<{ message: string }>(noRef)).message).toMatch(/reference/);
    expect((await desk.post('/sales', { bookingId: booking, payments: cash(50000) })).status).toBe(201);
  });

  it('lets only the Super Admin give a Complimentary Service, which is a Real FOC', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const booking = await served(desk, await therapist(admin), 'thai-60');

    const comp = { bookingId: booking, complimentaryReason: 'Owner’s guest', payments: [] };
    expect((await desk.post('/sales', comp)).status).toBe(403);
    expect((await admin.post('/sales', comp)).status).toBe(201);

    const { sales } = await json<{ sales: { amountDue: number; focKind: string; commissionAmount: number; reason: string }[] }>(await admin.get(`/sales?day=${today()}`));
    // The therapist still earns Commission on a Real FOC.
    expect(sales[0]).toMatchObject({ amountDue: 0, focKind: 'real', reason: 'Owner’s guest' });
    expect(sales[0]!.commissionAmount).toBeGreaterThan(0);
  });

  it('voids a mistaken checkout so it can be redone', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const booking = await served(desk, await therapist(admin), 'thai-60');
    const { id } = await json<{ id: string }>(await desk.post('/sales', { bookingId: booking, payments: cash(50000) }));
    expect((await desk.post(`/sales/${id}/void`, { reason: 'Wrong discount' })).status).toBe(200);
    expect((await desk.post('/sales', { bookingId: booking, statutory: { kind: 'pwd', idNumber: 'PWD-777' }, payments: cash(40000) })).status).toBe(201);
  });
});

describe('Day Close', () => {
  it('runs a day end to end: unfinished guests block it, then it locks the day', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const b1 = await served(desk, t, 'thai-60');
    const day = today();

    expect((await desk.post('/cash-outs', { category: 'laundry', amount: 15000, purpose: 'Laundry' })).status).toBe(201);

    let preview = await json<Preview>(await desk.get(`/days/${day}/close-preview`));
    expect(preview.blockers).toEqual([expect.objectContaining({ bookingId: b1, problem: 'Done but not checked out' })]);
    expect((await desk.post(`/days/${day}/close`, { countedCash: 0 })).status).toBe(409);

    await desk.post('/sales', { bookingId: b1, payments: cash(50000) });
    preview = await json<Preview>(await desk.get(`/days/${day}/close-preview`));
    expect(preview.blockers).toEqual([]);
    expect(preview.totals).toMatchObject({ cashIn: 50000, cashOut: 15000, expectedCash: 35000 });

    // Logging out with the day open is blocked for the Receptionist.
    expect((await desk.post('/auth/logout')).status).toBe(409);

    const closed = await json<{ expectedCash: number; variance: number }>(await desk.post(`/days/${day}/close`, { countedCash: 34000, note: 'Short 10' }));
    expect(closed).toMatchObject({ expectedCash: 35000, variance: -1000 });

    // Locked: no new walk-ins, sales, or Cash-outs.
    expect((await desk.post('/bookings', { kind: 'walk_in', serviceId: 'thai-60' })).status).toBe(409);
    expect((await desk.post('/cash-outs', { category: 'petty_cash', amount: 100, purpose: 'More rice' })).status).toBe(409);

    // Only the Super Admin reopens.
    expect((await desk.post(`/days/${day}/reopen`, { reason: 'Late guest' })).status).toBe(403);
    expect((await admin.post(`/days/${day}/reopen`, { reason: 'Late guest' })).status).toBe(200);
    expect((await desk.post('/bookings', { kind: 'walk_in', serviceId: 'thai-60' })).status).toBe(201);
  });

  it('pays On-call Therapists their Commission from the drawer at close', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const onCall = await therapist(admin, { isOnCall: true });
    const b = await served(desk, onCall, 'thai-60');
    await desk.post('/sales', { bookingId: b, payments: cash(50000) });
    const day = today();

    const preview = await json<Preview & { owed: { amount: number }[] }>(await desk.get(`/days/${day}/close-preview`));
    const owed = preview.owed[0]!.amount;
    expect(preview.owed).toEqual([expect.objectContaining({ staffId: onCall })]);
    expect(preview.totals.expectedCash).toBe(50000 - owed);

    expect((await desk.post(`/days/${day}/close`, { countedCash: 50000 - owed })).status).toBe(200);
    const { cashOuts } = await json<{ cashOuts: { category: string; staffId: string; amount: number }[] }>(await desk.get(`/cash-outs?day=${day}`));
    expect(cashOuts).toEqual([expect.objectContaining({ category: 'on_call_commission', staffId: onCall, amount: owed })]);
  });

  it('blocks today until an earlier day left open is closed', async () => {
    const desk = await loggedIn('receptionist');
    await env.DB.prepare(`INSERT INTO business_days (date, opened_at) VALUES ('2026-01-05', ?)`).bind(new Date().toISOString()).run();
    const res = await desk.post('/bookings', { kind: 'walk_in', serviceId: 'thai-60' });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toBe('previous_day_open');
    expect((await json<{ unclosed: string[] }>(await desk.get('/days/current'))).unclosed).toEqual(['2026-01-05']);

    // An empty day closes with nothing to count.
    expect((await desk.post('/days/2026-01-05/close', { countedCash: 0 })).status).toBe(200);
    expect((await desk.post('/bookings', { kind: 'walk_in', serviceId: 'thai-60' })).status).toBe(201);
  });

  it('lets the Super Admin log out with the day open', async () => {
    const desk = await loggedIn('receptionist');
    await desk.post('/bookings', { kind: 'walk_in', serviceId: 'thai-60' });
    const u = await seedUser({ role: 'super_admin' });
    const admin = client();
    await admin.post('/auth/login', { email: u.email, password: u.password });
    expect((await admin.post('/auth/logout')).status).toBe(200);
  });
});

describe('Early Close and Cash-outs', () => {
  it('records an Early Close with a reason, which the Super Admin may reject', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    expect((await desk.post('/days/current/early-close', { reason: '' })).status).toBe(400);
    const res = await desk.post('/days/current/early-close', { reason: 'No guests, heavy rain' });
    const time = toManila(new Date()).time;
    if (time >= '23:00' || time < '06:00') {
      expect(res.status).toBe(409);
      return;
    }
    expect(res.status).toBe(200);
    expect((await desk.post(`/days/${today()}/early-close/reject`, { reason: 'Not agreed' })).status).toBe(403);
    expect((await admin.post(`/days/${today()}/early-close/reject`, { reason: 'Not agreed' })).status).toBe(200);
    const { day } = await json<{ day: { earlyCloseStatus: string } }>(await admin.get('/days/current'));
    expect(day.earlyCloseStatus).toBe('rejected');
  });

  it('records and removes Cash-outs, but on-call pay only through Day Close', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.post('/cash-outs', { category: 'on_call_commission', amount: 100, purpose: 'Pay Ana' })).status).toBe(400);
    const { id } = await json<{ id: string }>(await desk.post('/cash-outs', { category: 'petty_cash', amount: 4500, purpose: 'Tissue rolls' }));
    expect((await json<{ cashOuts: unknown[] }>(await desk.get(`/cash-outs?day=${today()}`))).cashOuts).toHaveLength(1);
    expect((await desk.send('DELETE', `/cash-outs/${id}`)).status).toBe(200);
    expect((await json<{ cashOuts: unknown[] }>(await desk.get(`/cash-outs?day=${today()}`))).cashOuts).toHaveLength(0);
  });

  it('offers only Petty cash (from the fund) and Laundry (from Sales Cash) on the form', async () => {
    const desk = await loggedIn('receptionist');
    for (const category of ['supplies', 'food', 'transport', 'other'])
      expect((await desk.post('/cash-outs', { category, amount: 100, purpose: 'Something' })).status).toBe(400);
    await desk.post('/cash-outs', { category: 'petty_cash', amount: 5000, purpose: 'Rice 1 kg' });
    await desk.post('/cash-outs', { category: 'laundry', amount: 120000, purpose: 'Weekly laundry' });
    const { cashOuts } = await json<{ cashOuts: { category: string; source: string }[] }>(await desk.get(`/cash-outs?day=${today()}`));
    expect(cashOuts.map((x) => [x.category, x.source])).toEqual([
      ['petty_cash', 'petty'],
      ['laundry', 'sales'],
    ]);
  });
});

type Issued = { id: string; total: number; serials: string[] };
type Bundle = { soldOn: string; buyerName: string; vouchers: { serial: string; redeemedAt: string | null; free: boolean }[]; thisIsFree: boolean };

/** Cards for one Service, endorsed by the Super Admin and received at the shop. */
async function cardsAtShop(admin: Client, desk: Client, serviceId: string, fromNo: number, toNo: number): Promise<string[]> {
  const res = await admin.post('/voucher-endorsements', { serviceId, fromNo, toNo, endorsedOn: today() });
  expect(res.status).toBe(201);
  const { id } = await json<{ id: string }>(res);
  expect((await desk.post(`/voucher-endorsements/${id}/receive`, {})).status).toBe(200);
  const { vouchers } = await json<{ vouchers: { serial: string }[] }>(await desk.get(`/vouchers?serviceId=${serviceId}&status=in_shop`));
  return vouchers.map((v) => v.serial);
}

const sell = (desk: Client, serviceId: string, qty: number, serials: string[], payments: unknown[] = cash(qty * 50000)) =>
  desk.post('/voucher-sales', { serviceId, qty, serials, buyerName: 'Ana Cruz', buyerPhone: '0917 000 0000', payments });

describe('vouchers', () => {
  it('sells a 5+1 Bundle of picked cards; whichever is used last is the Real FOC', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const cards = await cardsAtShop(admin, desk, 'swedish-60', 271, 280);
    expect(cards[0]).toBe('NTL-SM-0271');
    const six = cards.slice(0, 6);

    expect((await sell(desk, 'swedish-60', 5, cards.slice(0, 5))).status).toBe(400); // the free one must be picked too
    expect((await sell(desk, 'swedish-60', 5, [...cards.slice(0, 5), 'NTL-SM-0999'])).status).toBe(409);
    expect((await desk.post('/voucher-sales', { serviceId: 'swedish-60', qty: 5, serials: six, payments: cash(250000) })).status).toBe(400); // buyer required
    const res = await sell(desk, 'swedish-60', 5, six);
    expect(res.status).toBe(201);
    const sold = await json<Issued>(res);
    expect(sold).toMatchObject({ total: 250000, serials: six });
    expect((await sell(desk, 'swedish-60', 1, [six[0]!])).status).toBe(409); // already sold

    const t = await therapist(admin);
    // The highest serial goes first: still a Prepaid FOC. Typed back loosely; Add-ons are still paid.
    const b1 = await served(desk, t);
    const q = await json<Quote & { voucherBundle: Bundle }>(
      await desk.post('/sales/quote', { bookingId: b1, statutory: 'senior', addonIds: ['extra-oil'], voucherSerial: ' ntlsm0276 ' }),
    );
    expect(q).toMatchObject({ discount: { type: 'voucher', amount: 50000 }, serviceAmount: 0, amountDue: 5000, focKind: 'prepaid' });
    expect(q.voucherBundle).toMatchObject({ buyerName: 'Ana Cruz', soldOn: today(), thisIsFree: false });
    expect(q.voucherBundle.vouchers).toHaveLength(6);
    expect((await desk.post('/sales', { bookingId: b1, addonIds: ['extra-oil'], voucherSerial: 'ntl-sm 0276', payments: cash(5000) })).status).toBe(201);

    // Single use.
    const b2 = await served(desk, t);
    const again = await desk.post('/sales', { bookingId: b2, voucherSerial: 'NTL-SM-0276', payments: [] });
    expect(again.status).toBe(409);
    expect((await json<{ message: string }>(again)).message).toMatch(/already been used/);

    for (const serial of six.slice(1, 5)) {
      const b = await served(desk, t);
      expect((await desk.post('/sales', { bookingId: b, voucherSerial: serial, payments: [] })).status).toBe(201);
    }
    const last = await json<Quote & { voucherBundle: Bundle }>(await desk.post('/sales/quote', { bookingId: b2, voucherSerial: six[0] }));
    expect(last).toMatchObject({ focKind: 'real', voucherBundle: { thisIsFree: true } });
    expect(last.voucherBundle.vouchers.filter((v) => v.redeemedAt)).toHaveLength(5);
    expect((await desk.post('/sales', { bookingId: b2, voucherSerial: six[0], payments: [] })).status).toBe(201);

    const { sales } = await json<{ sales: { bookingId: string; focKind: string; discountRef: string; commissionAmount: number }[] }>(await desk.get(`/sales?day=${today()}`));
    expect(sales.find((s) => s.bookingId === b2)).toMatchObject({ focKind: 'real', discountRef: six[0] });
    // Commission is still earned on a redeemed Voucher.
    expect(sales.find((s) => s.bookingId === b2)!.commissionAmount).toBeGreaterThan(0);

    const history = await json<{ voucherSales: { used: number; vouchers: { serial: string; free: boolean }[] }[] }>(
      await desk.get(`/voucher-sales?from=${today()}&to=${today()}&q=ntlsm0273`),
    );
    expect(history.voucherSales).toHaveLength(1);
    expect(history.voucherSales[0]!.used).toBe(6);
    expect(history.voucherSales[0]!.vouchers.at(-1)).toMatchObject({ serial: six[0], free: true });
    expect((await json<{ voucherSales: unknown[] }>(await desk.get(`/voucher-sales?from=${today()}&to=${today()}&q=Cruz`))).voucherSales).toHaveLength(1);
    expect((await json<{ voucherSales: unknown[] }>(await desk.get(`/voucher-sales?from=${today()}&to=${today()}&q=Nobody`))).voucherSales).toHaveLength(0);
  });

  it('redeems only for the exact Service, and a voided checkout frees the Voucher', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const [serial] = await cardsAtShop(admin, desk, 'thai-60', 1, 1);
    const t = await therapist(admin);

    const swedish = await served(desk, t);
    const unsold = await desk.post('/sales/quote', { bookingId: swedish, voucherSerial: serial });
    expect((await json<{ message: string }>(unsold)).message).toMatch(/never sold/);

    const sold = await json<Issued>(await sell(desk, 'thai-60', 1, [serial!]));
    const wrong = await desk.post('/sales/quote', { bookingId: swedish, voucherSerial: serial });
    expect(wrong.status).toBe(409);
    expect((await json<{ message: string }>(wrong)).message).toMatch(/different service/);

    const thai = await served(desk, t, 'thai-60');
    const { id } = await json<{ id: string }>(await desk.post('/sales', { bookingId: thai, voucherSerial: serial, payments: [] }));
    expect((await desk.post(`/sales/${id}/void`, { reason: 'wrong guest' })).status).toBe(200);
    expect((await json<{ status: string }>(await desk.get(`/vouchers/${serial}`))).status).toBe('unused');
    expect((await desk.post('/sales', { bookingId: thai, voucherSerial: serial, payments: [] })).status).toBe(201);

    // A sale whose Voucher is used can no longer be cancelled.
    expect((await desk.post(`/voucher-sales/${sold.id}/void`, { reason: 'mistake' })).status).toBe(409);
  });

  it('refuses Services not sold as Vouchers, and payments that do not match', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const cards = await cardsAtShop(admin, desk, 'thai-60', 1, 2);
    expect((await sell(desk, 'foot-60', 1, [cards[0]!], cash(45000))).status).toBe(400);
    expect((await sell(desk, 'thai-60', 2, cards, cash(50000))).status).toBe(400);
  });

  it('puts Voucher sales in the drawer at Day Close, and a cancelled sale puts its cards back', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const cards = await cardsAtShop(admin, desk, 'thai-60', 1, 2);
    await sell(desk, 'thai-60', 1, [cards[0]!], [{ method: 'gcash', amount: 50000, gcashRef: 'G1' }]);
    const wrong = await json<Issued>(await sell(desk, 'thai-60', 1, [cards[1]!]));
    expect((await desk.post(`/voucher-sales/${wrong.id}/void`, { reason: 'typed the wrong service' })).status).toBe(200);
    expect((await json<{ status: string }>(await desk.get(`/vouchers/${cards[1]}`))).status).toBe('in_shop');

    const p = await json<Preview & { vouchersSold: number }>(await desk.get(`/days/${today()}/close-preview`));
    expect(p.totals).toMatchObject({ cashIn: 0, expectedGcash: 50000 });
    expect(p.vouchersSold).toBe(50000);
  });

  it('lets only the Super Admin endorse cards, never the same card twice; the shop receives them once', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const range = { serviceId: 'aroma-90', fromNo: 93, toNo: 142, endorsedOn: today() };
    expect((await desk.post('/voucher-endorsements', range)).status).toBe(403);
    expect((await admin.post('/voucher-endorsements', { ...range, serviceId: 'foot-60' })).status).toBe(400);
    const { id } = await json<{ id: string }>(await admin.post('/voucher-endorsements', range));
    expect((await admin.post('/voucher-endorsements', { ...range, fromNo: 140, toNo: 150 })).status).toBe(409); // overlaps one not yet received

    const { endorsements } = await json<{ endorsements: { id: string; receivedAt: string | null; count: number; firstSerial: string }[] }>(
      await desk.get('/voucher-endorsements'),
    );
    expect(endorsements[0]).toMatchObject({ id, receivedAt: null, count: 50, firstSerial: 'NTL-AM-0093' });
    expect((await desk.post(`/voucher-endorsements/${id}/receive`, { note: '0101 is torn' })).status).toBe(200);
    expect((await desk.post(`/voucher-endorsements/${id}/receive`, {})).status).toBe(409);
    expect((await admin.send('DELETE', `/voucher-endorsements/${id}`)).status).toBe(409);
    expect((await admin.post('/voucher-endorsements', { ...range, fromNo: 142, toNo: 150 })).status).toBe(409); // overlaps cards at the shop

    const torn = await json<{ id: string }>(await desk.get('/vouchers/NTL-AM-0101'));
    expect((await desk.post(`/vouchers/${torn.id}/void`, { reason: 'Torn card' })).status).toBe(403);
    expect((await admin.post(`/vouchers/${torn.id}/void`, { reason: 'Torn card' })).status).toBe(200);
    const { vouchers } = await json<{ vouchers: unknown[] }>(await desk.get('/vouchers?serviceId=aroma-90&status=in_shop'));
    expect(vouchers).toHaveLength(49);
  });

  it('lets only the Super Admin count cards at go-live, by card number, never the same card twice', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const body = { serviceId: 'ventosa-90', numbers: '1-2', state: 'unused', isFree: true, buyerName: 'Old guest', soldOn: '2026-02-01' };
    expect((await desk.post('/vouchers/import', body)).status).toBe(403);
    expect((await admin.post('/vouchers/import', body)).status).toBe(201);
    expect((await admin.post('/vouchers/import', { ...body, numbers: '2' })).status).toBe(409);
    expect((await admin.post('/vouchers/import', { ...body, numbers: '7-3' })).status).toBe(400);
    expect((await admin.post('/vouchers/import', { serviceId: 'ventosa-90', numbers: '8 9, 30', state: 'in_shop' })).status).toBe(201);

    const v = await json<{ imported: boolean; voucherSaleId: string | null; status: string; isFree: boolean }>(await desk.get('/vouchers/ntl-vm-0001'));
    expect(v).toMatchObject({ imported: true, voucherSaleId: null, status: 'unused', isFree: true });
    expect((await json<{ status: string }>(await desk.get('/vouchers/NTLVM0030'))).status).toBe('in_shop');

    // An imported free one redeems as a Real FOC, with its paper record shown.
    const b = await served(desk, await therapist(admin), 'ventosa-90');
    const q = await json<Quote & { voucherBundle: Bundle }>(await desk.post('/sales/quote', { bookingId: b, voucherSerial: 'NTL-VM-0001' }));
    expect(q).toMatchObject({ focKind: 'real', voucherBundle: { buyerName: 'Old guest', soldOn: '2026-02-01', thisIsFree: true } });
  });
});

type Summary = { day: string; salesCash: number; pettyCash: number; reminder: string; waiting: { id: string; amount: number }[] };

describe('Sales Cash, petty cash and handovers', () => {
  it('keeps petty cash apart from Sales Cash, at most ₱800', async () => {
    const desk = await loggedIn('receptionist');
    const admin = await loggedIn('super_admin');
    const b = await served(desk, await therapist(admin), 'thai-60');
    await desk.post('/sales', { bookingId: b, payments: cash(50000) });

    expect((await desk.post('/cash-outs', { category: 'petty_cash', amount: 30000, purpose: 'Rice 5 kg' })).status).toBe(201);
    expect((await desk.post('/cash-outs', { category: 'petty_cash', amount: 60000, purpose: 'Too much' })).status).toBe(409);
    let s = await json<Summary>(await desk.get('/cash/summary'));
    expect(s).toMatchObject({ salesCash: 50000, pettyCash: 50000 });

    expect((await desk.post('/cash/petty-topups', { amount: 40000 })).status).toBe(409); // only 300 needed
    expect((await desk.post('/cash/petty-topups', { amount: 30000 })).status).toBe(201);
    s = await json<Summary>(await desk.get('/cash/summary'));
    expect(s).toMatchObject({ salesCash: 20000, pettyCash: 80000 });

    // Day Close expects Sales Cash only: the petty Cash-out is not in it, the Top-up is.
    const p = await json<Preview>(await desk.get(`/days/${today()}/close-preview`));
    expect(p.totals).toMatchObject({ cashIn: 50000, cashOut: 0, expectedCash: 20000 });
  });

  it('hands Sales Cash to the owner, who confirms receipt and who received it', async () => {
    const desk = await loggedIn('receptionist');
    const admin = await loggedIn('super_admin');
    expect((await desk.post('/cash/opening', { amount: 500000 })).status).toBe(403);
    expect((await admin.post('/cash/opening', { amount: 500000 })).status).toBe(201);
    const b = await served(desk, await therapist(admin), 'thai-60');
    await desk.post('/sales', { bookingId: b, payments: cash(50000) });
    expect((await json<Summary>(await desk.get('/cash/summary'))).salesCash).toBe(550000);

    expect((await desk.post('/cash/handovers', { amount: 600000 })).status).toBe(409); // more than in the shop
    const { id } = await json<{ id: string }>(await desk.post('/cash/handovers', { amount: 550000 }));
    let s = await json<Summary>(await desk.get('/cash/summary'));
    expect(s.salesCash).toBe(0);
    expect(s.waiting.map((w) => w.id)).toEqual([id]);

    const receipt = { receivedAmount: 549000, receivedOn: today(), receivedByName: 'Marites (sister)', note: 'Short 10' };
    expect((await desk.post(`/cash/handovers/${id}/receive`, receipt)).status).toBe(403);
    expect((await admin.post(`/cash/handovers/${id}/receive`, receipt)).status).toBe(200);
    expect((await admin.post(`/cash/handovers/${id}/receive`, receipt)).status).toBe(409);
    expect((await desk.send('DELETE', `/cash/transfers/${id}`)).status).toBe(409);
    s = await json<Summary>(await desk.get('/cash/summary'));
    expect(s.waiting).toEqual([]);

    const { transfers } = await json<{ transfers: { kind: string; receivedByName: string | null; receivedAmount: number | null }[] }>(
      await admin.get(`/cash/transfers?from=${today()}&to=${today()}`),
    );
    expect(transfers.find((t) => t.kind === 'handover')).toMatchObject({ receivedByName: 'Marites (sister)', receivedAmount: 549000 });

    // Day Close counts everything in the shop: the opening count, today's cash, less the handover.
    const p = await json<Preview>(await desk.get(`/days/${today()}/close-preview`));
    expect(p.totals).toMatchObject({ carriedIn: 500000, cashIn: 50000, transfersOut: 550000, expectedCash: 0 });
  });
});
