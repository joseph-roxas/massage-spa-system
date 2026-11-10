import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { businessDayOf, dayTotals, onCallOwed, SHOP_CLOSING_TIME, toManila, type Centavos } from '@spa/domain';
import { bookings, businessDays, cashOuts, cashTransfers, payments, sales, services, staff, stockIns, voucherPayments, voucherSales } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor, openDays, requireOpenDay } from '../lib/business-days';
import { pettyCashNow, salesCashAtStartOf } from '../lib/sales-cash';
import { autoClockOutWrites, stillClockedIn } from '../lib/auto-clock-out';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { isoDate } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

const reasonBody = z.object({ reason: z.string().trim().min(3, 'Give a short reason.').max(300) });
const dateParam = z.object({ date: isoDate });

/** The only Cash-outs the form records; Petty cash comes from the Petty Cash Fund, Laundry from Sales Cash. */
const FORM_CASH_OUTS = { petty_cash: 'petty', laundry: 'sales' } as const;

const newCashOut = z.object({
  category: z.enum(['petty_cash', 'laundry']),
  amount: z.number().int().min(1).max(10_000_000),
  purpose: z.string().trim().min(3, 'Say what the cash was for.').max(200),
});

/** Everything Day Close needs to know about a day: what's unfinished, what's owed, what's in the drawer. */
async function closingState(c: Context<AuthedEnv>, day: string) {
  const db = c.var.db;
  const [row, dayBookings, paidSales, dayPayments, voucherPays, dayCashOuts, allStaff, svc, carriedIn, moved] = await Promise.all([
    db.select().from(businessDays).where(eq(businessDays.date, day)).get(),
    db.select().from(bookings).where(eq(bookings.businessDay, day)),
    db.select().from(sales).where(and(eq(sales.businessDay, day), eq(sales.status, 'paid'))),
    db
      .select({ method: payments.method, amount: payments.amount })
      .from(payments)
      .innerJoin(sales, eq(sales.id, payments.saleId))
      .where(and(eq(payments.businessDay, day), eq(sales.status, 'paid'))),
    db
      .select({ method: voucherPayments.method, amount: voucherPayments.amount })
      .from(voucherPayments)
      .innerJoin(voucherSales, eq(voucherSales.id, voucherPayments.voucherSaleId))
      .where(and(eq(voucherPayments.businessDay, day), eq(voucherSales.status, 'paid'))),
    db.select().from(cashOuts).where(eq(cashOuts.businessDay, day)).orderBy(asc(cashOuts.createdAt)),
    db.select({ id: staff.id, displayName: staff.displayName, isOnCall: staff.isOnCall }).from(staff),
    db.select({ id: services.id, name: services.name }).from(services),
    salesCashAtStartOf(db, day),
    db
      .select({ s: sql<number>`sum(${cashTransfers.amount})` })
      .from(cashTransfers)
      .where(and(eq(cashTransfers.businessDay, day), ne(cashTransfers.kind, 'opening')))
      .get(),
  ]);

  const onCallStaff = allStaff.filter((s) => s.isOnCall);
  const paidBookingIds = new Set(paidSales.map((s) => s.bookingId));
  const serviceName = (id: string) => svc.find((s) => s.id === id)?.name ?? id;
  const blockers = dayBookings
    .filter((b) => ['scheduled', 'waiting', 'in_service'].includes(b.status) || (b.status === 'done' && !paidBookingIds.has(b.id)))
    // Enough of the booking for the close dialog to finish it there: the board only shows today's guests.
    .map((b) => ({
      bookingId: b.id,
      status: b.status,
      guest: b.guestName || 'Walk-in guest',
      guestName: b.guestName,
      guestId: b.guestId,
      serviceId: b.serviceId,
      service: serviceName(b.serviceId),
      therapistName: allStaff.find((s) => s.id === b.therapistId)?.displayName ?? null,
      problem:
        b.status === 'done'
          ? 'Done but not checked out'
          : b.status === 'in_service'
            ? 'Still in service'
            : b.status === 'waiting'
              ? 'Still waiting: start or cancel'
              : 'Booked but not arrived: it closes by itself 15 minutes after its time, or cancel it',
    }));

  const onCallIds = new Set(onCallStaff.map((s) => s.id));
  const owed = onCallOwed(
    paidSales.filter((s) => onCallIds.has(s.therapistId)).map((s) => ({ staffId: s.therapistId, amount: s.commissionAmount })),
    dayCashOuts.filter((x) => x.category === 'on_call_commission' && x.staffId).map((x) => ({ staffId: x.staffId!, amount: x.amount })),
  ).map((o) => ({ ...o, displayName: onCallStaff.find((s) => s.id === o.staffId)!.displayName }));

  // All Sales Cash in the shop is counted (ADR 0003): what was there, plus today's cash, less what left it.
  // On-call pay comes out at close, so expect it gone. Petty cash comes from its own fund.
  const totals = dayTotals(
    [...dayPayments, ...voucherPays],
    [...dayCashOuts.filter((x) => x.source === 'sales'), ...owed],
    { carriedIn, transfersOut: Number(moved?.s ?? 0) },
  );
  const vouchersSold = voucherPays.reduce((s, p) => s + p.amount, 0) as Centavos;
  // Everyone still clocked in gets an Auto Clock-out at the close time.
  const stillIn = await stillClockedIn(db, day);
  return { row, blockers, owed, totals, vouchersSold, cashOuts: dayCashOuts, guests: paidSales.length, stillIn };
}

export const dayRoutes = new Hono<AuthedEnv>()
  .use('/days', requireAuth)
  .use('/days/*', requireAuth)
  .use('/cash-outs', requireAuth, requireCapability('cashouts.record'))
  .use('/cash-outs/*', requireAuth, requireCapability('cashouts.record'))

  /** Today's Business Day and any earlier one left open. */
  .get('/days/current', async (c) => {
    const today = businessDayOf(new Date());
    const open = await openDays(c.var.db);
    const row = await c.var.db.select().from(businessDays).where(eq(businessDays.date, today)).get();
    return c.json({ today, day: row ?? null, unclosed: open.filter((d) => d.date < today).map((d) => d.date) });
  })

  .get('/days/:date/close-preview', requireCapability('day.close'), zValidator('param', dateParam, invalidInput), async (c) => {
    const { row, ...state } = await closingState(c, c.req.valid('param').date);
    if (!row) return fail(c, 404, 'not_found', 'Nothing happened on that day.');
    return c.json({ day: row, ...state });
  })

  .post(
    '/days/:date/close',
    requireCapability('day.close'),
    zValidator('param', dateParam, invalidInput),
    zValidator('json', z.object({ countedCash: z.number().int().min(0).max(100_000_000), note: z.string().trim().max(300).optional() }), invalidInput),
    async (c) => {
      const { date } = c.req.valid('param');
      const input = c.req.valid('json');
      const db = c.var.db;
      const state = await closingState(c, date);
      if (!state.row) return fail(c, 404, 'not_found', 'Nothing happened on that day.');
      if (state.row.closedAt) return fail(c, 409, 'day_closed', 'This day is already closed.');
      const earlier = (await openDays(db)).find((d) => d.date < date);
      if (earlier) return fail(c, 409, 'previous_day_open', `Close the Business Day of ${earlier.date} first.`);
      if (state.blockers.length) {
        return fail(c, 409, 'unfinished_guests', `${state.blockers.length} guest(s) are not finished or checked out yet.`);
      }

      const now = nowIso();
      const variance = input.countedCash - state.totals.expectedCash;
      const closed = {
        closedAt: now,
        closedBy: c.var.user.id,
        expectedCash: state.totals.expectedCash,
        expectedGcash: state.totals.expectedGcash,
        countedCash: input.countedCash,
        variance,
        closeNote: input.note || null,
      };
      await db.batch([
        db.update(businessDays).set(closed).where(eq(businessDays.date, date)),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'day.close', entity: 'business_day', entityId: date, after: closed }),
        // On-call Therapists are paid their day's Commission from the drawer.
        ...state.owed.map((o) =>
          db.insert(cashOuts).values({
            id: crypto.randomUUID(),
            businessDay: date,
            category: 'on_call_commission',
            amount: o.amount,
            purpose: `On-call pay: ${o.displayName}`,
            staffId: o.staffId,
            createdAt: now,
            createdBy: c.var.user.id,
          }),
        ),
        ...state.stillIn.flatMap((e) => autoClockOutWrites(db, c.var.user.id, e.id, now, 'Clocked out at Day Close')),
      ]);
      return c.json({
        ok: true,
        ...state.totals,
        countedCash: input.countedCash,
        variance: variance as Centavos,
        onCallPaid: state.owed,
        clockedOut: state.stillIn.map((e) => e.displayName),
      });
    },
  )

  .post('/days/:date/reopen', requireCapability('day.reopen'), zValidator('param', dateParam, invalidInput), zValidator('json', reasonBody, invalidInput), async (c) => {
    const { date } = c.req.valid('param');
    const db = c.var.db;
    const row = await db.select().from(businessDays).where(eq(businessDays.date, date)).get();
    if (!row?.closedAt) return fail(c, 409, 'not_closed', 'That day is not closed.');
    const { reason } = c.req.valid('json');
    await db.batch([
      db.update(businessDays).set({ closedAt: null, closedBy: null, reopenedAt: nowIso(), reopenedBy: c.var.user.id }).where(eq(businessDays.date, date)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'day.reopen', entity: 'business_day', entityId: date, before: row, reason }),
    ]);
    return c.json({ ok: true });
  })

  /** Closing before 11:00pm. Recorded straight away; the Super Admin may reject it later. */
  .post('/days/current/early-close', requireCapability('day.close'), zValidator('json', reasonBody, invalidInput), async (c) => {
    const now = new Date();
    if (toManila(now).time >= SHOP_CLOSING_TIME || toManila(now).time < '06:00') {
      return fail(c, 409, 'not_early', 'It is past closing time, so this is not an Early Close.');
    }
    const day = businessDayOf(now);
    const blocked = await openDayFor(c, day);
    if (blocked) return blocked;
    const { reason } = c.req.valid('json');
    const db = c.var.db;
    const set = { earlyCloseAt: now.toISOString(), earlyCloseReason: reason, earlyCloseBy: c.var.user.id, earlyCloseStatus: 'recorded' as const };
    await db.batch([
      db.update(businessDays).set(set).where(eq(businessDays.date, day)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'day.early_close', entity: 'business_day', entityId: day, after: set, reason }),
    ]);
    return c.json({ ok: true });
  })

  .post(
    '/days/:date/early-close/reject',
    requireCapability('day.reopen'),
    zValidator('param', dateParam, invalidInput),
    zValidator('json', reasonBody, invalidInput),
    async (c) => {
      const { date } = c.req.valid('param');
      const db = c.var.db;
      const row = await db.select().from(businessDays).where(eq(businessDays.date, date)).get();
      if (row?.earlyCloseStatus !== 'recorded') return fail(c, 409, 'no_early_close', 'No Early Close is recorded for that day.');
      const { reason } = c.req.valid('json');
      await db.batch([
        db.update(businessDays).set({ earlyCloseStatus: 'rejected' }).where(eq(businessDays.date, date)),
        auditInsert(db, { actorUserId: c.var.user.id, action: 'day.early_close_reject', entity: 'business_day', entityId: date, reason }),
      ]);
      return c.json({ ok: true });
    },
  )

  .get('/cash-outs', zValidator('query', z.object({ day: isoDate }), invalidInput), async (c) => {
    const rows = await c.var.db.select().from(cashOuts).where(eq(cashOuts.businessDay, c.req.valid('query').day)).orderBy(asc(cashOuts.createdAt));
    return c.json({ cashOuts: rows });
  })

  .post('/cash-outs', zValidator('json', newCashOut, invalidInput), async (c) => {
    const day = businessDayOf(new Date());
    const blocked = await openDayFor(c, day);
    if (blocked) return blocked;
    const input = c.req.valid('json');
    if (input.category === 'petty_cash') {
      const balance = await pettyCashNow(c.var.db);
      if (input.amount > balance) return fail(c, 409, 'petty_cash_short', `Only ${(balance / 100).toFixed(2)} is left in petty cash. Top it up from sales cash first.`);
    }
    const id = crypto.randomUUID();
    await c.var.db
      .insert(cashOuts)
      .values({ id, businessDay: day, ...input, source: FORM_CASH_OUTS[input.category], createdAt: nowIso(), createdBy: c.var.user.id });
    return c.json({ id }, 201);
  })

  /** A mistaken Cash-out can be removed while its day is open. */
  .delete('/cash-outs/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(cashOuts).where(eq(cashOuts.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Cash-out not found.');
    if (row.category === 'on_call_commission') return fail(c, 409, 'on_call_pay', 'On-call pay is recorded by Day Close.');
    if (row.category === 'cash_advance') return fail(c, 409, 'cash_advance', 'Remove the Cash Advance itself instead.');
    if (row.category === 'relief_pay') return fail(c, 409, 'relief_pay', 'Relief pay is recorded from the Front Desk prompt. Ask the Super Admin to correct it.');
    const stocked = await db.select({ id: stockIns.id }).from(stockIns).where(eq(stockIns.cashOutId, row.id)).get();
    if (stocked) return fail(c, 409, 'inventory_purchase', 'This paid for an inventory purchase. Ask the Super Admin to correct it.');
    const blocked = await requireOpenDay(c, row.businessDay);
    if (blocked) return blocked;
    await db.batch([
      db.delete(cashOuts).where(eq(cashOuts.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'cash_out.delete', entity: 'cash_out', entityId: row.id, before: row }),
    ]);
    return c.json({ ok: true });
  });

