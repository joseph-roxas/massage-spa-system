import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, toManila } from '@spa/domain';
import { client, loggedIn, seedUser, type Client } from './helpers';

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
    await admin.post('/settings/staff', { firstName: name, lastName: 'Test', displayName: name, kind: 'therapist', therapistClass: 'regular', ...opts }),
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
    env.DB.prepare(`DELETE FROM business_days`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM vouchers`),
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

    expect((await desk.post('/cash-outs', { category: 'petty_cash', amount: 15000, purpose: 'Rice for staff' })).status).toBe(201);

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

type Issued = { id: string; total: number; serials: { serial: string; isFree: boolean }[] };

describe('vouchers', () => {
  it('sells a 5+1 Bundle at the Regular Price; the sixth redeems as a Real FOC', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const res = await desk.post('/voucher-sales', { serviceId: 'swedish-60', qty: 5, buyerName: 'Ana', payments: cash(250000) });
    expect(res.status).toBe(201);
    const sold = await json<Issued>(res);
    expect(sold.total).toBe(250000);
    expect(sold.serials.map((s) => s.isFree)).toEqual([false, false, false, false, false, true]);
    expect(sold.serials[0]!.serial).toMatch(/^SWE-[2-9A-Z]{6}$/);

    const t = await therapist(admin);
    const paidOne = sold.serials[0]!.serial;
    const freeOne = sold.serials[5]!.serial;

    // Typed back loosely; covers the Service and beats any other Discount. Add-ons are still paid.
    const b1 = await served(desk, t);
    const q = await json<Quote>(
      await desk.post('/sales/quote', { bookingId: b1, statutory: 'senior', addonIds: ['extra-oil'], voucherSerial: ` ${paidOne.toLowerCase()} ` }),
    );
    expect(q).toMatchObject({ discount: { type: 'voucher', amount: 50000 }, serviceAmount: 0, amountDue: 5000, focKind: 'prepaid' });
    expect((await desk.post('/sales', { bookingId: b1, addonIds: ['extra-oil'], voucherSerial: paidOne, payments: cash(5000) })).status).toBe(201);

    // Single use.
    const b2 = await served(desk, t);
    const again = await desk.post('/sales', { bookingId: b2, voucherSerial: paidOne, payments: [] });
    expect(again.status).toBe(409);
    expect((await json<{ message: string }>(again)).message).toMatch(/already been used/);

    const free = await desk.post('/sales', { bookingId: b2, voucherSerial: freeOne, payments: [] });
    expect(free.status).toBe(201);
    const { sales } = await json<{ sales: { bookingId: string; focKind: string; discountRef: string; commissionAmount: number }[] }>(await desk.get(`/sales?day=${today()}`));
    expect(sales.find((s) => s.bookingId === b2)).toMatchObject({ focKind: 'real', discountRef: freeOne });
    // Commission is still earned on a redeemed Voucher.
    expect(sales.find((s) => s.bookingId === b2)!.commissionAmount).toBeGreaterThan(0);

    const v = await json<{ status: string }>(await desk.get(`/vouchers/${freeOne}`));
    expect(v.status).toBe('redeemed');
  });

  it('redeems only for the exact Service, and a voided checkout frees the Voucher', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const sold = await json<Issued>(await desk.post('/voucher-sales', { serviceId: 'thai-60', qty: 1, payments: cash(50000) }));
    const serial = sold.serials[0]!.serial;
    const t = await therapist(admin);

    const swedish = await served(desk, t);
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
    const desk = await loggedIn('receptionist');
    expect((await desk.post('/voucher-sales', { serviceId: 'foot-60', qty: 1, payments: cash(45000) })).status).toBe(400);
    expect((await desk.post('/voucher-sales', { serviceId: 'thai-60', qty: 2, payments: cash(50000) })).status).toBe(400);
  });

  it('puts Voucher sales in the drawer at Day Close, and a cancelled sale voids its Vouchers', async () => {
    const desk = await loggedIn('receptionist');
    await desk.post('/voucher-sales', { serviceId: 'thai-60', qty: 1, payments: [{ method: 'gcash', amount: 50000, gcashRef: 'G1' }] });
    const wrong = await json<Issued>(await desk.post('/voucher-sales', { serviceId: 'thai-60', qty: 1, payments: cash(50000) }));
    expect((await desk.post(`/voucher-sales/${wrong.id}/void`, { reason: 'typed the wrong service' })).status).toBe(200);
    expect((await json<{ status: string }>(await desk.get(`/vouchers/${wrong.serials[0]!.serial}`))).status).toBe('voided');

    const p = await json<Preview & { vouchersSold: number }>(await desk.get(`/days/${today()}/close-preview`));
    expect(p.totals).toMatchObject({ cashIn: 0, expectedGcash: 50000 });
    expect(p.vouchersSold).toBe(50000);
  });

  it('lets only the Super Admin import paper Vouchers, and never the same serial twice', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const body = { serviceId: 'ventosa-90', serials: ['p-0001', 'P-0002'], isFree: false };
    expect((await desk.post('/vouchers/import', body)).status).toBe(403);
    expect((await admin.post('/vouchers/import', body)).status).toBe(201);
    expect((await admin.post('/vouchers/import', { ...body, serials: ['P-0002'] })).status).toBe(409);
    const v = await json<{ imported: boolean; voucherSaleId: string | null; serviceId: string }>(await desk.get('/vouchers/p-0001'));
    expect(v).toMatchObject({ imported: true, voucherSaleId: null, serviceId: 'ventosa-90' });
  });
});
