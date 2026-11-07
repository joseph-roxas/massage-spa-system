import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, lastCompletedPayWeek, manilaInstant, payWeekOf } from '@spa/domain';
import { client, loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const daysAgo = (n: number) => {
  const d = new Date(`${businessDayOf(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const shift = (day: string) => ({ clockIn: manilaInstant(day, '14:00').toISOString(), clockOut: manilaInstant(day, '23:00').toISOString() });

async function therapist(admin: Client, name: string) {
  const { id } = await json<{ id: string }>(
    await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Cruz', displayName: name, kind: 'therapist', therapistClass: 'regular', qualification: 'experience' }),
  );
  return id;
}

describe('Turned away and the Today strip', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare(`DELETE FROM rejects`), env.DB.prepare(`UPDATE business_days SET closed_at = '2026-01-01T00:00:00.000Z' WHERE closed_at IS NULL`)]);
    await env.DB.prepare(`DELETE FROM business_days WHERE date = ?`).bind(businessDayOf(new Date())).run();
  });

  it('counts people turned away, and a mistake can be removed', async () => {
    const desk = await loggedIn('receptionist');
    const { id } = await json<{ id: string }>(await desk.post('/rejects', { reason: 'too_late' }));
    await desk.post('/rejects', { reason: 'refused_safety' });
    expect((await desk.post('/rejects', { reason: 'bored' })).status).toBe(400);
    type Board = { today: { sales: number; guests: number; turnedAway: number } };
    expect((await json<Board>(await desk.get('/front-desk'))).today.turnedAway).toBe(2);
    expect((await desk.send('DELETE', `/rejects/${id}`)).status).toBe(200);
    expect((await json<Board>(await desk.get('/front-desk'))).today).toMatchObject({ turnedAway: 1, guests: 0, sales: 0 });

    const today = businessDayOf(new Date());
    const report = await json<{ report: { rows: { date: string; rejects: number }[] } }>(await desk.get(`/reports/daily-sales?from=${today}&to=${today}`));
    expect(report.report.rows.find((r) => r.date === today)?.rejects).toBe(1);
  });
});

describe('Business name and logo', () => {
  it('anyone can read them; only the Super Admin can change them', async () => {
    const desk = await loggedIn('receptionist');
    const admin = await loggedIn('super_admin');
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    expect((await desk.send('PUT', '/branding', { businessName: 'Nope', logo: null })).status).toBe(403);
    expect((await admin.send('PUT', '/branding', { businessName: 'Bad', logo: 'javascript:alert(1)' })).status).toBe(400);
    expect((await admin.send('PUT', '/branding', { businessName: 'Nuat Thai Lawaan', logo })).status).toBe(200);
    expect(await json(await client().get('/branding'))).toEqual({ businessName: 'Nuat Thai Lawaan', logo });
    const svg = (text: string) => `data:image/svg+xml;base64,${btoa(text)}`;
    const drawing = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="5"/></svg>');
    expect((await admin.send('PUT', '/branding', { businessName: 'Nuat Thai Lawaan', logo: drawing })).status).toBe(200);
    expect(await json(await client().get('/branding'))).toEqual({ businessName: 'Nuat Thai Lawaan', logo: drawing });
    expect((await admin.send('PUT', '/branding', { businessName: 'Bad', logo: svg('<svg onload="alert(1)"></svg>') })).status).toBe(400);
    expect((await admin.send('PUT', '/branding', { businessName: 'Bad', logo: svg('<html></html>') })).status).toBe(400);
    expect((await admin.send('PUT', '/branding', { businessName: 'Nuat Thai', logo: null })).status).toBe(200);
    expect(await json(await client().get('/branding'))).toEqual({ businessName: 'Nuat Thai', logo: null });
  });
});

describe('Vouchers Used Before Go-live', () => {
  type Row = { id: string; serial: string; status: string };
  const list = async (c: Client, q: string) => (await json<{ vouchers: Row[] }>(await c.get(`/vouchers?q=${q}`))).vouchers;

  it('marks a range, keeps the count right, refuses redemption and can be undone', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const { services } = await json<{ services: { id: string; voucherEligible: boolean; voucherPrefix: string | null }[] }>(await admin.get('/catalogue/services'));
    const service = services.find((s) => s.voucherEligible && s.voucherPrefix)!;
    const compact = service.voucherPrefix!.replace('-', '');
    const count = (numbers: string, state: string) => admin.post('/vouchers/import', { serviceId: service.id, numbers, state });

    expect((await count('9001-9003', 'unused')).status).toBe(201);
    expect((await desk.post('/vouchers/import', { serviceId: service.id, numbers: '9004', state: 'used_before_golive' })).status).toBe(403);

    // The range covers two already counted as unused and one not yet in the system.
    expect((await count('9002-9004', 'used_before_golive')).status).toBe(201);
    const statuses = (await list(admin, `${compact}900`)).map((v) => v.status);
    expect(statuses).toEqual(['unused', 'used_before_golive', 'used_before_golive', 'used_before_golive']);

    // Cards sold through the system or at the shop are not swept up.
    expect((await count('9005', 'in_shop')).status).toBe(201);
    expect((await count('9005', 'used_before_golive')).status).toBe(409);

    const rows = await list(admin, `${compact}900`);
    expect((await desk.post(`/vouchers/${rows[0]!.id}/mark-used`)).status).toBe(403);
    expect((await admin.post(`/vouchers/${rows[0]!.id}/mark-used`, { usedOn: '2026-03-01' })).status).toBe(200);
    expect((await admin.post(`/vouchers/${rows[4]!.id}/mark-used`)).status).toBe(409);
    expect((await admin.post(`/vouchers/${rows[1]!.id}/unmark-used`, { reason: 'Guest still has it' })).status).toBe(200);
    expect((await list(admin, `${compact}9002`))[0]!.status).toBe('unused');

    const status = await json<{ checks: { key: string; detail: string }[] }>(await admin.get('/go-live/status'));
    expect(status.checks.find((c) => c.key === 'vouchers')!.detail).toMatch(/\d+ sold, \d+ used, \d+ still out/);
  });
});

describe('Time record override', () => {
  it('locks what the Super Admin settled, and anything under an approved Payroll', async () => {
    const owner = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await therapist(owner, 'Locky');
    const day = daysAgo(21);
    const { id } = await json<{ id: string }>(await desk.post('/dtr', { staffId: t, ...shift(day), reason: 'Missed punch' }));

    // The desk's entry waits for review, and the desk can still fix it.
    expect((await desk.send('PATCH', `/dtr/${id}`, { ...shift(day), reason: 'Second look' })).status).toBe(200);

    // The Super Admin overrides it: Reviewed at once, and closed to the desk.
    expect((await owner.send('PATCH', `/dtr/${id}`, { ...shift(day), clockOut: manilaInstant(day, '22:00').toISOString(), reason: 'Actually left at 10' })).status).toBe(200);
    const review = await json<{ entries: { id: string }[] }>(await owner.get('/dtr/review'));
    expect(review.entries.some((e) => e.id === id)).toBe(false);
    const locked = await desk.send('PATCH', `/dtr/${id}`, { ...shift(day), reason: 'Putting it back' });
    expect(locked.status).toBe(409);
    expect((await json<{ error: string }>(locked)).error).toBe('dtr_locked');
    expect((await desk.send('DELETE', `/dtr/${id}`, { reason: 'Removing it' })).status).toBe(409);
    const seen = await json<{ entries: { id: string; canEdit: boolean; lockedAs: string | null }[] }>(await desk.get(`/dtr?day=${day}`));
    expect(seen.entries.find((e) => e.id === id)).toMatchObject({ canEdit: false, lockedAs: 'corrected' });

    // An approved Payroll closes the week to everyone, the Super Admin too.
    await env.DB.prepare(
      `INSERT INTO payrolls (id, week_start, staff_id, kind, status, gross, gov_sss, gov_phic, gov_pagibig, ca_deduction, net, breakdown_json, generated_at) VALUES (?, ?, ?, 'therapist', 'approved', 0, 0, 0, 0, 0, 0, '{}', ?)`,
    )
      .bind(crypto.randomUUID(), payWeekOf(day, 'therapist').start, t, new Date().toISOString())
      .run();
    const fixed = await owner.send('PATCH', `/dtr/${id}`, { ...shift(day), reason: 'One more change' });
    expect(fixed.status).toBe(409);
    expect((await json<{ error: string }>(fixed)).error).toBe('payroll_locked');
    expect((await owner.send('DELETE', `/dtr/${id}`, { reason: 'Removing it' })).status).toBe(409);
    expect((await owner.post('/dtr', { staffId: t, clockIn: manilaInstant(day, '08:00').toISOString(), clockOut: manilaInstant(day, '09:00').toISOString(), reason: 'Morning block' })).status).toBe(409);
  });
});

describe('Cash Handover overdue', () => {
  it('reaches the Super Admin as urgent after 24 hours', async () => {
    const owner = await loggedIn('super_admin');
    const today = businessDayOf(new Date());
    const week = payWeekOf(today, 'therapist');
    const lastWeek = lastCompletedPayWeek(today, 'therapist');
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM cash_transfers`),
      env.DB.prepare(`DELETE FROM cash_outs WHERE category = 'laundry'`),
      env.DB.prepare(`DELETE FROM payrolls WHERE week_start = ?`).bind(lastWeek.start),
    ]);
    await owner.post('/cash/opening', { amount: 500000 });
    const then = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const t = await therapist(owner, 'Handy');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payrolls (id, week_start, staff_id, kind, status, gross, gov_sss, gov_phic, gov_pagibig, ca_deduction, net, breakdown_json, generated_at, released_at) VALUES (?, ?, ?, 'therapist', 'released', 0, 0, 0, 0, 0, 0, '{}', ?, ?)`,
      ).bind(crypto.randomUUID(), lastWeek.start, t, then, then),
      env.DB.prepare(`INSERT INTO cash_outs (id, business_day, category, source, amount, purpose, created_at) VALUES (?, ?, 'laundry', 'sales', 100, 'Laundry', ?)`).bind(crypto.randomUUID(), week.start, then),
    ]);
    const summary = await json<{ reminder: string; dueSince: string | null }>(await owner.get('/cash/summary'));
    expect(summary).toMatchObject({ reminder: 'hand_over', dueSince: then });
    const { items } = await json<{ items: { key: string; tone: string }[] }>(await owner.get('/attention'));
    expect(items.find((i) => i.key === 'handover-overdue')).toMatchObject({ tone: 'urgent' });
  });
});
