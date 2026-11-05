import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, isNull } from 'drizzle-orm';
import { frontDeskDevices } from '@spa/db';
import type { AppEnv, AuthedEnv } from '../env';
import { fail } from '../lib/http';
import { nowIso } from '../lib/time';
import { newToken, sha256Hex } from './session';

const COOKIE = 'spa_device';
/** Works for logged-in routes and for the Clock-in Screen alike. */
type Ctx = Context<AppEnv> | Context<AuthedEnv>;
/** Browsers keep a cookie at most about 400 days; every use renews it. */
const DEVICE_TTL_SECONDS = 400 * 24 * 60 * 60;

function setDeviceCookie(c: Ctx, token: string) {
  setCookie(c, COOKIE, token, { prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: DEVICE_TTL_SECONDS });
}

/** Marks this browser as a Front-desk Device and returns its record id. */
export async function markThisDevice(c: Ctx, label: string, userId: string) {
  const token = newToken();
  const id = crypto.randomUUID();
  await c.var.db.insert(frontDeskDevices).values({ id, label, tokenHash: await sha256Hex(token), createdAt: nowIso(), createdBy: userId });
  setDeviceCookie(c, token);
  return id;
}

/** The Front-desk Device this browser is, if it is one and still marked; renews its cookie. */
export async function readDevice(c: Ctx) {
  const token = getCookie(c, COOKIE, 'host');
  if (!token) return null;
  const row = await c.var.db
    .select()
    .from(frontDeskDevices)
    .where(and(eq(frontDeskDevices.tokenHash, await sha256Hex(token)), isNull(frontDeskDevices.revokedAt)))
    .get();
  if (!row) return null;
  const today = nowIso().slice(0, 10);
  if (row.lastUsedAt?.slice(0, 10) !== today) {
    await c.var.db.update(frontDeskDevices).set({ lastUsedAt: nowIso() }).where(eq(frontDeskDevices.id, row.id));
    setDeviceCookie(c, token);
  }
  return row;
}

export function forgetDevice(c: Ctx) {
  deleteCookie(c, COOKIE, { prefix: 'host', path: '/', secure: true });
}

/** The Clock-in Screen: a logged-in user, or the marked Front-desk Device with no one logged in. */
export const requireSessionOrDevice = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.user && !c.var.user.mustChangePassword) return next();
  if (await readDevice(c)) return next();
  return fail(c, 401, 'unauthenticated', 'Please log in.');
});
