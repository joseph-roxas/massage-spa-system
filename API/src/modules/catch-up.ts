import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { addMinutes, CATCH_UP_DAYS, onBusinessDay, paymentProblem, payWeekOf, toManila, type Centavos } from '@spa/domain';
import { bookings, businessDays, caLedger, cashAdvances, dailySummaries, dtr, expenseCategories, expenses, payments, promos, sales, services, staff, vouchers } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { centavos, hhmm, name } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';
import { priceFor, saleStatements } from './sales';

const guard = [requireAuth, requireCapability('settings.manage')] as const;
const note = z.string().trim().max(200).optional();

const dtrBody = z.object({ staffId: z.string().min(1), clockIn: hhmm, clockOut: hhmm, isRelief: z.boolean().default(false) });
const saleBody = z.object({
  time: hhmm,
  serviceId: z.string().min(1),
  therapistId: z.string().min(1),
  promoId: z.string().min(1).nullable().default(null),
  statutory: z.enum(['senior', 'pwd']).nullable().default(null),
  idNumber: note,
  voucherSerial: z.string().trim().max(40).nullable().default(null),
  complimentaryReason: z.string().trim().min(3, 'Give a short reason.').max(300).nullable().default(null),
  method: z.enum(['cash', 'gcash']).default('cash'),
  gcashRef: note,
});
const expenseBody = z.object({ categoryId: z.string().min(1), description: name, amount: centavos.min(1) });
const advanceBody = z.object({ staffId: z.string().min(1), amount: centavos.min(1), note });

function dayOf(c: Context<AuthedEnv>): string | Response {
  const date = c.req.param('date')!;
  return (CATCH_UP_DAYS as readonly string[]).includes(date) ? date : fail(c, 404, 'not_a_catch_up_day', 'Only November 2 to 8 are entered here.');
}

/** A Catch-up Day closes without a cash count: its cash is covered by the opening balance entered afterwards. */
const closeDay = (c: Context<AuthedEnv>, date: string, now: string) =>
  c.var.db
    .insert(businessDays)
    .values({ date, openedAt: now, openedBy: c.var.user.id, closedAt: now, closedBy: c.var.user.id, closeNote: 'Entered afterwards from the paper records.' })
    .onConflictDoUpdate({ target: businessDays.date, set: { closedAt: now, closedBy: c.var.user.id } });

const clockOf = (iso: string) => toManila(new Date(iso)).time;

export const catchUpRoutes = new Hono<AuthedEnv>()
  .get('/catch-up/:date', ...guard, async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const [people, catalogue, categories, runningPromos, times, soldRows, spent, advances, week] = await Promise.all([
      db.select({ id: staff.id, displayName: staff.displayName, kind: staff.kind, therapistClass: staff.therapistClass }).from(staff).where(eq(staff.active, true)).orderBy(asc(staff.displayName)),
      db.select({ id: services.id, code: services.code, name: services.name, durationMin: services.durationMin, kind: services.kind }).from(services).where(eq(services.active, true)).orderBy(asc(services.sortOrder)),
      db.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories).where(eq(expenseCategories.active, true)).orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name)),
      db.select({ id: promos.id, name: promos.name }).from(promos).where(eq(promos.active, true)),
      db.select().from(dtr).where(eq(dtr.businessDay, date)).orderBy(asc(dtr.clockIn)),
      db
        .select({ sale: sales, startedAt: bookings.startedAt, method: payments.method })
        .from(sales)
        .innerJoin(bookings, eq(bookings.id, sales.bookingId))
        .leftJoin(payments, eq(payments.saleId, sales.id))
        .where(and(eq(sales.businessDay, date), eq(sales.status, 'paid')))
        .orderBy(asc(bookings.startedAt)),
      db.select().from(expenses).where(and(eq(expenses.date, date), eq(expenses.status, 'confirmed'))).orderBy(asc(expenses.createdAt)),
      db.select().from(cashAdvances).where(eq(cashAdvances.businessDay, date)).orderBy(asc(cashAdvances.createdAt)),
      db
        .select({ day: sales.businessDay, guests: sql<number>`count(*)`, total: sql<number>`sum(${sales.amountDue})` })
        .from(sales)
        .where(and(eq(sales.status, 'paid'), sql`${sales.businessDay} between ${CATCH_UP_DAYS[0]} and ${CATCH_UP_DAYS[6]}`))
        .groupBy(sales.businessDay),
    ]);
    const person = (id: string) => people.find((p) => p.id === id)?.displayName ?? id;
    const service = (id: string) => catalogue.find((s) => s.id === id);
    const lines = soldRows.map(({ sale: s, startedAt, method }) => ({
      id: s.id,
      time: startedAt ? clockOf(startedAt) : null,
      service: service(s.serviceId)?.name ?? s.serviceId,
      code: service(s.serviceId)?.code ?? '',
      therapist: person(s.therapistId),
      discountType: s.discountType,
      regularPrice: s.regularPrice,
      discountAmount: s.discountAmount,
      amountDue: s.amountDue,
      commissionAmount: s.commissionAmount,
      method,
      catchUp: s.catchUp,
    }));
    return c.json({
      date,
      people,
      services: catalogue,
      categories,
      promos: runningPromos,
      times: times.map((t) => ({ id: t.id, staff: person(t.staffId), clockIn: clockOf(t.clockIn), clockOut: t.clockOut ? clockOf(t.clockOut) : null, isRelief: t.isRelief })),
      sales: lines,
      expenses: spent.map((e) => ({ id: e.id, category: categories.find((x) => x.id === e.categoryId)?.name ?? e.categoryId, description: e.description, amount: e.amount })),
      cashAdvances: advances.map((a) => ({ id: a.id, staff: person(a.staffId), amount: a.amount, note: a.note })),
      week: week.map((w) => ({ day: w.day, guests: Number(w.guests), total: Number(w.total) })),
      totals: { guests: lines.length, sales: lines.reduce((s, l) => s + l.amountDue, 0), commission: lines.reduce((s, l) => s + l.commissionAmount, 0), expenses: spent.reduce((s, e) => s + e.amount, 0) },
    });
  })

  .post('/catch-up/:date/time-records', ...guard, zValidator('json', dtrBody, invalidInput), async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const input = c.req.valid('json');
    const person = await db.select().from(staff).where(eq(staff.id, input.staffId)).get();
    if (!person) return fail(c, 400, 'unknown_staff', 'Pick someone on the staff list.');
    const clockIn = onBusinessDay(date, input.clockIn);
    const clockOut = onBusinessDay(date, input.clockOut);
    if (clockOut <= clockIn) return fail(c, 400, 'bad_times', 'Clock-out must be after clock-in.');
    const now = nowIso();
    const id = crypto.randomUUID();
    await db.batch([
      // Entered by the Super Admin, so already reviewed.
      db.insert(dtr).values({ id, staffId: person.id, businessDay: date, clockIn: clockIn.toISOString(), clockOut: clockOut.toISOString(), source: 'manual', isRelief: input.isRelief, createdAt: now, reviewedAt: now, reviewedBy: c.var.user.id }),
      closeDay(c, date, now),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'catch_up.time_record', entity: 'dtr', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })

  .delete('/catch-up/:date/time-records/:id', ...guard, async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const row = await db.select().from(dtr).where(and(eq(dtr.id, c.req.param('id')), eq(dtr.businessDay, date))).get();
    if (!row) return fail(c, 404, 'not_found', 'Time record not found.');
    await db.batch([db.delete(dtr).where(eq(dtr.id, row.id)), auditInsert(db, { actorUserId: c.var.user.id, action: 'catch_up.time_record_remove', entity: 'dtr', entityId: row.id, before: row })]);
    return c.json({ ok: true });
  })

  /** One sale from the paper records: a finished Booking and its Sale, priced exactly as checkout would. */
  .post('/catch-up/:date/sales', ...guard, zValidator('json', saleBody, invalidInput), async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const input = c.req.valid('json');
    const summary = await db.select({ date: dailySummaries.date }).from(dailySummaries).where(eq(dailySummaries.date, date)).get();
    if (summary) return fail(c, 409, 'has_summary', 'This day already has a Daily Summary. Remove it under This year’s records first.');
    const [service, therapist] = await Promise.all([
      db.select().from(services).where(eq(services.id, input.serviceId)).get(),
      db.select().from(staff).where(eq(staff.id, input.therapistId)).get(),
    ]);
    if (!service) return fail(c, 400, 'unknown_service', 'Pick a service.');
    if (!therapist || therapist.kind !== 'therapist') return fail(c, 400, 'unknown_therapist', 'Pick a therapist.');

    const now = nowIso();
    const bookingId = crypto.randomUUID();
    const startedAt = onBusinessDay(date, input.time).toISOString();
    await db.insert(bookings).values({ id: bookingId, businessDay: date, kind: 'walk_in', status: 'done', serviceId: service.id, durationMin: service.durationMin, therapistId: therapist.id, startedAt, doneAt: addMinutes(startedAt, service.durationMin), createdAt: now, createdBy: c.var.user.id });
    const undo = () => db.delete(bookings).where(eq(bookings.id, bookingId));

    const checkout = {
      bookingId,
      statutory: input.statutory ? { kind: input.statutory, idNumber: input.idNumber || 'Not recorded' } : null,
      promoId: input.promoId,
      complimentaryReason: input.complimentaryReason,
      voucherSerial: input.voucherSerial,
    };
    const priced = await priceFor(c, checkout);
    if (priced instanceof Response) {
      await undo();
      return priced;
    }
    const due = priced.quote.amountDue;
    const lines = due > 0 ? [{ method: input.method, amount: due as Centavos, gcashRef: input.method === 'gcash' ? input.gcashRef || 'Not recorded' : null }] : [];
    const problem = paymentProblem(due, lines);
    if (problem) {
      await undo();
      return fail(c, 400, 'payment_mismatch', problem);
    }
    const { id, statements } = saleStatements(c, checkout, priced, lines, null, now);
    try {
      await db.batch([statements[0]!, ...statements.slice(1), db.update(sales).set({ catchUp: true }).where(eq(sales.id, id)), closeDay(c, date, now)]);
    } catch (err) {
      await undo();
      throw err;
    }
    return c.json({ id, amountDue: due, commissionAmount: priced.commission.amount }, 201);
  })

  .delete('/catch-up/:date/sales/:id', ...guard, async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const row = await db.select().from(sales).where(and(eq(sales.id, c.req.param('id')), eq(sales.businessDay, date))).get();
    if (!row || !row.catchUp) return fail(c, 404, 'not_found', 'Only sales entered here can be removed here.');
    await db.batch([
      db.update(vouchers).set({ status: 'unused', redeemedSaleId: null, redeemedAt: null }).where(eq(vouchers.redeemedSaleId, row.id)),
      db.delete(payments).where(eq(payments.saleId, row.id)),
      db.delete(sales).where(eq(sales.id, row.id)),
      db.delete(bookings).where(eq(bookings.id, row.bookingId)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'catch_up.sale_remove', entity: 'sale', entityId: row.id, before: row }),
    ]);
    return c.json({ ok: true });
  })

  .post('/catch-up/:date/expenses', ...guard, zValidator('json', expenseBody, invalidInput), async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const input = c.req.valid('json');
    const category = await db.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.id, input.categoryId)).get();
    if (!category) return fail(c, 400, 'unknown_category', 'Pick a category.');
    const now = nowIso();
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(expenses).values({ id, categoryId: input.categoryId, date, amount: input.amount, description: input.description, status: 'confirmed', createdAt: now, createdBy: c.var.user.id, confirmedAt: now, confirmedBy: c.var.user.id }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'catch_up.expense', entity: 'expense', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })

  .delete('/catch-up/:date/expenses/:id', ...guard, async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const row = await db.select().from(expenses).where(and(eq(expenses.id, c.req.param('id')), eq(expenses.date, date))).get();
    if (!row) return fail(c, 404, 'not_found', 'Expense not found.');
    await db.batch([db.delete(expenses).where(eq(expenses.id, row.id)), auditInsert(db, { actorUserId: c.var.user.id, action: 'catch_up.expense_remove', entity: 'expense', entityId: row.id, before: row })]);
    return c.json({ ok: true });
  })

  /** A Cash Advance given that week. It counts against that week's Payroll; the money left the shop on paper. */
  .post('/catch-up/:date/cash-advances', ...guard, zValidator('json', advanceBody, invalidInput), async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const input = c.req.valid('json');
    const person = await db.select().from(staff).where(eq(staff.id, input.staffId)).get();
    if (!person) return fail(c, 400, 'unknown_staff', 'Pick someone on the staff list.');
    const now = nowIso();
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(cashAdvances).values({ id, staffId: person.id, amount: input.amount, businessDay: date, againstWeekStart: person.kind === 'therapist' ? payWeekOf(date, 'therapist').start : null, note: input.note || null, createdAt: now, createdBy: c.var.user.id }),
      db.insert(caLedger).values({ id: crypto.randomUUID(), staffId: person.id, entry: 'advance', amount: input.amount, cashAdvanceId: id, createdAt: now, createdBy: c.var.user.id }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'catch_up.cash_advance', entity: 'cash_advance', entityId: id, after: input }),
    ]);
    return c.json({ id }, 201);
  })

  .delete('/catch-up/:date/cash-advances/:id', ...guard, async (c) => {
    const date = dayOf(c);
    if (date instanceof Response) return date;
    const db = c.var.db;
    const row = await db.select().from(cashAdvances).where(and(eq(cashAdvances.id, c.req.param('id')), eq(cashAdvances.businessDay, date))).get();
    if (!row) return fail(c, 404, 'not_found', 'Cash Advance not found.');
    await db.batch([
      db.delete(caLedger).where(eq(caLedger.cashAdvanceId, row.id)),
      db.delete(cashAdvances).where(eq(cashAdvances.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'catch_up.cash_advance_remove', entity: 'cash_advance', entityId: row.id, before: row }),
    ]);
    return c.json({ ok: true });
  });
