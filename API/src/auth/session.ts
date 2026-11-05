import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, gt } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { sessions, users } from '@spa/db';
import type { AppEnv, AuthedEnv, SessionUser } from '../env';
import { nowIso } from '../lib/time';

const COOKIE = 'spa_session';
/** Long enough for a late closing shift; short enough that a forgotten login expires overnight. */
export const SESSION_TTL_SECONDS = 16 * 60 * 60;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = newToken();
  const now = new Date();
  await c.var.db.insert(sessions).values({
    tokenHash: await sha256Hex(token),
    userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
  });
  setCookie(c, COOKIE, token, {
    prefix: 'host',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function readSession(
  c: Context<AppEnv>,
): Promise<{ user: SessionUser; tokenHash: string } | null> {
  const token = getCookie(c, COOKIE, 'host');
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await c.var.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, nowIso())))
    .get();
  const u = row?.user;
  if (!u || u.status !== 'active' || !u.role) return null;
  return {
    tokenHash,
    user: {
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      role: u.role,
      mustChangePassword: u.mustChangePassword,
    },
  };
}

export async function endSession(c: Context<AuthedEnv>): Promise<void> {
  if (c.var.sessionTokenHash) {
    await c.var.db.delete(sessions).where(eq(sessions.tokenHash, c.var.sessionTokenHash));
  }
  deleteCookie(c, COOKIE, { prefix: 'host', path: '/', secure: true });
}

/** Signs a user out everywhere, e.g. after a password reset or disable. */
export function endAllSessions(db: DrizzleD1Database, userId: string) {
  return db.delete(sessions).where(eq(sessions.userId, userId));
}
