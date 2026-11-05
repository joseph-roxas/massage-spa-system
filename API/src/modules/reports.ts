import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, gte, isNotNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  businessDayOf,
  can,
  DAILY_REPORTS,
  FOC_LABELS,
  focGroup,
  REPORTS,
  serviceTimes,
  totalsOf,
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
  saleAddons,
  sales,
  services,
  staff,
  stockIns,
  stockOuts,
  voucherPayments,
  voucherSales,
} from '@spa/db';
import type { AuthedEnv } from '../env';
import { fail, invalidInput } from '../lib/http';
import { isoDate } from '../lib/validation';
import { requireAuth } from '../auth/middleware';

type Db = DrizzleD1Database;
type Range = { from: string; to: string };

const CASH_OUT_LABELS: Record<string, string> = { relief_pay: 'Relief pay', petty_cash: 'Petty cash', laundry: 'Laundry', supplies: 'Supplies', food: 'Food / rice', transport: 'Transport', other: 'Other' };

const col = (key: string, label: string, type: Column['type'] = 'text'): Column => ({ key, label, type });
const n = (v: unknown) => Number(v ?? 0);

/** Adds `values` into the row for `key`, creating it with `base` first. */
function into(map: Map<string, Row>, key: string, base: Row, values: Row) {
  const row = map.get(key) ?? { ...base };
  for (const [k, v] of Object.entries(values)) row[k] = (Number(row[k]) || 0) + (Number(v) || 0);
  map.set(key, row);
}

async function dailySales(db: Db, r: Range): Promise<Report> {
  const [s, pay, vs, vpay, outs] = await Promise.all([
    db
      .select({
        day: sales.businessDay,
        guests: sql<number>`count(*)`,
        regular: sql<number>`sum(${sales.regularPrice})`,
        discounts: sql<number>`sum(${sales.discountAmount})`,
        services: sql<number>`sum(${sales.serviceAmount})`,
        addons: sql<number>`sum(${sales.addonsTotal})`,
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
  ]);
  const columns = [
    col('date', 'Business Day', 'date'),
    col('guests', 'Guests', 'int'),
    col('regular', 'Regular Price', 'money'),
    col('discounts', 'Discounts & FOCs', 'money'),
    col('services', 'Services paid', 'money'),
    col('addons', 'Add-ons', 'money'),
    col('vouchers', 'Vouchers sold', 'money'),
    col('cash', 'Cash in', 'money'),
    col('gcash', 'GCash in', 'money'),
    col('cashOuts', 'Cash-outs', 'money'),
    col('commission', 'Commission', 'money'),
  ];
  const days = new Map<string, Row>();
  const base = (day: string): Row => ({ date: day });
  for (const x of s) into(days, x.day, base(x.day), { guests: x.guests, regular: x.regular, discounts: x.discounts, services: x.services, addons: x.addons, commission: x.commission });
  for (const x of [...pay, ...vpay]) into(days, x.day, base(x.day), { [x.method]: x.amount });
  for (const x of vs) into(days, x.day, base(x.day), { vouchers: x.total });
  for (const x of outs) into(days, x.day, base(x.day), { cashOuts: x.amount });
  const rows = [...days.values()].map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? (c.type === 'date' ? null : 0)]))).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    title: 'Daily sales',
    columns,
    rows,
    totals: totalsOf(columns, rows),
    note: 'Services paid = Regular Price − Discounts & FOCs. Cash and GCash include Voucher sales.',
  };
}

async function therapistSales(db: Db, r: Range): Promise<Report> {
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
    .sort((a, b) => b.commission - a.commission);
  return { title: 'Sales per therapist', columns, rows, totals: totalsOf(columns, rows), note: 'Requested = served a Guest who asked for them. Commission is on the Regular Price, FOCs included.' };
}

async function guests(db: Db, r: Range): Promise<Report> {
  const rows0 = await db
    .select({ day: bookings.businessDay, kind: bookings.kind, status: bookings.status, count: sql<number>`count(*)` })
    .from(bookings)
    .where(and(gte(bookings.businessDay, r.from), lte(bookings.businessDay, r.to)))
    .groupBy(bookings.businessDay, bookings.kind, bookings.status);
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

async function foc(db: Db, r: Range): Promise<Report> {
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

async function addons(db: Db, r: Range): Promise<Report> {
  const rows0 = await db
    .select({ name: saleAddons.name, count: sql<number>`count(*)`, revenue: sql<number>`sum(${saleAddons.price})` })
    .from(saleAddons)
    .innerJoin(sales, eq(sales.id, saleAddons.saleId))
    .where(and(eq(sales.status, 'paid'), gte(sales.businessDay, r.from), lte(sales.businessDay, r.to)))
    .groupBy(saleAddons.name);
  const columns = [col('name', 'Add-on'), col('count', 'Sold', 'int'), col('revenue', 'Revenue (shop only)', 'money')];
  const rows = rows0.map((x) => ({ name: x.name, count: n(x.count), revenue: n(x.revenue) }));
  return { title: 'Add-ons', columns, rows, totals: totalsOf(columns, rows) };
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
  const [byCat, cats, outs, bought] = await Promise.all([
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
  ]);
  const columns = [col('source', 'Where recorded'), col('category', 'Category'), col('count', 'Entries', 'int'), col('amount', 'Amount', 'money')];
  const rows: Row[] = [
    ...byCat.map((x) => ({ source: 'Expenses', category: cats.find((c) => c.id === x.id)?.name ?? x.id, count: n(x.count), amount: n(x.amount) })),
    ...outs.map((x) => ({ source: 'Drawer Cash-out', category: CASH_OUT_LABELS[x.category] ?? x.category, count: n(x.count), amount: n(x.amount) })),
    ...(n(bought?.count) ? [{ source: 'Inventory', category: 'Inventory purchases', count: n(bought?.count), amount: n(bought?.amount) }] : []),
  ].sort((a, b) => n(b.amount) - n(a.amount));
  return { title: 'Expenses', columns, rows, totals: totalsOf(columns, rows), note: 'Confirmed Expenses only. Payroll, On-call pay and Cash Advances are not included.' };
}

const BUILDERS: Record<ReportName, (db: Db, r: Range) => Promise<Report>> = {
  'daily-sales': dailySales,
  'therapist-sales': therapistSales,
  guests,
  'service-times': serviceTimesReport,
  foc,
  addons,
  payroll,
  inventory,
  expenses: expenseReport,
};

const query = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, 'The start date must be on or before the end date.')
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, 'Choose at most a year at a time.');

export const reportRoutes = new Hono<AuthedEnv>()
  .use('/reports/*', requireAuth)
  .get('/reports/:name', zValidator('query', query, invalidInput), async (c) => {
    const name = c.req.param('name') as ReportName;
    if (!REPORTS.includes(name)) return fail(c, 404, 'not_found', 'No such report.');
    const role = c.var.user.role;
    const range = c.req.valid('query');
    if (!can(role, 'reports.all')) {
      if (!can(role, 'reports.daily') || !DAILY_REPORTS.includes(name)) return fail(c, 403, 'forbidden', 'You do not have access to this report.');
      const today = businessDayOf(new Date());
      if (range.from !== today || range.to !== today) return fail(c, 403, 'today_only', 'You can see today’s figures only.');
    }
    return c.json({ report: await BUILDERS[name](c.var.db, range), ...range });
  });
