import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { frontDeskDevices, users } from '@spa/db';
import type { AppEnv, AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { forgetDevice, markThisDevice, readDevice } from '../auth/device';
import { requireAuth, requireCapability } from '../auth/middleware';

/** Whether this browser is the Front-desk Device; asked by the login page with no one logged in. */
export const deviceStatusRoutes = new Hono<AppEnv>().get('/device', async (c) => {
  const device = await readDevice(c);
  return c.json({ frontDesk: !!device, label: device?.label ?? null });
});

// Mounted at the API root, so the guards are scoped to these paths.
const guard = [requireAuth, requireCapability('settings.manage')] as const;

export const deviceRoutes = new Hono<AuthedEnv>()
  .use('/front-desk-devices', ...guard)
  .use('/front-desk-devices/*', ...guard)

  .get('/front-desk-devices', async (c) => {
    const [rows, current] = await Promise.all([
      c.var.db
        .select({ id: frontDeskDevices.id, label: frontDeskDevices.label, createdAt: frontDeskDevices.createdAt, lastUsedAt: frontDeskDevices.lastUsedAt, revokedAt: frontDeskDevices.revokedAt, createdBy: users.firstName })
        .from(frontDeskDevices)
        .leftJoin(users, eq(users.id, frontDeskDevices.createdBy))
        .orderBy(desc(frontDeskDevices.createdAt)),
      readDevice(c),
    ]);
    return c.json({ devices: rows.filter((r) => !r.revokedAt).map((r) => ({ ...r, thisDevice: r.id === current?.id })) });
  })

  /** Marks the browser the Super Admin is using right now. */
  .post('/front-desk-devices', zValidator('json', z.object({ label: z.string().trim().min(2).max(60) }), invalidInput), async (c) => {
    if (await readDevice(c)) return fail(c, 409, 'already_marked', 'This device is already the front-desk device.');
    const { label } = c.req.valid('json');
    const id = await markThisDevice(c, label, c.var.user.id);
    await auditInsert(c.var.db, { actorUserId: c.var.user.id, action: 'device.mark', entity: 'front_desk_device', entityId: id, after: { label } });
    return c.json({ id }, 201);
  })

  .delete('/front-desk-devices/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(frontDeskDevices).where(eq(frontDeskDevices.id, c.req.param('id'))).get();
    if (!row || row.revokedAt) return fail(c, 404, 'not_found', 'Device not found.');
    const current = await readDevice(c);
    await db.batch([
      db.update(frontDeskDevices).set({ revokedAt: nowIso() }).where(eq(frontDeskDevices.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'device.remove', entity: 'front_desk_device', entityId: row.id, before: { label: row.label } }),
    ]);
    if (current?.id === row.id) forgetDevice(c);
    return c.json({ ok: true });
  });
