import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { branding } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { requireAuth, requireCapability } from '../auth/middleware';

const ROW = 1;

const body = z.object({
  businessName: z.string().trim().max(120).nullable(),
  /** Shrunk in the browser, so a small data URL. */
  logo: z
    .string()
    .max(300_000, 'That logo is too large.')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Use a PNG, JPG or WebP image.')
    .nullable(),
});

/** The business's name and logo. Reading is public because the login page shows them. */
export const brandingRoutes = new Hono<AuthedEnv>()
  .get('/branding', async (c) => {
    const row = await c.var.db.select().from(branding).where(eq(branding.id, ROW)).get();
    return c.json({ businessName: row?.businessName ?? null, logo: row?.logo ?? null });
  })
  .put('/branding', requireAuth, requireCapability('settings.manage'), zValidator('json', body, invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const values = { businessName: input.businessName || null, logo: input.logo, updatedAt: nowIso(), updatedBy: c.var.user.id };
    await db.batch([
      db.insert(branding).values({ id: ROW, ...values }).onConflictDoUpdate({ target: branding.id, set: values }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'branding.update', entity: 'branding', entityId: String(ROW), after: { businessName: values.businessName, hasLogo: !!values.logo } }),
    ]);
    return c.json({ ok: true });
  });
