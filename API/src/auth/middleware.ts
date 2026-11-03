import { createMiddleware } from 'hono/factory';
import { can, type Capability } from '@spa/domain';
import type { AppEnv, AuthedEnv } from '../env';
import { fail } from '../lib/http';
import { readSession } from './session';

/**
 * Cross-site forms can only send simple content types, so requiring JSON on
 * every state-changing request (together with SameSite=Lax cookies) blocks CSRF.
 */
export const requireJsonForWrites = createMiddleware<AppEnv>(async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      return fail(c, 415, 'json_required', 'Requests must be sent as JSON.');
    }
  }
  await next();
});

export const loadSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await readSession(c);
  c.set('user', session?.user ?? null);
  c.set('sessionTokenHash', session?.tokenHash ?? null);
  await next();
});

/** Routes a user holding a temporary password may still reach. */
const PASSWORD_CHANGE_ALLOWED = [
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/change-password',
];

export const requireAuth = createMiddleware<AuthedEnv>(async (c, next) => {
  const user = c.var.user;
  if (!user) return fail(c, 401, 'unauthenticated', 'Please log in.');
  if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.includes(c.req.path)) {
    return fail(c, 403, 'must_change_password', 'Please set a new password first.');
  }
  await next();
});

export function requireCapability(capability: Capability) {
  return createMiddleware<AuthedEnv>(async (c, next) => {
    if (!can(c.var.user.role, capability)) {
      return fail(c, 403, 'forbidden', 'You do not have access to this.');
    }
    await next();
  });
}
