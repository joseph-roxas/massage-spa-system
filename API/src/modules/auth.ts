import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users } from '@spa/db';
import type { AppEnv, AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDays } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { requireAuth } from '../auth/middleware';
import { DUMMY_HASH, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../auth/password';
import { endSession, startSession } from '../auth/session';

const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(MIN_PASSWORD_LENGTH).max(200);

const signupSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email,
  password,
});

const loginSchema = z.object({ email, password: z.string().min(1).max(200) });

const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });

const STATUS_MESSAGES = {
  pending: 'Your request is waiting for approval.',
  rejected: 'Your request was not approved.',
  disabled: 'This account has been disabled.',
} as const;

const authed = new Hono<AuthedEnv>()
  .use(requireAuth)
  .get('/me', (c) => c.json({ user: c.var.user }))
  .post('/logout', async (c) => {
    // The Receptionist may not leave a Business Day open; the Super Admin may.
    if (c.var.user.role === 'receptionist') {
      const [open] = await openDays(c.var.db);
      if (open) return fail(c, 409, 'day_open', `Close the Business Day of ${open.date} before logging out.`);
    }
    await endSession(c);
    return c.json({ ok: true });
  })
  .post('/change-password', zValidator('json', changePasswordSchema, invalidInput), async (c) => {
    const { currentPassword, newPassword } = c.req.valid('json');
    const db = c.var.db;
    const me = await db.select().from(users).where(eq(users.id, c.var.user.id)).get();
    if (!me || !(await verifyPassword(currentPassword, me.passwordHash))) {
      return fail(c, 400, 'wrong_password', 'Your current password is incorrect.');
    }
    await db.batch([
      db
        .update(users)
        .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
        .where(eq(users.id, me.id)),
      auditInsert(db, {
        actorUserId: me.id,
        action: 'user.password_change',
        entity: 'user',
        entityId: me.id,
      }),
    ]);
    return c.json({ ok: true });
  });

export const authRoutes = new Hono<AppEnv>()
  .post('/signup', zValidator('json', signupSchema, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get();
    if (existing) return fail(c, 409, 'email_taken', 'That email already has an account or request.');

    const id = crypto.randomUUID();
    await db.batch([
      db.insert(users).values({
        id,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        passwordHash: await hashPassword(input.password),
        status: 'pending',
        createdAt: nowIso(),
      }),
      auditInsert(db, {
        actorUserId: null,
        action: 'user.signup',
        entity: 'user',
        entityId: id,
        after: { firstName: input.firstName, lastName: input.lastName, email: input.email },
      }),
    ]);

    // A failed notification must not lose the request: it is on the Pending Users screen either way.
    try {
      await c.var.notifier.userRequested(input);
    } catch (err) {
      console.error('User Request notification failed', err);
    }
    return c.json({ status: 'pending' as const }, 201);
  })
  .post('/login', zValidator('json', loginSchema, invalidInput), async (c) => {
    const { email, password } = c.req.valid('json');
    const user = await c.var.db.select().from(users).where(eq(users.email, email)).get();
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) return fail(c, 401, 'invalid_credentials', 'Email or password is incorrect.');
    if (user.status !== 'active') {
      return fail(c, 403, user.status, STATUS_MESSAGES[user.status]);
    }
    await startSession(c, user.id);
    return c.json({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    });
  })
  .route('/', authed);
