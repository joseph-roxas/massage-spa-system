import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { businessDayOf, manilaInstant } from '@spa/domain';
import { client, loggedIn, type Client } from './helpers';

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
    await admin.post('/settings/staff', { firstName: name, lastName: 'Test', displayName: name, ...body }),
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
