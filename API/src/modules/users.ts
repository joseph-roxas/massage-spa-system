import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { USER_ROLES, USER_STATUSES, users } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { requireAuth, requireCapability } from '../auth/middleware';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password';
import { endAllSessions } from '../auth/session';

/** Every column except the password hash. */
const publicColumns = {
  id: users.id,
  firstName: users.firstName,
  lastName: users.lastName,
  email: users.email,
  role: users.role,
  status: users.status,
  mustChangePassword: users.mustChangePassword,
  createdAt: users.createdAt,
  decidedBy: users.decidedBy,
  decidedAt: users.decidedAt,
};

type UserRow = typeof users.$inferSelect;

async function findUser(c: Context<AuthedEnv>): Promise<UserRow | undefined> {
  return c.var.db.select().from(users).where(eq(users.id, c.req.param('id')!)).get();
}

function snapshot(u: UserRow) {
  return { role: u.role, status: u.status };
}

export const userRoutes = new Hono<AuthedEnv>()
  .use(requireAuth, requireCapability('users.manage'))
  .get('/', zValidator('query', z.object({ status: z.enum(USER_STATUSES).optional() }), invalidInput), async (c) => {
    const { status } = c.req.valid('query');
    const rows = await c.var.db
      .select(publicColumns)
      .from(users)
      .where(status ? eq(users.status, status) : undefined)
      .orderBy(asc(users.createdAt));
    return c.json({ users: rows });
  })
  .post('/:id/approve', zValidator('json', z.object({ role: z.enum(USER_ROLES) }), invalidInput), async (c) => {
    const user = await findUser(c);
    if (!user) return fail(c, 404, 'not_found', 'User not found.');
    if (user.status !== 'pending') return fail(c, 409, 'not_pending', 'Only pending requests can be approved.');
    const { role } = c.req.valid('json');
    const db = c.var.db;
    const decided = { status: 'active' as const, role, decidedBy: c.var.user.id, decidedAt: nowIso() };
    await db.batch([
      db.update(users).set(decided).where(eq(users.id, user.id)),
      auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'user.approve',
        entity: 'user',
        entityId: user.id,
        before: snapshot(user),
        after: { role, status: 'active' },
      }),
    ]);
    return c.json({ ok: true });
  })
  .post('/:id/reject', zValidator('json', z.object({ reason: z.string().trim().max(500).optional() }), invalidInput), async (c) => {
    const user = await findUser(c);
    if (!user) return fail(c, 404, 'not_found', 'User not found.');
    if (user.status !== 'pending') return fail(c, 409, 'not_pending', 'Only pending requests can be rejected.');
    const db = c.var.db;
    await db.batch([
      db
        .update(users)
        .set({ status: 'rejected', decidedBy: c.var.user.id, decidedAt: nowIso() })
        .where(eq(users.id, user.id)),
      auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'user.reject',
        entity: 'user',
        entityId: user.id,
        before: snapshot(user),
        after: { status: 'rejected' },
        reason: c.req.valid('json').reason,
      }),
    ]);
    return c.json({ ok: true });
  })
  .post('/:id/disable', async (c) => {
    const user = await findUser(c);
    if (!user) return fail(c, 404, 'not_found', 'User not found.');
    if (user.id === c.var.user.id) return fail(c, 409, 'self', 'You cannot disable your own account.');
    if (user.status !== 'active') return fail(c, 409, 'not_active', 'Only active users can be disabled.');
    const db = c.var.db;
    await db.batch([
      db.update(users).set({ status: 'disabled' }).where(eq(users.id, user.id)),
      endAllSessions(db, user.id),
      auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'user.disable',
        entity: 'user',
        entityId: user.id,
        before: snapshot(user),
        after: { status: 'disabled' },
      }),
    ]);
    return c.json({ ok: true });
  })
  .post('/:id/enable', async (c) => {
    const user = await findUser(c);
    if (!user) return fail(c, 404, 'not_found', 'User not found.');
    if (user.status !== 'disabled') return fail(c, 409, 'not_disabled', 'Only disabled users can be enabled.');
    const db = c.var.db;
    await db.batch([
      db.update(users).set({ status: 'active' }).where(eq(users.id, user.id)),
      auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'user.enable',
        entity: 'user',
        entityId: user.id,
        before: snapshot(user),
        after: { status: 'active' },
      }),
    ]);
    return c.json({ ok: true });
  })
  .post(
    '/:id/reset-password',
    zValidator('json', z.object({ temporaryPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200) }), invalidInput),
    async (c) => {
      const user = await findUser(c);
      if (!user) return fail(c, 404, 'not_found', 'User not found.');
      if (user.id === c.var.user.id) {
        return fail(c, 409, 'self', 'Use Change Password for your own account.');
      }
      const db = c.var.db;
      await db.batch([
        db
          .update(users)
          .set({
            passwordHash: await hashPassword(c.req.valid('json').temporaryPassword),
            mustChangePassword: true,
          })
          .where(eq(users.id, user.id)),
        endAllSessions(db, user.id),
        auditInsert(db, {
          actorUserId: c.var.user.id,
          action: 'user.password_reset',
          entity: 'user',
          entityId: user.id,
        }),
      ]);
      return c.json({ ok: true });
    },
  );
