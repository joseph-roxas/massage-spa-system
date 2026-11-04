import { Hono } from 'hono';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { businessDayOf, nextPayWeekStart } from '@spa/domain';
import { caLedger, holidays, servicePrices, services, staff, stockIns, users, vouchers } from '@spa/db';
import type { AuthedEnv } from '../env';
import { requireAuth, requireCapability } from '../auth/middleware';

type Check = { key: string; label: string; status: 'done' | 'todo' | 'optional'; detail: string; link: string };

const count = sql<number>`count(*)`;

/** What still needs doing before the first real Business Day. */
export const goLiveRoutes = new Hono<AuthedEnv>().get('/go-live/status', requireAuth, requireCapability('settings.manage'), async (c) => {
  const db = c.var.db;
  const today = businessDayOf(new Date());
  const year = today.slice(0, 4);
  const [people, desks, svc, priced, hols, imported, openings, counted] = await Promise.all([
    db.select({ kind: staff.kind, isOnCall: staff.isOnCall, hasPin: sql<number>`${staff.pinHash} is not null`, dailyRate: staff.dailyRate }).from(staff).where(eq(staff.active, true)),
    db.select({ n: count }).from(users).where(and(eq(users.role, 'receptionist'), eq(users.status, 'active'))).get(),
    db.select({ n: count }).from(services).where(eq(services.active, true)).get(),
    db.select({ n: sql<number>`count(distinct ${servicePrices.serviceId})` }).from(servicePrices).get(),
    db.select({ n: count }).from(holidays).where(gte(holidays.date, `${year}-01-01`)).get(),
    db.select({ n: count }).from(vouchers).where(and(eq(vouchers.imported, true), isNull(vouchers.redeemedSaleId))).get(),
    db.select({ n: count }).from(caLedger).where(eq(caLedger.entry, 'opening')).get(),
    db.select({ n: count }).from(stockIns).where(eq(stockIns.kind, 'opening')).get(),
  ]);

  const therapists = people.filter((p) => p.kind === 'therapist' && !p.isOnCall);
  const receptionists = people.filter((p) => p.kind === 'receptionist');
  const noPin = people.filter((p) => !Number(p.hasPin)).length;
  const n = (x: { n: number } | undefined) => Number(x?.n ?? 0);
  const firstSunday = nextPayWeekStart(today);

  const checks: Check[] = [
    {
      key: 'staff',
      label: 'Add every therapist and the receptionist',
      status: therapists.length > 0 && receptionists.length > 0 ? 'done' : 'todo',
      detail: `${therapists.length} therapist(s), ${receptionists.length} receptionist(s)`,
      link: '/settings/staff',
    },
    {
      key: 'pins',
      label: 'Give everyone a Clock-in PIN',
      status: people.length > 0 && noPin === 0 ? 'done' : 'todo',
      detail: noPin ? `${noPin} without a PIN` : 'All set',
      link: '/settings/staff',
    },
    {
      key: 'daily-rate',
      label: 'Set the receptionist’s daily rate and deductions',
      status: receptionists.length > 0 && receptionists.every((r) => r.dailyRate) ? 'done' : 'todo',
      detail: receptionists.length ? receptionists.map((r) => (r.dailyRate ? `₱${(r.dailyRate / 100).toFixed(2)}/day` : 'no rate')).join(', ') : 'No receptionist yet',
      link: '/settings/staff',
    },
    {
      key: 'desk-login',
      label: 'Approve the receptionist’s login',
      status: n(desks) > 0 ? 'done' : 'todo',
      detail: n(desks) ? `${n(desks)} receptionist login(s)` : 'She signs up with “Create New User”, then you approve under Users',
      link: '/admin/users',
    },
    {
      key: 'prices',
      label: 'Check services, prices and Happy Hours',
      status: n(svc) > 0 && n(priced) >= n(svc) ? 'done' : 'todo',
      detail: `${n(svc)} services, ${n(priced)} with a price`,
      link: '/settings/services',
    },
    {
      key: 'holidays',
      label: `Check this year’s holidays and which raise commission`,
      status: n(hols) > 0 ? 'done' : 'todo',
      detail: `${n(hols)} holiday(s) from ${year}`,
      link: '/settings/holidays',
    },
    {
      key: 'vouchers',
      label: 'Enter unused paper vouchers',
      status: n(imported) > 0 ? 'done' : 'optional',
      detail: n(imported) ? `${n(imported)} paper voucher(s) entered` : 'Only if guests still hold paper vouchers',
      link: '/vouchers',
    },
    {
      key: 'cash-advances',
      label: 'Enter Cash Advance balances (e.g. the receptionist’s ₱4,000)',
      status: n(openings) > 0 ? 'done' : 'optional',
      detail: n(openings) ? `${n(openings)} opening balance(s)` : 'Only for people who owe money now',
      link: '/payroll',
    },
    {
      key: 'inventory',
      label: 'Count the stock on the shelves',
      status: n(counted) > 0 ? 'done' : 'todo',
      detail: n(counted) ? `${n(counted)} item(s) counted` : 'Inventory → Items & vendors → Opening count',
      link: '/inventory?tab=items',
    },
  ];
  return c.json({ checks, firstSunday, today });
});
