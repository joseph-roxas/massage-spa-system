import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { client, loggedIn, notices, uniqueEmail } from './helpers';

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('User Request → approval → login', () => {
  it('walks a new receptionist from sign-up to an active session', async () => {
    const email = uniqueEmail('new');
    const visitor = client();

    const signup = await visitor.post('/auth/signup', {
      firstName: 'Ana',
      lastName: 'Cruz',
      email: email.toUpperCase(),
      password: 'front-desk-123',
    });
    expect(signup.status).toBe(201);
    expect(notices.at(-1)).toMatchObject({ firstName: 'Ana', lastName: 'Cruz', email });

    const pendingLogin = await visitor.post('/auth/login', { email, password: 'front-desk-123' });
    expect(pendingLogin.status).toBe(403);
    expect(await json(pendingLogin)).toMatchObject({ error: 'pending' });

    const admin = await loggedIn('super_admin');
    const pending = await json<{ users: { id: string; email: string }[] }>(
      await admin.get('/users?status=pending'),
    );
    const request = pending.users.find((u) => u.email === email);
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty('passwordHash');

    expect((await admin.post(`/users/${request!.id}/approve`, { role: 'receptionist' })).status).toBe(200);

    const login = await visitor.post('/auth/login', { email, password: 'front-desk-123' });
    expect(login.status).toBe(200);
    const me = await json<{ user: { role: string } }>(await visitor.get('/auth/me'));
    expect(me.user.role).toBe('receptionist');

    const audit = await env.DB.prepare(
      `SELECT action FROM audit_log WHERE entity_id = ? ORDER BY id`,
    )
      .bind(request!.id)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(['user.signup', 'user.approve']);
  });

  it('refuses a duplicate email', async () => {
    const email = uniqueEmail();
    const body = { firstName: 'A', lastName: 'B', email, password: 'longenough' };
    expect((await client().post('/auth/signup', body)).status).toBe(201);
    expect((await client().post('/auth/signup', body)).status).toBe(409);
  });

  it('rejects short passwords and bad emails', async () => {
    const res = await client().post('/auth/signup', {
      firstName: 'A',
      lastName: 'B',
      email: 'not-an-email',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'invalid_input', message: 'Please check: Email, Password.' });
  });

  it('blocks a rejected request from logging in', async () => {
    const email = uniqueEmail();
    const visitor = client();
    await visitor.post('/auth/signup', { firstName: 'R', lastName: 'J', email, password: 'longenough' });
    const admin = await loggedIn('super_admin');
    const { users } = await json<{ users: { id: string; email: string }[] }>(
      await admin.get('/users?status=pending'),
    );
    const id = users.find((u) => u.email === email)!.id;
    expect((await admin.post(`/users/${id}/reject`, { reason: 'Not staff' })).status).toBe(200);
    expect(await json(await visitor.post('/auth/login', { email, password: 'longenough' }))).toMatchObject({
      error: 'rejected',
    });
  });
});

describe('login and sessions', () => {
  it('gives the same answer for an unknown email and a wrong password', async () => {
    const { email } = await loggedIn('receptionist').then(async (c) => ({
      email: (await json<{ user: { email: string } }>(await c.get('/auth/me'))).user.email,
    }));
    const wrong = await client().post('/auth/login', { email, password: 'nope-nope' });
    const unknown = await client().post('/auth/login', { email: uniqueEmail(), password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await json(wrong)).toEqual(await json(unknown));
  });

  it('sets a hardened session cookie', async () => {
    const c = client();
    const u = await loggedIn('receptionist');
    const me = await json<{ user: { email: string } }>(await u.get('/auth/me'));
    const res = await c.post('/auth/login', { email: me.user.email, password: 'correct horse battery' });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-spa_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('logs out and forgets the session', async () => {
    const c = await loggedIn('receptionist');
    const cookie = c.cookie;
    expect((await c.post('/auth/logout')).status).toBe(200);
    c.cookie = cookie; // replaying the old cookie must not work
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('treats an expired session as logged out', async () => {
    const c = await loggedIn('receptionist');
    await env.DB.prepare(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?`)
      .bind(c.id)
      .run();
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('requires JSON for writes (CSRF guard)', async () => {
    const { app } = await import('./helpers');
    const res = await app.request(
      'https://spa.test/api/v1/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' },
      env,
    );
    expect(res.status).toBe(415);
  });
});

describe('permissions', () => {
  it('keeps receptionists out of user management', async () => {
    const r = await loggedIn('receptionist');
    expect((await r.get('/users')).status).toBe(403);
    expect((await r.post(`/users/${r.id}/approve`, { role: 'super_admin' })).status).toBe(403);
  });

  it('requires login for user management', async () => {
    expect((await client().get('/users')).status).toBe(401);
  });

  it('stops the Super Admin from disabling themself', async () => {
    const admin = await loggedIn('super_admin');
    expect((await admin.post(`/users/${admin.id}/disable`)).status).toBe(409);
  });

  it('disabling a user ends their sessions', async () => {
    const r = await loggedIn('receptionist');
    const admin = await loggedIn('super_admin');
    expect((await admin.post(`/users/${r.id}/disable`)).status).toBe(200);
    expect((await r.get('/auth/me')).status).toBe(401);
    expect((await admin.post(`/users/${r.id}/enable`)).status).toBe(200);
  });
});

describe('password reset and change', () => {
  it('forces a new password after a Super Admin reset', async () => {
    const r = await loggedIn('receptionist');
    const email = (await json<{ user: { email: string } }>(await r.get('/auth/me'))).user.email;
    const admin = await loggedIn('super_admin');

    expect((await admin.post(`/users/${r.id}/reset-password`, { temporaryPassword: 'temp-pass-1' })).status).toBe(200);
    expect((await r.get('/auth/me')).status).toBe(401); // old session ended

    const c = client();
    expect((await c.post('/auth/login', { email, password: 'temp-pass-1' })).status).toBe(200);
    expect(await json(await c.get('/users'))).toMatchObject({ error: 'must_change_password' });

    expect(
      (await c.post('/auth/change-password', { currentPassword: 'wrong', newPassword: 'mine-now-123' })).status,
    ).toBe(400);
    expect(
      (await c.post('/auth/change-password', { currentPassword: 'temp-pass-1', newPassword: 'mine-now-123' })).status,
    ).toBe(200);
    const me = await json<{ user: { mustChangePassword: boolean } }>(await c.get('/auth/me'));
    expect(me.user.mustChangePassword).toBe(false);

    expect((await client().post('/auth/login', { email, password: 'mine-now-123' })).status).toBe(200);
  });
});
