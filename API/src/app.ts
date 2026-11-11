import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { appMeta } from '@spa/db';
import type { AppEnv, Env } from './env';
import { loadSession, requireJsonForWrites } from './auth/middleware';
import { authRoutes } from './modules/auth';
import { userRoutes } from './modules/users';
import { catalogueRoutes } from './modules/catalogue';
import { staffRoutes } from './modules/staff';
import { attendanceRoutes } from './modules/attendance';
import { bookingRoutes } from './modules/bookings';
import { serviceChangeRoutes } from './modules/service-changes';
import { catchUpRoutes } from './modules/catch-up';
import { onCallRoutes } from './modules/on-call';
import { salesRoutes } from './modules/sales';
import { dayRoutes } from './modules/days';
import { voucherRoutes } from './modules/vouchers';
import { payrollRoutes } from './modules/payroll';
import { payrollTotalsRoutes } from './modules/payrollTotals';
import { inventoryRoutes } from './modules/inventory';
import { expenseRoutes } from './modules/expenses';
import { reportRoutes } from './modules/reports';
import { goLiveRoutes } from './modules/golive';
import { cashRoutes } from './modules/cash';
import { financeRoutes } from './modules/finance';
import { attentionRoutes } from './modules/attention';
import { guestRoutes } from './modules/guests';
import { deviceRoutes, deviceStatusRoutes } from './modules/devices';
import { reliefRoutes } from './modules/relief';
import { rejectRoutes } from './modules/rejects';
import { brandingRoutes } from './modules/branding';
import { backfillRoutes } from './modules/backfill';
import { dashboardRoutes } from './modules/dashboard';
import { notifierFor, type Notifier } from './notify/notifier';
import { fail } from './lib/http';
import { tidyGuestNamesOnce } from './lib/guest-names';

export type AppDeps = {
  /** Overridable so tests can capture notifications. */
  notifier?: (env: Env) => Notifier;
};

export function createApp(deps: AppDeps = {}) {
  const makeNotifier = deps.notifier ?? notifierFor;

  return new Hono<AppEnv>()
    .basePath('/api/v1')
    .use(async (c, next) => {
      c.set('db', drizzle(c.env.DB));
      c.set('notifier', makeNotifier(c.env));
      // Once after migration 0035: capitalize Guest names saved before names were capitalized on entry.
      await tidyGuestNamesOnce(c.var.db).catch((err: unknown) => console.error('guest name tidy', err));
      await next();
    })
    .use(requireJsonForWrites, loadSession)
    .get('/health', async (c) => {
      const row = await c.var.db.select().from(appMeta).where(eq(appMeta.key, 'schema_version')).get();
      return c.json({ ok: true, schemaVersion: row?.value ?? null });
    })
    .route('/auth', authRoutes)
    .route('/users', userRoutes)
    .route('/catalogue', catalogueRoutes)
    .route('/settings', staffRoutes)
    .route('/', attendanceRoutes)
    .route('/', bookingRoutes)
    .route('/', serviceChangeRoutes)
    .route('/', catchUpRoutes)
    .route('/', onCallRoutes)
    .route('/sales', salesRoutes)
    .route('/', dayRoutes)
    .route('/', voucherRoutes)
    .route('/', payrollRoutes)
    .route('/', payrollTotalsRoutes)
    .route('/', inventoryRoutes)
    .route('/', expenseRoutes)
    .route('/', reportRoutes)
    .route('/', goLiveRoutes)
    .route('/', cashRoutes)
    .route('/', financeRoutes)
    .route('/', attentionRoutes)
    .route('/', dashboardRoutes)
    .route('/', guestRoutes)
    .route('/', deviceStatusRoutes)
    .route('/', deviceRoutes)
    .route('/', reliefRoutes)
    .route('/', rejectRoutes)
    .route('/', brandingRoutes)
    .route('/', backfillRoutes)
    .notFound((c) => fail(c, 404, 'not_found', 'No such endpoint.'))
    .onError((err, c) => {
      console.error(err);
      return fail(c, 500, 'server_error', 'Something went wrong. Please try again.');
    });
}

export type App = ReturnType<typeof createApp>;
