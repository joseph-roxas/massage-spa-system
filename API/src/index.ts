import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { appMeta } from '@spa/db';

export type Env = { DB: D1Database };

const app = new Hono<{ Bindings: Env }>().basePath('/api/v1');

app.get('/health', async (c) => {
  const db = drizzle(c.env.DB);
  const row = await db.select().from(appMeta).where(eq(appMeta.key, 'schema_version')).get();
  return c.json({ ok: true, schemaVersion: row?.value ?? null });
});

export default app;
