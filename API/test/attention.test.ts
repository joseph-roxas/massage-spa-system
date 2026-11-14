import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf } from '@spa/domain';
import { loggedIn, PERSON } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Item = { key: string; tone: string; title: string; detail: string | null; link: string };

const inDays = (n: number) => {
  const d = new Date(`${businessDayOf(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM takeout_requests`),
    env.DB.prepare(`DELETE FROM payroll_releases`),
    env.DB.prepare(`DELETE FROM cash_transfers`),
    env.DB.prepare(`DELETE FROM certificates`),
    env.DB.prepare(`UPDATE staff SET active = 0`),
  ]);
});

describe('Needs attention', () => {
  it('gathers what waits on the Super Admin, urgent first, each with where to act', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    expect((await desk.get('/attention')).status).toBe(403);

    const { id: ana } = await json<{ id: string }>(
      await admin.post('/settings/staff', { ...PERSON, firstName: 'Ana', lastName: 'Cruz', displayName: 'Ana', kind: 'therapist', therapistClass: 'lmt', qualification: 'doh', sssNo: '34-1234567-8' }),
    );
    await admin.post(`/settings/staff/${ana}/certificates`, { type: 'doh', expiresOn: inDays(-1) });
    await admin.post(`/settings/staff/${ana}/certificates`, { type: 'nc2', expiresOn: inDays(30) });
    await admin.post(`/settings/staff/${ana}/certificates`, { type: 'nc2', expiresOn: inDays(400) });
    await desk.post('/inventory/takeout-requests', { itemId: 'tissue', qty: 5, level: 'out' });
    await admin.post('/cash/opening', { amount: 100000 });
    await desk.post('/cash/handovers', { amount: 50000, note: 'Rest kept for laundry' });

    const { items } = await json<{ items: Item[] }>(await admin.get('/attention'));
    const keys = items.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['handovers', 'takeout-requests', 'government-ids']));
    expect(items.filter((i) => i.key.startsWith('certificate-')).map((i) => i.title)).toEqual(
      expect.arrayContaining(["Ana's DOH licence has expired", "Ana's NC-II expires in 30 days"]),
    );
    expect(items.find((i) => i.title === "Ana's DOH licence has expired")).toMatchObject({ tone: 'urgent', detail: expect.stringMatching(/Still paid as an LMT/), link: '/settings/staff' });
    expect(items.find((i) => i.key === 'government-ids')!.detail).toBe('Ana: PhilHealth, Pag-IBIG');
    expect(items.find((i) => i.key === 'takeout-requests')).toMatchObject({ tone: 'urgent', link: '/inventory?tab=requests' });
    // Urgent ones come first.
    const firstNormal = items.findIndex((i) => i.tone === 'normal');
    expect(items.slice(firstNormal).every((i) => i.tone === 'normal')).toBe(true);
  });
});
