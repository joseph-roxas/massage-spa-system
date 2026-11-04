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
import { salesRoutes } from './modules/sales';
import { dayRoutes } from './modules/days';
import { voucherRoutes } from './modules/vouchers';
import { payrollRoutes } from './modules/payroll';
import { inventoryRoutes } from './modules/inventory';
import { expenseRoutes } from './modules/expenses';
import { reportRoutes } from './modules/reports';
import { goLiveRoutes } from './modules/golive';
import { notifierFor, type Notifier } from './notify/notifier';
import { fail } from './lib/http';

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
    .route('/sales', salesRoutes)
    .route('/', dayRoutes)
    .route('/', voucherRoutes)
    .route('/', payrollRoutes)
    .route('/', inventoryRoutes)
    .route('/', expenseRoutes)
    .route('/', reportRoutes)
    .route('/', goLiveRoutes)
    .notFound((c) => fail(c, 404, 'not_found', 'No such endpoint.'))
    .onError((err, c) => {
      console.error(err);
      return fail(c, 500, 'server_error', 'Something went wrong. Please try again.');
    });
}

export type App = ReturnType<typeof createApp>;
