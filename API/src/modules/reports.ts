import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, gte, isNotNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  businessDayOf,
  choosesReportDates,
  FOC_LABELS,
  parseLaundryBreakdown,
  focGroup,
  REPORTS,
  reportsFor,
  serviceTimes,
  totalsOf,
  withSubtotals,
  type Column,
  type FocGroup,
  type Report,
  type ReportName,
  type Row,
} from '@spa/domain';
import {
  bookings,
  cashOuts,
  dtr,
  expenseCategories,
  expenses,
  items,
  payments,
  payrolls,
  sales,
  services,
  staff,
  stockIns,
  stockOuts,
  therapistChanges,
  voucherPayments,
  voucherSales,
  dailySummaries,
  rejects,
} from '@spa/db';
import type { AuthedEnv } from '../env';
import { fail, invalidInput } from '../lib/http';
import { isoDate } from '../lib/validation';
import { requireAuth } from '../auth/middleware';

type Db = DrizzleD1Database;
type Range = { from: string; to: string; therapist?: string; guest?: string; method?: 'cash' | 'gcash' };

const CASH_OUT_LABELS: Record<string, string> = { relief_pay: 'Relief pay', petty_cash: 'Petty cash', laundry: 'Laundry', supplies: 'Supplies', food: 'Food / rice', transport: 'Transport', other: 'Other' };

const shortDate = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });

const col = (key: string, label: string, type: Column['type'] = 'text'): Column => ({ key, label, type });
const n = (v: unknown) => Number(v ?? 0);

/** Adds `values` into the row for `key`, creating it with `base` first. */
function into(map: Map<string, Row>, key: string, base: Row, values: Row) {
  const row = map.get(key) ?? { ...base };
  for (const [k, v] of Object.entries(values)) row[k] = (Number(row[k]) || 0) + (Number(v) || 0);
  map.set(key, row);
}

const pastDays = (db: Db, r: Range) => db.select().from(dailySummaries).where(and(gte(dailySummaries.date, r.from), lte(dailySummaries.date, r.to)));

export async function dailySales(db: Db, r: Range): Promise<Report> {
  const [s, pay, vs, vpay, outs, turned, past] = await Promise.all([
    db
      .select({
        day: sales.businessDay,
        guests: sql<number>`count(*)`,
        regular: sql<number>`sum(${sales.regularPrice})`,
        discounts: sql<number>`sum(${sales.discountAmount})`,
        services: sql<number>`sum(${sales.serviceAmount})`,
        setAside: sql<number>`sum(${sales.setAside})`,
        commission: sql<number>`sum(${sales.commissionAmount})`,
      })
      .from(sales)
      .where(and(eq(sales.status, 'paid'), gte(sales.businessDay, r.from), lte(sales.businessDay, r.to)))
      .groupBy(sales.businessDay),
    db
      .select({ day: payments.businessDay, method: payments.method, amount: sql<number>`sum(${payments.amount})` })
      .from(payments)
      .innerJoin(sales, eq(sales.id, payments.saleId))
      .where(and(eq(sales.status, 'paid'), gte(payments.businessDay, r.from), lte(payments.businessDay, r.to)))
      .groupBy(payments.businessDay, payments.method),
    db
      .select({ day: voucherSales.businessDay, total: sql<number>`sum(${voucherSales.total})` })
      .from(voucherSales)
      .where(and(eq(voucherSales.status, 'paid'), gte(voucherSales.businessDay, r.from), lte(voucherSales.businessDay, r.to)))
      .groupBy(voucherSales.businessDay),
    db
      .select({ day: voucherPayments.businessDay, method: voucherPayments.method, amount: sql<number>`sum(${voucherPayments.amount})` })
      .from(voucherPayments)
      .innerJoin(voucherSales, eq(voucherSales.id, voucherPayments.voucherSaleId))
      .where(and(eq(voucherSales.status, 'paid'), gte(voucherPayments.businessDay, r.from), lte(voucherPayments.businessDay, r.to)))
      .groupBy(voucherPayments.businessDay, voucherPayments.method),
    db
      .select({ day: cashOuts.businessDay, amount: sql<number>`sum(${cashOuts.amount})` })
      .from(cashOuts)
      .where(and(gte(cashOuts.businessDay, r.from), lte(cashOuts.businessDay, r.to)))
      .groupBy(cashOuts.businessDay),
    db
      .select({ day: rejects.businessDay, n: sql<number>`count(*)` })
      .from(rejects)
      .where(and(gte(rejects.businessDay, r.from), lte(rejects.businessDay, r.to)))
      .groupBy(rejects.businessDay),
    pastDays(db, r),
  ]);
  const columns = [
    col('date', 'Business Day', 'date'),
    col('source', 'Detail'),
    col('guests', 'Guests', 'int'),
    col('rejects', 'Turned away', 'int'),
    col('regular', 'Regular Price', 'money'),
    col('discounts', 'Discounts & FOCs', 'money'),
    col('services', 'Services paid', 'money'),
    col('setAside', 'Owner’s Set-aside', 'money'),
    col('vouchers', 'Vouchers sold', 'money'),
    col('cash', 'Cash in', 'money'),
    col('gcash', 'GCash in', 'money'),
    col('cashOuts', 'Cash-outs', 'money'),
    col('commission', 'Commission', 'money'),
  ];
  const days = new Map<string, Row>();
  const base = (day: string): Row => ({ date: day });
  for (const x of s) into(days, x.day, base(x.day), { guests: x.guests, regular: x.regular, discounts: x.discounts, services: x.services, setAside: x.setAside, commission: x.commission });
  for (const x of [...pay, ...vpay]) into(days, x.day, base(x.day), { [x.method]: x.amount });
  for (const x of vs) into(days, x.day, base(x.day), { vouchers: x.total });
  for (const x of outs) into(days, x.day, base(x.day), { cashOuts: x.amount });
  for (const x of turned) into(days, x.day, base(x.day), { rejects: x.n });
  for (const x of past) {
    into(days, x.date, base(x.date), {
      guests: x.guests,
      rejects: x.rejects,
      regular: x.cash + x.gcash,
      discounts: x.foc,
      services: x.cash + x.gcash - x.foc,
      setAside: x.oil,
      vouchers: x.voucher,
      cash: x.cash + x.voucher - x.foc,
      gcash: x.gcash,
      cashOuts: x.laundry + x.expenses,
      commission: x.commission,
    });
    days.get(x.date)!.source = 'Summary only';
  }
  const rows = [...days.values()]
    .map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? (c.type === 'date' || c.type === 'text' ? null : 0)])))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    title: 'Daily sales',
    columns,
    rows,
    totals: totalsOf(columns, rows),
    note: 'Services paid = Regular Price − Discounts & FOCs. The Owner’s Set-aside is already inside the sales, shown for information. Cash and GCash include Voucher sales. Days marked Summary only are from before go-live.',
  };
}

export async function therapistSales(db: Db, r: Range): Promise<Report> {
  const [s, requested, worked, people] = await Promise.all([
    db
      .select({
        id: sales.therapistId,
        services: sql<number>`count(*)`,
        regular: sql<number>`sum(${sales.regularPrice})`,
        paid: sql<number>`sum(${sales.serviceAmount})`,
        focs: sql<number>`sum(case when ${sales.focKind} != 'none' then 1 else 0 end)`,
        commission: sql<number>`sum(${sales.commissionAmount})`,
      })
      .from(sales)
      .where(and(eq(sales.status, 'paid'), gte(sales.businessDay, r.from), lte(sales.businessDay, r.to)))
      .groupBy(sales.therapistId),
    db
      .select({ id: bookings.requestedTherapistId, count: sql<number>`count(*)` })
      .from(bookings)
      .innerJoin(sales, and(eq(sales.bookingId, bookings.id), eq(sales.status, 'paid')))
      .where(and(isNotNull(bookings.requestedTherapistId), eq(bookings.requestedTherapistId, bookings.therapistId), gte(bookings.businessDay, r.from), lte(bookings.businessDay, r.to)))
      .groupBy(bookings.requestedTherapistId),
    db
      .select({ id: dtr.staffId, days: sql<number>`count(distinct ${dtr.businessDay})` })
      .from(dtr)
      .where(and(gte(dtr.businessDay, r.from), lte(dtr.businessDay, r.to)))
      .groupBy(dtr.staffId),
    db.select().from(staff).where(eq(staff.kind, 'therapist')),
  ]);
  const columns = [
    col('name', 'Therapist'),
    col('type', 'Type'),
    col('days', 'Days worked', 'int'),
    col('services', 'Services', 'int'),
    col('requested', 'Requested', 'int'),
    col('focs', 'FOCs', 'int'),
    col('regular', 'Regular Price', 'money'),
    col('paid', 'Paid by guests', 'money'),
    col('commission', 'Commission', 'money'),
  ];
  const rows = people
    .map((p) => {
      const x = s.find((y) => y.id === p.id);
      const days = n(worked.find((w) => w.id === p.id)?.days);
      if (!x && !days) return null;
      return {
        name: p.displayName,
        type: `${p.therapistClass === 'lmt' ? 'LMT' : 'Regular'}${p.isOnCall ? ', on-call' : ''}`,
        days,
        services: n(x?.services),
        requested: n(requested.find((q) => q.id === p.id)?.count),
        focs: n(x?.focs),
        regular: n(x?.regular),
        paid: n(x?.paid),
        commission: n(x?.commission),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    // By sales, not Commission: an LMT's higher rate would put them first for the same work.
    .sort((a, b) => b.regular - a.regular);
  return { title: 'Sales per therapist', columns, rows, totals: totalsOf(columns, rows), note: 'Requested = served a Guest who asked for them. Commission is on the Regular Price less any Owner’s Set-aside, FOCs included.' };
}

const whenLabel = (iso: string) => new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Every payment received, one line each: for Services and for Vouchers. A sale
 * paid partly in cash and partly by GCash is two lines. Nov 2-8 entries were
 * typed in afterwards, so their time is when the Service ended.
 */
async function paymentsReport(db: Db, r: Range): Promise<Report> {
  const guestLike = r.guest ? `%${r.guest.trim().toLowerCase()}%` : null;
  const [forServices, forVouchers] = await Promise.all([
    db
      .select({
        id: payments.id,
        at: payments.createdAt,
        doneAt: bookings.doneAt,
        catchUp: sales.catchUp,
        guest: bookings.guestName,
        paidFor: services.name,
        method: payments.method,
        amount: payments.amount,
        ref: payments.gcashRef,
      })
      .from(payments)
      .innerJoin(sales, eq(sales.id, payments.saleId))
      .innerJoin(bookings, eq(bookings.id, sales.bookingId))
      .innerJoin(services, eq(services.id, sales.serviceId))
      .where(
        and(
          eq(sales.status, 'paid'),
          gte(payments.businessDay, r.from),
          lte(payments.businessDay, r.to),
          r.method ? eq(payments.method, r.method) : undefined,
          guestLike ? sql`lower(coalesce(${bookings.guestName}, '')) like ${guestLike}` : undefined,
        ),
      ),
    db
      .select({ id: voucherPayments.id, at: voucherPayments.createdAt, guest: voucherSales.buyerName, paidFor: services.name, qty: voucherSales.qtyPaid, method: voucherPayments.method, amount: voucherPayments.amount, ref: voucherPayments.gcashRef })
      .from(voucherPayments)
      .innerJoin(voucherSales, eq(voucherSales.id, voucherPayments.voucherSaleId))
      .innerJoin(services, eq(services.id, voucherSales.serviceId))
      .where(
        and(
          eq(voucherSales.status, 'paid'),
          gte(voucherPayments.businessDay, r.from),
          lte(voucherPayments.businessDay, r.to),
          r.method ? eq(voucherPayments.method, r.method) : undefined,
          guestLike ? sql`lower(coalesce(${voucherSales.buyerName}, '')) like ${guestLike}` : undefined,
        ),
      ),
  ]);
  const columns = [
    col('when', 'Date and time'),
    col('guest', 'Guest'),
    col('paidFor', 'Paid for'),
    col('method', 'Payment'),
    col('amount', 'Amount paid', 'money'),
    col('cash', 'Cash', 'money'),
    col('gcash', 'GCash', 'money'),
    col('ref', 'Reference number'),
  ];
  const lines = [
    ...forServices.map((x) => ({ ...x, at: x.catchUp && x.doneAt ? x.doneAt : x.at, paidFor: x.paidFor })),
    ...forVouchers.map((x) => ({ ...x, paidFor: `Voucher: ${x.paidFor}${x.qty > 1 ? ` × ${x.qty}` : ''}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const rows: Row[] = lines.map((x) => ({
    when: whenLabel(x.at),
    guest: x.guest || 'Walk-in guest',
    paidFor: x.paidFor,
    method: x.method === 'gcash' ? 'GCash' : 'Cash',
    amount: x.amount,
    cash: x.method === 'cash' ? x.amount : null,
    gcash: x.method === 'gcash' ? x.amount : null,
    ref: x.method === 'gcash' ? x.ref || 'Not recorded' : null,
  }));
  return {
    title: 'Payments',
    columns,
    rows,
    totals: totalsOf(columns, rows),
    note: 'Each payment received, for Services and Vouchers. A bill paid partly in cash and partly by GCash shows as two lines. Sales entered afterwards for Nov 2–8 show when the Service ended.',
  };
}

/** Every Service a Therapist was paid for, one line each. */
async function therapistDetail(db: Db, r: Range): Promise<Report> {
  const inRange = and(eq(sales.status, 'paid'), gte(sales.businessDay, r.from), lte(sales.businessDay, r.to), r.therapist ? eq(sales.therapistId, r.therapist) : undefined);
  const [lines, people, changes] = await Promise.all([
    db
      .select({
        bookingId: sales.bookingId,
        name: staff.displayName,
        startedAt: bookings.startedAt,
        guest: bookings.guestName,
        enteredLate: bookings.enteredLate,
        enteredAt: bookings.createdAt,
        service: services.name,
        regular: sales.regularPrice,
        topUps: sales.topUpsTotal,
        setAside: sales.setAside,
        commission: sales.commissionAmount,
      })
      .from(sales)
      .innerJoin(bookings, eq(bookings.id, sales.bookingId))
      .innerJoin(services, eq(services.id, sales.serviceId))
      .innerJoin(staff, eq(staff.id, sales.therapistId))
      .where(inRange)
      .orderBy(asc(staff.displayName), asc(bookings.startedAt)),
    db.select({ id: staff.id, name: staff.displayName }).from(staff),
    db
      .select({ bookingId: therapistChanges.bookingId, from: therapistChanges.fromTherapistId, reason: therapistChanges.reason })
      .from(therapistChanges)
      .innerJoin(bookings, eq(bookings.id, therapistChanges.bookingId))
      .where(and(gte(bookings.businessDay, r.from), lte(bookings.businessDay, r.to)))
      .orderBy(asc(therapistChanges.changedAt)),
  ]);
  const columns = [
    col('name', 'Therapist'),
    col('when', 'Date and time'),
    col('guest', 'Guest'),
    col('service', 'Service'),
    col('regular', 'Regular Price', 'money'),
    col('setAside', 'Owner’s Set-aside', 'money'),
    col('commission', 'Commission', 'money'),
    col('note', 'Note'),
  ];
  const rows: Row[] = lines.map((x) => {
    const change = changes.filter((c) => c.bookingId === x.bookingId).at(-1);
    const notes = [x.enteredLate ? `Entered late, at ${whenLabel(x.enteredAt)}` : null, x.topUps > 0 ? `Includes added time ₱${x.topUps / 100}` : null, change ? `Took over from ${people.find((p) => p.id === change.from)?.name ?? 'another therapist'}: ${change.reason}` : null].filter(Boolean);
    return { name: x.name, when: x.startedAt ? whenLabel(x.startedAt) : null, guest: x.guest || 'Walk-in guest', service: x.service, regular: x.regular, setAside: x.setAside, commission: x.commission, note: notes.join(' · ') || null };
  });
  return {
    title: 'Therapist Sales',
    columns,
    rows: withSubtotals(columns, rows, 'name'),
    totals: totalsOf(columns, rows),
    note: 'Commission is on the Regular Price less the Owner’s Set-aside, at the rate for that day. It is the same whatever the Guest paid.',
  };
}

/** Who took over a Service under way, and why. */
async function therapistChangesReport(db: Db, r: Range): Promise<Report> {
  const [rows0, people] = await Promise.all([
    db
      .select({ changedAt: therapistChanges.changedAt, service: services.name, from: therapistChanges.fromTherapistId, to: therapistChanges.toTherapistId, minutes: therapistChanges.minutesServed, reason: therapistChanges.reason })
      .from(therapistChanges)
      .innerJoin(bookings, eq(bookings.id, therapistChanges.bookingId))
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(and(gte(bookings.businessDay, r.from), lte(bookings.businessDay, r.to)))
      .orderBy(asc(therapistChanges.changedAt)),
    db.select({ id: staff.id, name: staff.displayName }).from(staff),
  ]);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const columns = [col('when', 'Date and time'), col('service', 'Service'), col('replaced', 'Replaced'), col('now', 'Taken over by'), col('minutes', 'Minutes served', 'int'), col('reason', 'Reason')];
  const rows = rows0.map((x) => ({ when: whenLabel(x.changedAt), service: x.service, replaced: nameOf(x.from), now: nameOf(x.to), minutes: x.minutes, reason: x.reason }));
  return { title: 'Therapist Changes', columns, rows, note: 'The replaced Therapist earns nothing for that Service and keeps their place in the Rotation.' };
}

async function guests(db: Db, r: Range): Promise<Report> {
  const [rows0, past] = await Promise.all([
    db
      .select({ day: bookings.businessDay, kind: bookings.kind, status: bookings.status, count: sql<number>`count(*)` })
      .from(bookings)
      .where(and(gte(bookings.businessDay, r.from), lte(bookings.businessDay, r.to)))
      .groupBy(bookings.businessDay, bookings.kind, bookings.status),
    pastDays(db, r),
  ]);
  const columns = [
    col('date', 'Business Day', 'date'),
    col('guests', 'Guests served', 'int'),
    col('walkIns', 'Walk-ins', 'int'),
    col('scheduled', 'Scheduled', 'int'),
    col('noShows', 'No-shows', 'int'),
    col('cancelled', 'Cancelled', 'int'),
  ];
  const days = new Map<string, Row>();
  for (const x of rows0) {
    const served = x.status === 'done' || x.status === 'in_service';
    into(days, x.day, { date: x.day }, {
      guests: served ? x.count : 0,
      walkIns: served && x.kind === 'walk_in' ? x.count : 0,
      scheduled: served && x.kind === 'scheduled' ? x.count : 0,
      noShows: x.status === 'no_show' ? x.count : 0,
      cancelled: x.status === 'cancelled' ? x.count : 0,
    });
  }
  for (const x of past) into(days, x.date, { date: x.date }, { guests: x.guests });
  const rows = [...days.values()].map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? 0]))).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { title: 'Guests per day', columns, rows, totals: totalsOf(columns, rows) };
}

const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

async function serviceTimesReport(db: Db, r: Range): Promise<Report> {
  const starts = await db
    .select({ service: services.name, duration: services.durationMin, code: services.code, startedAt: bookings.startedAt })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(and(isNotNull(bookings.startedAt), ne(bookings.status, 'cancelled'), gte(bookings.businessDay, r.from), lte(bookings.businessDay, r.to)));
  const t = serviceTimes(starts.map((s) => ({ service: `${s.service} (${s.code})`, startedAt: s.startedAt! })));
  const columns = [col('service', 'Service'), ...t.hours.map((h) => col(`h${h}`, hourLabel(h), 'int')), col('total', 'Total', 'int')];
  const rows = t.rows.map((x) => ({ service: x.service, ...Object.fromEntries(t.hours.map((h) => [`h${h}`, x.counts[h] ?? 0])), total: x.total }));
  return { title: 'Services by start time', columns, rows, totals: totalsOf(columns, rows), note: 'How many of each Service started in each hour. Darker cells are busier.' };
}

export async function foc(db: Db, r: Range): Promise<Report> {
  const rows0 = await db
    .select({
      type: sales.discountType,
      foc: sales.focKind,
      count: sql<number>`count(*)`,
      regular: sql<number>`sum(${sales.regularPrice})`,
      discount: sql<number>`sum(${sales.discountAmount})`,
      paid: sql<number>`sum(${sales.serviceAmount})`,
      commission: sql<number>`sum(${sales.commissionAmount})`,
    })
    .from(sales)
    .where(and(eq(sales.status, 'paid'), ne(sales.discountType, 'none'), gte(sales.businessDay, r.from), lte(sales.businessDay, r.to)))
    .groupBy(sales.discountType, sales.focKind);
  const columns = [
    col('group', 'Discount / FOC'),
    col('count', 'Services', 'int'),
    col('regular', 'Regular Price', 'money'),
    col('discount', 'Given (shop covers)', 'money'),
    col('paid', 'Paid by guests', 'money'),
    col('commission', 'Commission paid', 'money'),
  ];
  const groups = new Map<string, Row>();
  for (const x of rows0) {
    const g = focGroup(x.type, x.foc);
    if (!g) continue;
    into(groups, g, { group: FOC_LABELS[g] }, { count: x.count, regular: x.regular, discount: x.discount, paid: x.paid, commission: x.commission });
  }
  const order = Object.keys(FOC_LABELS) as FocGroup[];
  const rows = order.filter((g) => groups.has(g)).map((g) => groups.get(g)!);
  return {
    title: 'Discounts and FOCs',
    columns,
    rows,
    totals: totalsOf(columns, rows),
    note: 'Real FOCs are truly free (Complimentary, the free 6th Voucher). A paid Voucher is a Prepaid FOC: its money came in when it was sold.',
  };
}

async function payroll(db: Db, r: Range): Promise<Report> {
  const rows0 = await db
    .select({ p: payrolls, name: staff.displayName })
    .from(payrolls)
    .innerJoin(staff, eq(staff.id, payrolls.staffId))
    .where(and(gte(payrolls.weekStart, r.from), lte(payrolls.weekStart, r.to)))
    .orderBy(asc(payrolls.weekStart), asc(payrolls.kind), asc(staff.displayName));
  const columns = [
    col('week', 'Pay Week of', 'date'),
    col('name', 'Name'),
    col('kind', 'Role'),
    col('status', 'Status'),
    col('gross', 'Gross', 'money'),
    col('gov', 'SSS · PHIC · Pag-IBIG', 'money'),
    col('ca', 'CA deducted', 'money'),
    col('net', 'Net pay', 'money'),
  ];
  const STATUS = { draft: 'Draft', approved: 'Approved', released: 'Paid' } as const;
  const rows = rows0.map(({ p, name }) => ({
    week: p.weekStart,
    name,
    kind: p.kind === 'therapist' ? 'Therapist' : p.kind === 'reliever' ? 'Outside Reliever' : 'Receptionist',
    status: STATUS[p.status],
    gross: p.gross,
    gov: p.govSss + p.govPhic + p.govPagibig,
    ca: p.caDeduction,
    net: p.net,
  }));
  return { title: 'Payroll', columns, rows, totals: totalsOf(columns, rows), note: 'Pay Weeks starting in the range. On-call Therapists are paid daily and appear under Daily sales (Cash-outs).' };
}

async function inventory(db: Db, r: Range): Promise<Report> {
  const [list, ins, outs, allIns, allOuts] = await Promise.all([
    db.select().from(items).orderBy(asc(items.sortOrder), asc(items.name)),
    db
      .select({ id: stockIns.itemId, qty: sql<number>`sum(${stockIns.qty})`, spent: sql<number>`sum(${stockIns.qty} * coalesce(${stockIns.unitPrice}, 0))` })
      .from(stockIns)
      .where(and(eq(stockIns.kind, 'purchase'), gte(stockIns.purchaseDate, r.from), lte(stockIns.purchaseDate, r.to)))
      .groupBy(stockIns.itemId),
    db
      .select({ id: stockOuts.itemId, qty: sql<number>`sum(${stockOuts.qty})`, last: sql<string>`max(${stockOuts.date})` })
      .from(stockOuts)
      .where(and(gte(stockOuts.date, r.from), lte(stockOuts.date, r.to)))
      .groupBy(stockOuts.itemId),
    db.select({ id: stockIns.itemId, qty: sql<number>`sum(${stockIns.qty})` }).from(stockIns).groupBy(stockIns.itemId),
    db.select({ id: stockOuts.itemId, qty: sql<number>`sum(${stockOuts.qty})` }).from(stockOuts).groupBy(stockOuts.itemId),
  ]);
  const columns = [
    col('name', 'Item'),
    col('unit', 'Unit'),
    col('received', 'Received', 'int'),
    col('spent', 'Spent', 'money'),
    col('used', 'Taken out', 'int'),
    col('lastOut', 'Last taken out', 'date'),
    col('onHand', 'On hand now', 'int'),
  ];
  const rows = list.map((i) => ({
    name: i.name,
    unit: i.unit,
    received: n(ins.find((x) => x.id === i.id)?.qty),
    spent: n(ins.find((x) => x.id === i.id)?.spent),
    used: n(outs.find((x) => x.id === i.id)?.qty),
    lastOut: outs.find((x) => x.id === i.id)?.last ?? null,
    onHand: n(allIns.find((x) => x.id === i.id)?.qty) - n(allOuts.find((x) => x.id === i.id)?.qty),
  }));
  return { title: 'Inventory', columns, rows, totals: totalsOf(columns, rows) };
}

async function expenseReport(db: Db, r: Range): Promise<Report> {
  const [byCat, cats, outs, bought, laundry] = await Promise.all([
    db
      .select({ id: expenses.categoryId, count: sql<number>`count(*)`, amount: sql<number>`sum(${expenses.amount})` })
      .from(expenses)
      .where(and(eq(expenses.status, 'confirmed'), gte(expenses.date, r.from), lte(expenses.date, r.to)))
      .groupBy(expenses.categoryId),
    db.select().from(expenseCategories),
    db
      .select({ category: cashOuts.category, count: sql<number>`count(*)`, amount: sql<number>`sum(${cashOuts.amount})` })
      .from(cashOuts)
      .where(
        and(
          gte(cashOuts.businessDay, r.from),
          lte(cashOuts.businessDay, r.to),
          notInArray(cashOuts.category, ['on_call_commission', 'cash_advance']),
          sql`not exists (select 1 from ${stockIns} where ${stockIns.cashOutId} = ${cashOuts.id})`,
        ),
      )
      .groupBy(cashOuts.category),
    db
      .select({ count: sql<number>`count(*)`, amount: sql<number>`coalesce(sum(${stockIns.qty} * coalesce(${stockIns.unitPrice}, 0)), 0)` })
      .from(stockIns)
      .where(and(eq(stockIns.kind, 'purchase'), gte(stockIns.purchaseDate, r.from), lte(stockIns.purchaseDate, r.to)))
      .get(),
    db
      .select({ breakdownJson: cashOuts.breakdownJson })
      .from(cashOuts)
      .where(and(eq(cashOuts.category, 'laundry'), isNotNull(cashOuts.breakdownJson), gte(cashOuts.businessDay, r.from), lte(cashOuts.businessDay, r.to)))
      .orderBy(asc(cashOuts.businessDay)),
  ]);
  // The Laundry row lists the days paid for (its Laundry Breakdowns), without changing the totals.
  const laundryDays = laundry
    .flatMap((x) => parseLaundryBreakdown(x.breakdownJson) ?? [])
    .map((d) => `${shortDate(d.day)} ${(d.amount / 100).toFixed(2)}`)
    .join(' · ');
  const columns = [col('source', 'Where recorded'), col('category', 'Category'), col('count', 'Entries', 'int'), col('amount', 'Amount', 'money'), col('detail', 'Days paid for')];
  const rows: Row[] = [
    ...byCat.map((x) => ({ source: 'Expenses', category: cats.find((c) => c.id === x.id)?.name ?? x.id, count: n(x.count), amount: n(x.amount) })),
    ...outs.map((x) => ({ source: 'Drawer Cash-out', category: CASH_OUT_LABELS[x.category] ?? x.category, count: n(x.count), amount: n(x.amount), detail: x.category === 'laundry' && laundryDays ? laundryDays : null })),
    ...(n(bought?.count) ? [{ source: 'Inventory', category: 'Inventory purchases', count: n(bought?.count), amount: n(bought?.amount) }] : []),
  ].sort((a, b) => n(b.amount) - n(a.amount));
  return { title: 'Expenses', columns, rows, totals: totalsOf(columns, rows), note: 'Confirmed Expenses only. Payroll, On-call pay and Cash Advances are not included.' };
}

const BUILDERS: Record<ReportName, (db: Db, r: Range) => Promise<Report>> = {
  'daily-sales': dailySales,
  payments: paymentsReport,
  'therapist-sales': therapistSales,
  'therapist-detail': therapistDetail,
  'therapist-changes': therapistChangesReport,
  guests,
  'service-times': serviceTimesReport,
  foc,
  payroll,
  inventory,
  expenses: expenseReport,
};

const query = z
  .object({ from: isoDate, to: isoDate, therapist: z.string().min(1).optional(), guest: z.string().trim().max(80).optional(), method: z.enum(['cash', 'gcash']).optional() })
  .refine((q) => q.from <= q.to, 'The start date must be on or before the end date.')
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, 'Choose at most a year at a time.');

export const reportRoutes = new Hono<AuthedEnv>()
  .use('/reports/*', requireAuth)
  .get('/reports/:name', zValidator('query', query, invalidInput), async (c) => {
    const name = c.req.param('name') as ReportName;
    if (!REPORTS.includes(name)) return fail(c, 404, 'not_found', 'No such report.');
    const role = c.var.user.role;
    const range = c.req.valid('query');
    if (!reportsFor(role).includes(name)) return fail(c, 403, 'forbidden', 'You do not have access to this report.');
    if (!choosesReportDates(role)) {
      const today = businessDayOf(new Date());
      if (range.from !== today || range.to !== today) return fail(c, 403, 'today_only', 'You can see today’s figures only.');
    }
    return c.json({ report: await BUILDERS[name](c.var.db, range), ...range });
  });
