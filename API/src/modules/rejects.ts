import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { businessDayOf } from '@spa/domain';
import { REJECT_REASONS, rejects } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor, requireOpenDay } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { requireAuth, requireCapability } from '../auth/middleware';

/** People the shop turned away, recorded at the desk and removable while the day is open. */
export const rejectRoutes = new Hono<AuthedEnv>()
  .use('/rejects', requireAuth, requireCapability('bookings.manage'))
  .use('/rejects/*', requireAuth, requireCapability('bookings.manage'))

  .get('/rejects', async (c) => {
    const rows = await c.var.db.select().from(rejects).where(eq(rejects.businessDay, businessDayOf(new Date()))).orderBy(asc(rejects.createdAt));
    return c.json({ rejects: rows });
  })

  .post('/rejects', zValidator('json', z.object({ reason: z.enum(REJECT_REASONS) }), invalidInput), async (c) => {
    const day = businessDayOf(new Date());
    const blocked = await openDayFor(c, day);
    if (blocked) return blocked;
    const row = { id: crypto.randomUUID(), businessDay: day, reason: c.req.valid('json').reason, createdAt: nowIso(), createdBy: c.var.user.id };
    await c.var.db.insert(rejects).values(row);
    return c.json({ id: row.id }, 201);
  })

  /** A mistake, e.g. the wrong button pressed. */
  .delete('/rejects/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(rejects).where(eq(rejects.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Record not found.');
    const blocked = await requireOpenDay(c, row.businessDay);
    if (blocked) return blocked;
    await db.batch([
      db.delete(rejects).where(eq(rejects.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'reject.delete', entity: 'reject', entityId: row.id, before: row }),
    ]);
    return c.json({ ok: true });
  });
