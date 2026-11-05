import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { businessDayOf, manilaInstant } from '@spa/domain';
import { client, loggedIn, PERSON, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let n = 0;
async function addStaff(
  admin: Client,
  body: Record<string, unknown> = { kind: 'therapist', therapistClass: 'regular' },
  pin = '1234',
): Promise<string> {
  const name = `P${++n}`;
  const { id } = await json<{ id: string }>(
    await admin.post('/settings/staff', { ...PERSON, firstName: name, lastName: 'Test', displayName: name, ...body }),
  );
  if (pin) await admin.post(`/settings/staff/${id}/pin`, { pin });
  return id;
}

type Rotation = { next: string | null; rotation: { staffId: string; position: number; status: string }[] };

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('Clock-in Screen', () => {
  it('clocks in and out with the right PIN', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const id = await addStaff(admin);

    const inRes = await desk.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' });
    expect(inRes.status).toBe(200);
    expect((await desk.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' })).status).toBe(409);

    const { staff } = await json<{ staff: { id: string; clockedInAt: string | null; hasPin: boolean }[] }>(await desk.get('/clock/staff'));
    expect(staff.find((s) => s.id === id)).toMatchObject({ hasPin: true, clockedInAt: expect.any(String) });
    expect(staff.find((s) => s.id === id)).not.toHaveProperty('pinHash');

    expect((await desk.post('/clock/punch', { staffId: id, pin: '1234', action: 'out' })).status).toBe(200);
    expect((await desk.post('/clock/punch', { staffId: id, pin: '1234', action: 'out' })).status).toBe(409);

    const { entries } = await json<{ entries: { staffId: string; clockOut: string | null; source: string }[] }>(await desk.get('/dtr'));
    expect(entries.filter((e) => e.staffId === id)).toEqual([expect.objectContaining({ source: 'pin', clockOut: expect.any(String) })]);
  });

  it('locks the PIN after five wrong tries', async () => {
    const admin = await loggedIn('super_admin');
    const id = await addStaff(admin);
    for (let i = 4; i >= 1; i--) {
      const res = await admin.post('/clock/punch', { staffId: id, pin: '9999', action: 'in' });
      expect(res.status).toBe(401);
      expect(await json(res)).toMatchObject({ message: expect.stringContaining(`${i} tries left`) });
    }
    expect((await admin.post('/clock/punch', { staffId: id, pin: '9999', action: 'in' })).status).toBe(423);
    // Even the right PIN is refused while locked.
    expect((await admin.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' })).status).toBe(423);
  });

  it('refuses staff without a PIN and needs a logged-in device', async () => {
    const admin = await loggedIn('super_admin');
    const id = await addStaff(admin, undefined, '');
    expect((await admin.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' })).status).toBe(409);
    expect((await client().post('/clock/punch', { staffId: id, pin: '1234', action: 'in' })).status).toBe(401);
  });
});

describe('Rotation', () => {
  it('follows arrival order and drops therapists who clock out', async () => {
    const admin = await loggedIn('super_admin');
    // Clear today's on-duty therapists from other tests so the order is ours alone.
    await env.DB.prepare(`UPDATE dtr SET clock_out = ? WHERE clock_out IS NULL`).bind(new Date().toISOString()).run();
    const [a, b, desk] = [await addStaff(admin), await addStaff(admin), await addStaff(admin, { kind: 'receptionist', dailyRate: 69200 })];

    // b arrives before a, and the receptionist is never in the Rotation.
    await admin.post('/dtr', { staffId: b, clockIn: hoursAgo(0.5), clockOut: null, reason: 'Forgot to punch' });
    await admin.post('/clock/punch', { staffId: a, pin: '1234', action: 'in' });
    await admin.post('/clock/punch', { staffId: desk, pin: '1234', action: 'in' });

    let r = await json<Rotation>(await admin.get('/rotation'));
    expect(r.rotation.map((x) => x.staffId)).toEqual([b, a]);
    expect(r.next).toBe(b);

    await admin.post('/clock/punch', { staffId: b, pin: '1234', action: 'out' });
    r = await json<Rotation>(await admin.get('/rotation'));
    expect(r.rotation.map((x) => x.staffId)).toEqual([a]);
  });

  it('is for the front desk only', async () => {
    expect((await client().get('/rotation')).status).toBe(401);
  });

  it('does not put its login check on unrelated paths', async () => {
    expect((await client().get('/no-such-thing')).status).toBe(404);
    expect((await client().get('/health')).status).toBe(200);
  });
});

describe('DTR corrections', () => {
  it('lets the receptionist fix a therapist’s times, with a reason', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const id = await addStaff(admin);
    const clockIn = hoursAgo(5);

    expect((await desk.post('/dtr', { staffId: id, clockIn, clockOut: hoursAgo(1), reason: '' })).status).toBe(400);
    const created = await desk.post('/dtr', { staffId: id, clockIn, clockOut: hoursAgo(1), reason: 'Phone was dead' });
    expect(created.status).toBe(201);
    const { id: entryId } = await json<{ id: string }>(created);

    // Overlaps and backwards times are refused.
    expect((await desk.post('/dtr', { staffId: id, clockIn: hoursAgo(3), clockOut: hoursAgo(2), reason: 'Again' })).status).toBe(400);
    expect((await desk.send('PATCH', `/dtr/${entryId}`, { clockIn, clockOut: hoursAgo(6), reason: 'Oops' })).status).toBe(400);
    expect((await desk.send('PATCH', `/dtr/${entryId}`, { clockIn, clockOut: new Date(Date.now() + 3_600_000).toISOString(), reason: 'Future' })).status).toBe(400);

    expect((await desk.send('PATCH', `/dtr/${entryId}`, { clockIn, clockOut: hoursAgo(0.5), reason: 'Left later' })).status).toBe(200);

    const audit = await env.DB.prepare(`SELECT action, reason FROM audit_log WHERE entity = 'dtr' AND entity_id = ? ORDER BY id`)
      .bind(entryId)
      .all<{ action: string; reason: string }>();
    expect(audit.results).toEqual([
      { action: 'dtr.add', reason: 'Phone was dead' },
      { action: 'dtr.correct', reason: 'Left later' },
    ]);

    expect((await desk.send('DELETE', `/dtr/${entryId}`, { reason: 'Wrong person' })).status).toBe(200);
  });

  it('keeps the receptionist from editing receptionist records', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const recId = await addStaff(admin, { kind: 'receptionist', dailyRate: 69200 });
    const body = { staffId: recId, clockIn: hoursAgo(9), clockOut: hoursAgo(8), reason: 'Adjusting own time' };
    expect((await desk.post('/dtr', body)).status).toBe(403);
    expect((await admin.post('/dtr', body)).status).toBe(201);

    const day = businessDayOf(new Date(body.clockIn));
    const { entries } = await json<{ entries: { staffId: string; canEdit: boolean }[] }>(await desk.get(`/dtr?day=${day}`));
    expect(entries.find((e) => e.staffId === recId)?.canEdit).toBe(false);
  });

  it('files after-midnight work under the day that opened', async () => {
    const admin = await loggedIn('super_admin');
    const id = await addStaff(admin);
    const clockIn = manilaInstant('2026-10-31', '14:00').toISOString();
    const clockOut = manilaInstant('2026-11-01', '01:30').toISOString();
    expect((await admin.post('/dtr', { staffId: id, clockIn, clockOut, reason: 'Late night' })).status).toBe(201);
    const { entries } = await json<{ entries: { staffId: string }[] }>(await admin.get('/dtr?day=2026-10-31'));
    expect(entries.some((e) => e.staffId === id)).toBe(true);
  });
});

describe('Front-desk Device', () => {
  it('lets the marked PC open the Clock-in Screen with no one logged in, until it is removed', async () => {
    const owner = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const id = await addStaff(owner);
    const stranger = client();
    expect(await json(await stranger.get('/device'))).toEqual({ frontDesk: false, label: null });
    expect((await stranger.get('/clock/staff')).status).toBe(401);

    expect((await desk.post('/front-desk-devices', { label: 'Reception PC' })).status).toBe(403);
    // The owner marks the PC they are using; that browser then keeps only the device cookie, like after logging out.
    const pc = await loggedIn('super_admin');
    expect((await pc.post('/front-desk-devices', { label: 'Reception PC' })).status).toBe(201);
    expect(pc.cookie).toMatch(/spa_device=/);
    expect(await json(await pc.get('/device'))).toEqual({ frontDesk: true, label: 'Reception PC' });
    expect((await pc.get('/auth/me')).status).toBe(401);

    const staffRes = await json<{ today: { day: string; holiday: unknown } }>(await pc.get('/clock/staff'));
    expect(staffRes.today.day).toBe(businessDayOf(new Date()));
    expect((await pc.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' })).status).toBe(200);
    // Nothing else opens for it.
    expect((await pc.get('/front-desk')).status).toBe(401);
    expect((await pc.get('/dtr')).status).toBe(401);

    const { devices } = await json<{ devices: { id: string; label: string }[] }>(await owner.get('/front-desk-devices'));
    const marked = devices.find((d) => d.label === 'Reception PC')!;
    expect((await owner.send('DELETE', `/front-desk-devices/${marked.id}`)).status).toBe(200);
    expect((await pc.get('/clock/staff')).status).toBe(401);
    await owner.post('/clock/punch', { staffId: id, pin: '1234', action: 'out' });
  });

  it('greets a staff member on their birthday, on the first clock-in of the day only', async () => {
    const owner = await loggedIn('super_admin');
    const today = businessDayOf(new Date());
    const id = await addStaff(owner, { kind: 'therapist', therapistClass: 'regular', birthdate: `1995-${today.slice(5)}` });
    const first = await json<{ birthday: boolean; firstName: string }>(await owner.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' }));
    expect(first.birthday).toBe(true);
    expect((await json<{ birthdays: string[] }>(await owner.get('/front-desk'))).birthdays).toContain(first.firstName);
    await owner.post('/clock/punch', { staffId: id, pin: '1234', action: 'out' });
    expect((await json<{ birthday: boolean }>(await owner.post('/clock/punch', { staffId: id, pin: '1234', action: 'in' }))).birthday).toBe(false);
    await owner.post('/clock/punch', { staffId: id, pin: '1234', action: 'out' });
  });
});

describe('DTR batch entry and DTR Review', () => {
  const daysAgo = (n: number) => {
    const d = new Date(`${businessDayOf(new Date())}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const shift = (day: string, from = '14:00', to = '23:00') => ({ clockIn: manilaInstant(day, from).toISOString(), clockOut: manilaInstant(day, to).toISOString() });
  type Review = { entries: { id: string; staffId: string; businessDay: string; correctionReason: string; reviewedAt: string | null }[] };
  type Attention = { items: { key: string; title: string; link: string }[] };

  it('adds several missing entries for one person, all or nothing', async () => {
    const owner = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await addStaff(owner);
    const r = await addStaff(owner, { kind: 'receptionist', dailyRate: 69200 });
    expect((await desk.post('/dtr/batch', { staffId: r, reason: 'Forgot to clock in', rows: [shift(daysAgo(12))] })).status).toBe(403);

    const bad = await desk.post('/dtr/batch', {
      staffId: t,
      reason: 'Forgot to clock in',
      rows: [shift(daysAgo(12)), shift(daysAgo(12), '20:00', '23:30'), shift(daysAgo(11))],
    });
    expect(bad.status).toBe(400);
    const body = await json<{ problems: { index: number; message: string }[] }>(bad);
    expect(body.problems.map((p) => p.index)).toEqual([0, 1]);
    expect((await json<{ entries: unknown[] }>(await desk.get(`/dtr?day=${daysAgo(11)}`))).entries.filter((e) => (e as { staffId: string }).staffId === t)).toHaveLength(0);

    const ok = await desk.post('/dtr/batch', {
      staffId: t,
      reason: 'Forgot to clock in',
      rows: [shift(daysAgo(12)), { ...shift(daysAgo(11)), reason: 'Phone was dead' }],
    });
    expect(ok.status).toBe(201);
    const day11 = await json<{ entries: { staffId: string; correctionReason: string; source: string }[] }>(await desk.get(`/dtr?day=${daysAgo(11)}`));
    expect(day11.entries.find((e) => e.staffId === t)).toMatchObject({ source: 'manual', correctionReason: 'Phone was dead' });
  });

  it('lists entries to review whatever their date, until the Super Admin ticks them', async () => {
    const owner = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const t = await addStaff(owner);
    await desk.post('/dtr/batch', { staffId: t, reason: 'Paper DTR', rows: [shift(daysAgo(20)), shift(daysAgo(19))] });
    // A clock-in never closed on an earlier day is listed too.
    await env.DB.prepare(`INSERT INTO dtr (id, staff_id, business_day, clock_in, source, created_at) VALUES (?, ?, ?, ?, 'pin', ?)`)
      .bind(crypto.randomUUID(), t, daysAgo(18), shift(daysAgo(18)).clockIn, new Date().toISOString())
      .run();

    expect((await desk.get('/dtr/review')).status).toBe(403);
    const mine = async () => (await json<Review>(await owner.get('/dtr/review'))).entries.filter((e) => e.staffId === t);
    expect((await mine()).map((e) => e.businessDay)).toEqual([daysAgo(18), daysAgo(19), daysAgo(20)]);
    expect((await json<Attention>(await owner.get('/attention'))).items.find((i) => i.key === 'dtr-review')).toMatchObject({ link: '/dtr?tab=review' });

    const [open, d19, d20] = await mine();
    expect((await owner.post('/dtr/review', { ids: [d19!.id, d20!.id] })).status).toBe(200);
    expect((await mine()).map((e) => e.id)).toEqual([open!.id]);
    expect((await json<Review>(await owner.get('/dtr/review?all=1'))).entries.filter((e) => e.staffId === t)).toHaveLength(3);

    // Changed again: back on the list.
    const fixed = shift(daysAgo(19), '14:05', '23:00');
    expect((await owner.send('PATCH', `/dtr/${d19!.id}`, { ...fixed, reason: 'Arrived 14:05' })).status).toBe(200);
    expect((await mine()).map((e) => e.id).sort()).toEqual([open!.id, d19!.id].sort());
    await owner.send('PATCH', `/dtr/${open!.id}`, { ...shift(daysAgo(18)), reason: 'Closing old entry' });
  });
});
