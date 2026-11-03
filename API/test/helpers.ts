import { env } from 'cloudflare:workers';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import type { UserRequestNotice } from '../src/notify/notifier';

export const notices: UserRequestNotice[] = [];

export const app = createApp({
  notifier: () => ({
    async userRequested(n) {
      notices.push(n);
    },
  }),
});

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}${++counter}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

export type Client = {
  cookie: string | null;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  send(method: string, path: string, body?: unknown): Promise<Response>;
};

/** A tiny cookie-keeping client, like a browser tab. */
export function client(): Client {
  const self: Client = {
    cookie: null,
    async get(path) {
      return send('GET', path);
    },
    async post(path, body = {}) {
      return send('POST', path, body);
    },
    async send(method, path, body = method === 'GET' ? undefined : {}) {
      return send(method, path, body);
    },
  };
  async function send(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (self.cookie) headers.cookie = self.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(
      `https://spa.test/api/v1${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0]!;
      self.cookie = /max-age=0/i.test(setCookie) || pair.endsWith('=') ? null : pair;
    }
    return res;
  }
  return self;
}

/** Inserts an active user directly, bypassing sign-up. */
export async function seedUser(opts: {
  role: 'super_admin' | 'receptionist';
  email?: string;
  password?: string;
}): Promise<{ id: string; email: string; password: string }> {
  const id = crypto.randomUUID();
  const email = opts.email ?? uniqueEmail(opts.role);
  const password = opts.password ?? 'correct horse battery';
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, email, password_hash, role, status, created_at)
     VALUES (?, 'Test', 'User', ?, ?, ?, 'active', ?)`,
  )
    .bind(id, email, await hashPassword(password), opts.role, now)
    .run();
  return { id, email, password };
}

export async function loggedIn(role: 'super_admin' | 'receptionist'): Promise<Client & { id: string }> {
  const u = await seedUser({ role });
  const c = client();
  const res = await c.post('/auth/login', { email: u.email, password: u.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return Object.assign(c, { id: u.id });
}
