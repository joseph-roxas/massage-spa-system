import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, toManila } from '@spa/domain';
import { client, loggedIn, PERSON, seedUser, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Quote = { regularPrice: number; discount: { type: string; amount: number }; serviceAmount: number; amountDue: number; focKind: string };
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
    env.DB.prepare(`DELETE FROM payroll_releases`),
    env.DB.prepare(`DELETE FROM cash_transfers`),
    env.DB.prepare(`DELETE FROM business_days`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM vouchers`),
    env.DB.prepare(`DELETE FROM voucher_endorsements`),
    env.DB.prepare(`DELETE FROM voucher_sales`),
  ]);
});

describe('checkout', () => {
  it('takes the Owner’s Set-aside off before Commission, and keeps it in the sale', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const booking = await served(desk, t, 'aroma-90');
    expect((await desk.post('/sales', { bookingId: booking, payments: cash(70000) })).status).toBe(201);
    const { sales } = await json<{ sales: { bookingId: string; amountDue: number; setAside: number; commissionAmount: number }[] }>(await desk.get(`/sales?day=${today()}`));
    expect(sales.find((s) => s.bookingId === booking)).toMatchObject({ amountDue: 70000, setAside: 5000, commissionAmount: 19500 });
  });

  it('gives the largest Discount and pays Commission on the Regular Price', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const booking = await served(desk, t);

    const checkout = { bookingId: booking, statutory: { kind: 'senior', idNumber: 'SC-12345' } };
    const q = await json<Quote>(await desk.post('/sales/quote', { bookingId: booking, statutory: 'senior' }));
    // 20% Senior beats the 10% Happy Hours whenever both apply.
    expect(q).toMatchObject({ regularPrice: 50000, discount: { type: 'senior', amount: 10000 }, serviceAmount: 40000, amountDue: 40000 });

    const res = await desk.post('/sales', {
      ...checkout,
      bookletInvoiceNo: '000123',
      payments: [
        { method: 'cash', amount: 20000 },
        { method: 'gcash', amount: 20000, gcashRef: '1009 223 4456' },
      ],
    });
    expect(res.status).toBe(201);

    const { sales } = await json<{ sales: { bookingId: string; discountRef: string; commissionBp: number; commissionAmount: number; payments: unknown[] }[] }>(
      await desk.get(`/sales?day=${today()}`),
    );
    const sale = sales.find((s) => s.bookingId === booking)!;
    expect(sale.discountRef).toBe('SC-12345');
    expect(sale.commissionAmount).toBe((50000 * sale.commissionBp) / 10000);
    expect(sale.payments).toHaveLength(2);

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

describe('Added Services', () => {
  type Board = { rotation: { staffId: string; status: string }[]; bookings: { id: string; status: string; roomId: number | null; therapistId: string | null; parentBookingId: string | null }[] };
  const board = async (c: Client) => json<Board>(await c.get('/front-desk'));

  /** A walk-in in service with `therapistId`, not done yet. */
  async function inService(desk: Client, therapistId: string) {
    const { id } = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId: 'swedish-60' }));
    const s = await json<{ therapist: { staffId: string } | null; room: { roomId: number; flexMode: string | null } }>(await desk.get(`/bookings/${id}/suggest`));
    await desk.post(`/bookings/${id}/start`, { therapistId, roomId: s.room.roomId, flexMode: s.room.flexMode, overrideReason: s.therapist?.staffId === therapistId ? undefined : 'test' });
    return id;
  }

  it('follows in the same room, starts when the first is done, and costs one Rotation place', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const other = await therapist(admin);
    const first = await inService(desk, t);
    // Not once it is over.
    const add = await desk.post(`/bookings/${first}/add-service`, { serviceId: 'foot-30' });
    expect(add.status).toBe(201);
    const { id: added } = await json<{ id: string }>(add);
    expect((await desk.post(`/bookings/${first}/add-service`, { serviceId: 'foot-30' })).status).toBe(409);

    let b = await board(desk);
    const room = b.bookings.find((x) => x.id === first)!.roomId;
    expect(b.bookings.find((x) => x.id === added)).toMatchObject({ status: 'waiting', roomId: room, therapistId: t, parentBookingId: first });

    // Done on the first starts the Added Service straight away; the therapist stays busy.
    expect(await json(await desk.post(`/bookings/${first}/done`))).toMatchObject({ startedNext: added });
    b = await board(desk);
    expect(b.bookings.find((x) => x.id === added)!.status).toBe('in_service');
    expect(b.rotation.find((r) => r.staffId === t)!.status).toBe('in_service');

    // Checking out waits for the whole stay.
    const item = (bookingId: string) => ({ bookingId });
    expect((await desk.post('/sales/stay', { items: [item(first)], payments: cash(50000) })).status).toBe(409);
    await desk.post(`/bookings/${added}/done`);
    // Behind the other therapist once, after the last service.
    expect((await board(desk)).rotation.map((r) => r.staffId)).toEqual([other, t]);

    expect((await desk.post('/sales/stay', { items: [item(first)], payments: cash(50000) })).status).toBe(400);
    const res = await desk.post('/sales/stay', {
      items: [{ bookingId: first, statutory: { kind: 'senior', idNumber: 'SC-1' } }, item(added)],
      payments: [
        { method: 'cash', amount: 50000 },
        { method: 'gcash', amount: 15000, gcashRef: 'G-77' },
      ],
    });
    expect(res.status).toBe(201);
    const { ids, amountDue } = await json<{ ids: string[]; amountDue: number }>(res);
    // 400.00 after the Senior discount, then 250.00 at the Regular Price.
    expect(amountDue).toBe(65000);
    const { sales } = await json<{ sales: { id: string; amountDue: number; discountType: string; payments: { method: string; amount: number }[] }[] }>(await desk.get(`/sales?day=${today()}`));
    const [s1, s2] = ids.map((id) => sales.find((x) => x.id === id)!);
    expect(s1).toMatchObject({ amountDue: 40000, discountType: 'senior', payments: [expect.objectContaining({ method: 'cash', amount: 40000 })] });
    expect(s2!.payments.map((p) => [p.method, p.amount])).toEqual([
      ['cash', 10000],
      ['gcash', 15000],
    ]);
  });

  it('cannot run into the therapist’s reservation, and can be cancelled before it starts', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const first = await inService(desk, t);
    // A guest booked with this therapist in 70 minutes: an Added Service after this hour runs into it, whatever the desk says.
    await desk.post('/bookings', { kind: 'scheduled', serviceId: 'swedish-60', guestName: 'Next', requestedTherapistId: t, scheduledAt: new Date(Date.now() + 70 * 60_000).toISOString() });
    const refused = await desk.post(`/bookings/${first}/add-service`, { serviceId: 'back-60', confirm: true });
    expect(refused.status).toBe(409);
    expect((await json<{ error: string }>(refused)).error).toBe('therapist_reserved');
    // Another Therapist can take it, and it can be called off.
    const other = await therapist(admin);
    const { id } = await json<{ id: string }>(await desk.post(`/bookings/${first}/add-service`, { serviceId: 'back-60', therapistId: other }));
    expect((await desk.post(`/bookings/${id}/cancel`, { reason: 'changed mind' })).status).toBe(200);
  });
});

describe('Day Close', () => {
  it('runs a day end to end: unfinished guests block it, then it locks the day', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const b1 = await served(desk, t, 'thai-60');
    const day = today();

    expect((await desk.post('/cash-outs', { category: 'laundry', days: [{ day: businessDayOf(new Date()), amount: 15000 }] })).status).toBe(201);

    let preview = await json<Preview>(await desk.get(`/days/${day}/close-preview`));
    expect(preview.blockers).toEqual([expect.objectContaining({ bookingId: b1, problem: 'Done but not checked out' })]);
    expect((await desk.post(`/days/${day}/close`, { countedCash: 0 })).status).toBe(409);

    await desk.post('/sales', { bookingId: b1, payments: cash(50000) });
    preview = await json<Preview>(await desk.get(`/days/${day}/close-preview`));
    expect(preview.blockers).toEqual([]);
    expect(preview.totals).toMatchObject({ cashIn: 50000, cashOut: 15000, expectedCash: 35000 });

    // Logging out with the day open warns the Receptionist, who may still log out anyway.
    expect((await desk.post('/auth/logout')).status).toBe(409);
    const leaving = await loggedIn('receptionist');
    expect((await leaving.post('/auth/logout', { force: true })).status).toBe(200);

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

  it('finishes and checks out guests left on an earlier day, then closes it', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t1 = await therapist(admin);
    const t2 = await therapist(admin);
    const doneGuest = await served(desk, t1, 'thai-60');
    const { id: inService } = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId: 'thai-60' }));
    const s = await json<{ room: { roomId: number; flexMode: string | null } }>(await desk.get(`/bookings/${inService}/suggest`));
    await desk.post(`/bookings/${inService}/start`, { therapistId: t2, roomId: s.room.roomId, flexMode: s.room.flexMode, overrideReason: 'test picks the therapist' });
    const { id: waiting } = await json<{ id: string }>(await desk.post('/bookings', { kind: 'walk_in', serviceId: 'thai-60' }));
    // The day was never closed and it is now the next morning.
    const past = '2026-01-06';
    await env.DB.batch([
      env.DB.prepare(`UPDATE business_days SET date = ?`).bind(past),
      env.DB.prepare(`UPDATE bookings SET business_day = ?`).bind(past),
    ]);

    const preview = await json<Preview>(await desk.get(`/days/${past}/close-preview`));
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bookingId: doneGuest, status: 'done', therapistName: expect.any(String) }),
        expect.objectContaining({ bookingId: inService, status: 'in_service' }),
        expect.objectContaining({ bookingId: waiting, status: 'waiting' }),
      ]),
    );

    expect((await desk.post('/sales', { bookingId: doneGuest, payments: cash(50000) })).status).toBe(201);
    expect((await desk.post(`/bookings/${inService}/done`)).status).toBe(200);
    expect((await desk.post('/sales', { bookingId: inService, payments: cash(50000) })).status).toBe(201);
    expect((await desk.post(`/bookings/${waiting}/cancel`, { reason: 'Left without service' })).status).toBe(200);

    // The sales count toward the day they were served, and that day now closes.
    const { sales } = await json<{ sales: unknown[] }>(await admin.get(`/sales?day=${past}`));
    expect(sales).toHaveLength(2);
    expect((await desk.post(`/days/${past}/close`, { countedCash: 100000 })).status).toBe(200);
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
    await desk.post('/cash-outs', { category: 'laundry', days: [{ day: businessDayOf(new Date()), amount: 120000 }], purpose: 'Weekly laundry' });
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
    // The highest serial goes first: still a Prepaid FOC. Typed back loosely.
    const b1 = await served(desk, t);
    const q = await json<Quote & { voucherBundle: Bundle }>(
      await desk.post('/sales/quote', { bookingId: b1, statutory: 'senior', voucherSerial: ' ntlsm0276 ' }),
    );
    expect(q).toMatchObject({ discount: { type: 'voucher', amount: 50000 }, serviceAmount: 0, amountDue: 0, focKind: 'prepaid' });
    expect(q.voucherBundle).toMatchObject({ buyerName: 'Ana Cruz', soldOn: today(), thisIsFree: false });
    expect(q.voucherBundle.vouchers).toHaveLength(6);
    expect((await desk.post('/sales', { bookingId: b1, voucherSerial: 'ntl-sm 0276', payments: [] })).status).toBe(201);

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
    // The list filters by Service and by the owner's status groups.
    const shown = async (query: string) => (await json<{ vouchers: { status: string }[] }>(await desk.get(`/vouchers?serviceId=aroma-90&${query}`))).vouchers;
    expect(await shown('show=unsold')).toHaveLength(49);
    expect(await shown('show=voided')).toHaveLength(1);
    expect(await shown('show=sold')).toHaveLength(0);
    expect((await desk.get('/vouchers?show=nonsense')).status).toBe(400);
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
    // Less than the shop should hold needs a reason.
    const short = await desk.post('/cash/handovers', { amount: 500000 });
    expect(short.status).toBe(400);
    expect((await json<{ message: string }>(short)).message).toContain('500.00 less');
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

describe('Correcting a start time', () => {
  it('re-prices a sale on a closed day into Happy Hours, and the Day Close follows', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    // A past, closed day with one Swedish (1hr) recorded at 7:00pm at full price, though it really started at 3:00pm.
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 3);
    const day = d.toISOString().slice(0, 10);
    const at = (hhmm: string) => new Date(`${day}T${hhmm}:00+08:00`).toISOString();
    const [bookingId, saleId] = [crypto.randomUUID(), crypto.randomUUID()];
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO business_days (date, opened_at, closed_at, expected_cash, expected_gcash, counted_cash, variance) VALUES (?, ?, ?, 50000, 0, 50000, 0)`).bind(day, at('14:00'), at('23:30')),
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, therapist_id, room_id, started_at, done_at, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?, 1, ?, ?, ?)`).bind(bookingId, day, t, at('19:00'), at('20:00'), at('19:00')),
      env.DB.prepare(`INSERT INTO sales (id, booking_id, business_day, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at) VALUES (?, ?, ?, 'swedish-60', ?, 50000, 'none', 50000, 50000, 3000, 15000, ?)`).bind(saleId, bookingId, day, t, at('20:00')),
      env.DB.prepare(`INSERT INTO payments (id, sale_id, business_day, method, amount, created_at) VALUES (?, ?, ?, 'cash', 50000, ?)`).bind(crypto.randomUUID(), saleId, day, at('20:00')),
    ]);
    const body = { bookingId, startedAt: at('15:00'), reason: 'Entered late; really started at 3pm' };

    expect((await desk.post('/sales/correct-start', body)).status).toBe(403);
    expect((await admin.post('/sales/correct-start', { ...body, startedAt: at('05:00') })).status).toBe(400);
    expect((await admin.post('/sales/correct-start', body)).status).toBe(200);

    const sale = await env.DB.prepare(`SELECT discount_type, amount_due, commission_amount FROM sales WHERE id = ?`).bind(saleId).first();
    expect(sale).toEqual({ discount_type: 'promo', amount_due: 45000, commission_amount: 15000 });
    const pay = await env.DB.prepare(`SELECT amount FROM payments WHERE sale_id = ?`).bind(saleId).first<{ amount: number }>();
    expect(pay?.amount).toBe(45000);
    const b = await env.DB.prepare(`SELECT started_at, done_at FROM bookings WHERE id = ?`).bind(bookingId).first();
    expect(b).toEqual({ started_at: at('15:00'), done_at: at('16:00') });
    // The day still shows what was counted; it now expected ₱50 less, so it reads ₱50 over until the count is corrected.
    type Detail = { day: { expectedCash: number; countedCash: number; variance: number }; services: { bookingId: string; startedAt: string; sale: { amountDue: number } | null }[] };
    let detail = await (await admin.get(`/sales/day-detail?day=${day}`)).json<Detail>();
    expect(detail.day).toMatchObject({ expectedCash: 45000, countedCash: 50000, variance: 5000 });
    expect(detail.services.find((s) => s.bookingId === bookingId)).toMatchObject({ startedAt: at('15:00'), sale: { amountDue: 45000 } });

    expect((await desk.post(`/days/${day}/counted`, { countedCash: 45000, reason: 'Recount' })).status).toBe(403);
    expect((await admin.post(`/days/${day}/counted`, { countedCash: 45000, reason: 'What was really in the drawer' })).status).toBe(200);
    detail = await (await admin.get(`/sales/day-detail?day=${day}`)).json<Detail>();
    expect(detail.day).toMatchObject({ countedCash: 45000, variance: 0 });
  });
});

describe('Correcting a service', () => {
  it('re-prices a sale on a closed day as the Service really served, and its Commission follows', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 2);
    const day = d.toISOString().slice(0, 10);
    const at = (hhmm: string) => new Date(`${day}T${hhmm}:00+08:00`).toISOString();
    const [bookingId, saleId, voucherBooking, voucherSale] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO business_days (date, opened_at, closed_at, expected_cash, expected_gcash, counted_cash, variance) VALUES (?, ?, ?, 50000, 0, 70000, 20000)`).bind(day, at('14:00'), at('23:30')),
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, therapist_id, room_id, started_at, done_at, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?, 1, ?, ?, ?)`).bind(bookingId, day, t, at('19:00'), at('20:00'), at('19:00')),
      env.DB.prepare(`INSERT INTO sales (id, booking_id, business_day, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at) VALUES (?, ?, ?, 'swedish-60', ?, 50000, 'none', 50000, 50000, 3000, 15000, ?)`).bind(saleId, bookingId, day, t, at('20:00')),
      env.DB.prepare(`INSERT INTO payments (id, sale_id, business_day, method, amount, created_at) VALUES (?, ?, ?, 'cash', 50000, ?)`).bind(crypto.randomUUID(), saleId, day, at('20:00')),
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, therapist_id, room_id, started_at, done_at, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?, 2, ?, ?, ?)`).bind(voucherBooking, day, t, at('15:00'), at('16:00'), at('15:00')),
      env.DB.prepare(`INSERT INTO sales (id, booking_id, business_day, service_id, therapist_id, regular_price, discount_type, discount_amount, service_amount, amount_due, focKind, commission_bp, commission_amount, created_at) VALUES (?, ?, ?, 'swedish-60', ?, 50000, 'voucher', 50000, 0, 0, 'voucher', 3000, 15000, ?)`.replace('focKind', 'foc_kind')).bind(voucherSale, voucherBooking, day, t, at('16:00')),
    ]);
    const body = { bookingId, serviceId: 'aroma-90', reason: 'Was really the 90-minute Aroma' };

    expect((await desk.post('/sales/correct-service', body)).status).toBe(403);
    expect((await admin.post('/sales/correct-service', { ...body, bookingId: voucherBooking })).status).toBe(409);
    expect((await admin.post('/sales/correct-service', body)).status).toBe(200);

    // ₱700 at full price; Commission 30% of ₱700 less the ₱50 Set-aside.
    const sale = await env.DB.prepare(`SELECT service_id, regular_price, amount_due, commission_amount FROM sales WHERE id = ?`).bind(saleId).first();
    expect(sale).toEqual({ service_id: 'aroma-90', regular_price: 70000, amount_due: 70000, commission_amount: 19500 });
    const pay = await env.DB.prepare(`SELECT amount FROM payments WHERE sale_id = ?`).bind(saleId).first<{ amount: number }>();
    expect(pay?.amount).toBe(70000);
    const b = await env.DB.prepare(`SELECT service_id, started_at, done_at FROM bookings WHERE id = ?`).bind(bookingId).first();
    expect(b).toEqual({ service_id: 'aroma-90', started_at: at('19:00'), done_at: at('20:30') });
    // The Day Close expected ₱200 more, so the ₱200 it was over is explained.
    const closed = await env.DB.prepare(`SELECT expected_cash, counted_cash, variance FROM business_days WHERE date = ?`).bind(day).first();
    expect(closed).toEqual({ expected_cash: 70000, counted_cash: 70000, variance: 0 });
  });
});

describe('Laundry Breakdown', () => {
  it('records Laundry day by day and pays their total from Sales Cash', async () => {
    const desk = await loggedIn('receptionist');
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const yesterday = d.toISOString().slice(0, 10);
    // An amount typed for Laundry is not enough: it needs its days.
    expect((await desk.post('/cash-outs', { category: 'laundry', amount: 30000, purpose: 'Laundry' })).status).toBe(400);
    expect((await desk.post('/cash-outs', { category: 'laundry', days: [{ day: '2026-01-01', amount: 100 }] })).status).toBe(400);
    expect((await desk.post('/cash-outs', { category: 'laundry', days: [{ day: yesterday, amount: 100 }, { day: yesterday, amount: 100 }] })).status).toBe(400);

    const res = await desk.post('/cash-outs', { category: 'laundry', days: [{ day: today(), amount: 22000 }, { day: yesterday, amount: 18000 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ amount: 40000 });
    const { cashOuts } = await json<{ cashOuts: { id: string; category: string; amount: number; source: string; breakdown: { day: string; amount: number }[] | null }[] }>(await desk.get(`/cash-outs?day=${today()}`));
    expect(cashOuts.find((c) => c.category === 'laundry' && c.amount === 40000)).toMatchObject({
      source: 'sales',
      breakdown: [
        { day: yesterday, amount: 18000 },
        { day: today(), amount: 22000 },
      ],
    });
    const paid = await json<{ days: string[] }>(await desk.get('/cash-outs/laundry-paid-days'));
    expect(paid.days).toEqual(expect.arrayContaining([yesterday, today()]));
  });
});

describe('Correcting a room', () => {
  it('records the Room a finished service was really in, unless another guest was there then', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(admin);
    const day = '2026-11-10';
    const at = (hhmm: string) => new Date(`${day}T${hhmm}:00+08:00`).toISOString();
    const [mine, other] = [crypto.randomUUID(), crypto.randomUUID()];
    const insert = (id: string, room: number, from: string, to: string, guest: string) =>
      env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, therapist_id, room_id, guest_name, started_at, done_at, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?, ?, ?, ?, ?, ?)`).bind(
        id, day, t, room, guest, at(from), at(to), at(from),
      );
    await env.DB.batch([insert(mine, 2, '15:00', '16:00', 'Lia Santos'), insert(other, 4, '15:30', '16:30', 'Ben Cruz')]);
    const body = { bookingId: mine, roomId: 3, reason: 'Guest was in Room 3; left a watch' };

    expect((await desk.post('/sales/correct-room', body)).status).toBe(403);
    // Room 4 had another guest from 3:30pm.
    expect((await admin.post('/sales/correct-room', { ...body, roomId: 4 })).status).toBe(409);
    expect((await admin.post('/sales/correct-room', body)).status).toBe(200);
    const row = await env.DB.prepare(`SELECT room_id FROM bookings WHERE id = ?`).bind(mine).first<{ room_id: number }>();
    expect(row?.room_id).toBe(3);

    type Detail = { services: { bookingId: string; roomId: number; roomName: string }[] };
    const detail = await (await admin.get(`/sales/day-detail?day=${day}`)).json<Detail>();
    expect(detail.services.find((s) => s.bookingId === mine)).toMatchObject({ roomId: 3, roomName: 'Room 3' });
    const audit = await env.DB.prepare(`SELECT reason FROM audit_log WHERE action = 'booking.correct_room' AND entity_id = ?`).bind(mine).first<{ reason: string }>();
    expect(audit?.reason).toBe(body.reason);
  });
});
