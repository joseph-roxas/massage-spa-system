import { describe, expect, it } from 'vitest';
import { loggedIn } from './helpers';

type Status = { checks: { key: string; status: string }[]; firstSunday: string };

describe('go-live checklist', () => {
  it('is for the Super Admin, and ticks off what is done', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    expect((await desk.get('/go-live/status')).status).toBe(403);

    const before = (await (await admin.get('/go-live/status')).json()) as Status;
    expect(new Date(`${before.firstSunday}T00:00:00Z`).getUTCDay()).toBe(0);
    // Seeded: services with prices and this year's holidays; a receptionist login exists.
    expect(before.checks.find((c) => c.key === 'prices')!.status).toBe('done');
    expect(before.checks.find((c) => c.key === 'desk-login')!.status).toBe('done');

    expect((await admin.send('PUT', '/inventory/opening', { date: before.firstSunday.slice(0, 4) + '-01-01', counts: [{ itemId: 'tissue', qty: 12 }] })).status).toBe(200);
    const after = (await (await admin.get('/go-live/status')).json()) as Status;
    expect(after.checks.find((c) => c.key === 'inventory')!.status).toBe('done');
  });
});
