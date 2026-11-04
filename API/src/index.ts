import { drizzle } from 'drizzle-orm/d1';
import { createApp } from './app';
import type { Env } from './env';
import { monthlyJobs } from './modules/expenses';

const app = createApp();

export default {
  fetch: app.fetch,
  /** Daily: drafts the month's recurring Expenses and last month's Royalty once it has ended. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(monthlyJobs(drizzle(env.DB)).then((r) => console.log('monthly jobs', r)));
  },
} satisfies ExportedHandler<Env>;
