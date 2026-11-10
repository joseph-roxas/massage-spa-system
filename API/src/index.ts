import { drizzle } from 'drizzle-orm/d1';
import { createApp } from './app';
import type { Env } from './env';
import { monthlyJobs } from './modules/expenses';
import { clockOutForgotten } from './lib/auto-clock-out';

const app = createApp();

export default {
  fetch: app.fetch,
  /**
   * 01:00 Manila: drafts the month's recurring Expenses and last month's Royalty once it has ended.
   * 06:00 Manila: Auto Clock-out for anyone left clocked in (it also runs lazily on the Front Desk).
   */
  async scheduled(event, env, ctx) {
    const db = drizzle(env.DB);
    if (event.cron === '0 22 * * *') ctx.waitUntil(clockOutForgotten(db).then((n) => console.log('auto clock-out', n)));
    else ctx.waitUntil(monthlyJobs(db).then((r) => console.log('monthly jobs', r)));
  },
} satisfies ExportedHandler<Env>;
