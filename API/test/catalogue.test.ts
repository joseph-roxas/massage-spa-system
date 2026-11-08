import { describe, expect, it } from 'vitest';
import { toManila } from '@spa/domain';
import { loggedIn, PERSON } from './helpers';

type Service = {
  id: string;
  code: string;
  name: string;
  currentPrice: number | null;
  upcomingPrices: { id: string; regularPrice: number; effectiveFrom: string }[];
  isFootType: boolean;
  voucherEligible: boolean;
};

const today = toManila(new Date()).date;
const daysFromToday = (n: number) => toManila(new Date(Date.now() + n * 86_400_000)).date;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('seeded catalogue', () => {
  it('has the full price list with current prices', async () => {
    const r = await loggedIn('receptionist');
    const { services } = await json<{ services: Service[] }>(await r.get('/catalogue/services'));
    const byCode = Object.fromEntries(services.map((s) => [s.code, s]));
    expect(services).toHaveLength(20);
    expect(byCode.FM60?.currentPrice).toBe(45000);
    expect(byCode.FM30?.currentPrice).toBe(25000);
    expect(byCode.VEN?.currentPrice).toBe(75000);
    expect(byCode.C2?.currentPrice).toBe(100000);
    expect(byCode.C6?.isFootType).toBe(true);
    expect(services.filter((s) => s.voucherEligible).map((s) => s.code).sort()).toEqual(['ARO', 'SWE', 'THAI', 'VEN']);
  });

  it('sets ₱50 aside on Aromatherapy, Hot Oil and Hot Stone only', async () => {
    const admin = await loggedIn('super_admin');
    const { services } = await json<{ services: { code: string; currentSetAside: number }[] }>(await admin.get('/catalogue/services'));
    expect(services.filter((s) => s.currentSetAside > 0).map((s) => [s.code, s.currentSetAside])).toEqual([['ARO', 5000], ['HOIL', 5000], ['HSTN', 5000]]);
  });

  it('has Happy Hours, 8 rooms and the commission rates', async () => {
    const admin = await loggedIn('super_admin');
    const { promos } = await json<{ promos: Record<string, unknown>[] }>(await admin.get('/catalogue/promos'));
    expect(promos[0]).toMatchObject({
      name: 'Happy Hours',
      serviceId: 'swedish-60',
      percentBp: 1000,
      startTime: '14:00',
      endTime: '18:00',
      validTo: '2026-11-30',
    });
    const { rooms } = await json<{ rooms: { id: number; isFlex: boolean }[] }>(await admin.get('/catalogue/rooms'));
    expect(rooms).toHaveLength(8);
    expect(rooms.filter((r) => r.isFlex).map((r) => r.id)).toEqual([8]);
    const { commissionRates } = await json<{ commissionRates: { therapistClass: string; normalBp: number; holidayBp: number }[] }>(
      await admin.get('/settings/commission-rates'),
    );
    expect(commissionRates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ therapistClass: 'regular', normalBp: 3000, holidayBp: 5000 }),
        expect.objectContaining({ therapistClass: 'lmt', normalBp: 4000, holidayBp: 6000 }),
      ]),
    );
  });
});

describe('price changes', () => {
  it('schedules a future price without touching today’s', async () => {
    const admin = await loggedIn('super_admin');
    const effectiveFrom = daysFromToday(10);
    const res = await admin.post('/catalogue/services/thai-60/prices', { regularPrice: 55000, effectiveFrom });
    expect(res.status).toBe(201);

    const { services } = await json<{ services: Service[] }>(await admin.get('/catalogue/services'));
    const thai = services.find((s) => s.id === 'thai-60')!;
    expect(thai.currentPrice).toBe(50000);
    expect(thai.upcomingPrices).toEqual([expect.objectContaining({ regularPrice: 55000, effectiveFrom })]);

    expect((await admin.post('/catalogue/services/thai-60/prices', { regularPrice: 56000, effectiveFrom })).status).toBe(409);

    const del = await admin.send('DELETE', `/catalogue/services/thai-60/prices/${thai.upcomingPrices[0]!.id}`);
    expect(del.status).toBe(200);
  });

  it('refuses back-dated prices', async () => {
    const admin = await loggedIn('super_admin');
    const res = await admin.post('/catalogue/services/thai-60/prices', {
      regularPrice: 1,
      effectiveFrom: daysFromToday(-1),
    });
    expect(res.status).toBe(400);
  });

  it('applies a price effective today immediately', async () => {
    const admin = await loggedIn('super_admin');
    expect((await admin.post('/catalogue/services/back-30/prices', { regularPrice: 27000, effectiveFrom: today })).status).toBe(201);
    const { services } = await json<{ services: Service[] }>(await admin.get('/catalogue/services'));
    expect(services.find((s) => s.id === 'back-30')!.currentPrice).toBe(27000);
  });

  it('keeps receptionists read-only', async () => {
    const r = await loggedIn('receptionist');
    expect((await r.post('/catalogue/services/thai-60/prices', { regularPrice: 1, effectiveFrom: daysFromToday(5) })).status).toBe(403);
    expect((await r.send('PATCH', '/catalogue/services/thai-60', { name: 'X' })).status).toBe(403);
    expect((await r.get('/settings/staff')).status).toBe(403);
  });
});

describe('services, promos and holidays', () => {
  it('adds a new service with its first price and rejects a duplicate code', async () => {
    const admin = await loggedIn('super_admin');
    const body = { code: 'hs30', name: 'Head & Shoulder', durationMin: 30, kind: 'single', regularPrice: 20000, effectiveFrom: today };
    expect((await admin.post('/catalogue/services', body)).status).toBe(201);
    expect((await admin.post('/catalogue/services', body)).status).toBe(409);
    const { services } = await json<{ services: Service[] }>(await admin.get('/catalogue/services'));
    expect(services.find((s) => s.code === 'HS30')?.currentPrice).toBe(20000);
  });

  it('validates promo windows', async () => {
    const admin = await loggedIn('super_admin');
    const base = { name: 'Late Night', serviceId: 'thai-60', percentBp: 500, validFrom: '2026-12-01', validTo: '2026-12-31', active: true };
    expect((await admin.post('/catalogue/promos', { ...base, startTime: '22:00', endTime: '21:00' })).status).toBe(400);
    expect((await admin.post('/catalogue/promos', { ...base, startTime: '21:00', endTime: '23:00' })).status).toBe(201);
    expect((await admin.post('/catalogue/promos', { ...base, serviceId: 'nope', startTime: '21:00', endTime: '23:00' })).status).toBe(400);
  });

  it('adds, edits and removes holidays', async () => {
    const admin = await loggedIn('super_admin');
    const body = { name: 'New Year’s Day', type: 'regular', raisesCommission: true };
    expect((await admin.send('PUT', '/catalogue/holidays/2027-01-01', body)).status).toBe(200);
    expect((await admin.send('PUT', '/catalogue/holidays/2027-01-01', { ...body, raisesCommission: false })).status).toBe(200);
    const { holidays } = await json<{ holidays: { date: string; raisesCommission: boolean }[] }>(await admin.get('/catalogue/holidays?year=2027'));
    expect(holidays).toEqual([expect.objectContaining({ date: '2027-01-01', raisesCommission: false })]);
    expect((await admin.send('PUT', '/catalogue/holidays/2027-02-30', body)).status).toBe(400);
    expect((await admin.send('DELETE', '/catalogue/holidays/2027-01-01')).status).toBe(200);
  });
});

describe('staff', () => {
  type StaffRow = { id: string; displayName: string; govSss: number; govPhic: number; govPagibig: number; hasPin: boolean; pinHash?: string };

  it('creates a therapist with the default deductions and sets a PIN', async () => {
    const admin = await loggedIn('super_admin');
    const res = await admin.post('/settings/staff', { ...PERSON,
      firstName: 'Liza',
      lastName: 'Reyes',
      displayName: 'Liza',
      kind: 'therapist',
      therapistClass: 'lmt',
      qualification: 'doh',
      sssNo: '34-1234567-8',
    });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    expect((await admin.post(`/settings/staff/${id}/pin`, { pin: '12a4' })).status).toBe(400);
    expect((await admin.post(`/settings/staff/${id}/pin`, { pin: '0420' })).status).toBe(200);

    const { staff } = await json<{ staff: StaffRow[] }>(await admin.get('/settings/staff'));
    const liza = staff.find((s) => s.id === id)!;
    expect(liza).toMatchObject({ govSss: 10000, govPhic: 6250, govPagibig: 4000, hasPin: true });
    expect(liza.pinHash).toBeUndefined();
  });

  it('gives on-call therapists no deductions and receptionists their own bracket', async () => {
    const admin = await loggedIn('super_admin');
    const onCall = await json<{ id: string }>(
      await admin.post('/settings/staff', { ...PERSON, firstName: 'Jun', lastName: 'Dela Cruz', displayName: 'Jun', kind: 'therapist', therapistClass: 'regular', isOnCall: true }),
    );
    const desk = await json<{ id: string }>(
      await admin.post('/settings/staff', { ...PERSON, firstName: 'Maria', lastName: 'Santos', displayName: 'Maria', kind: 'receptionist', dailyRate: 69200 }),
    );
    const { staff } = await json<{ staff: StaffRow[] }>(await admin.get('/settings/staff'));
    expect(staff.find((s) => s.id === onCall.id)).toMatchObject({ govSss: 0, govPhic: 0, govPagibig: 0 });
    expect(staff.find((s) => s.id === desk.id)).toMatchObject({ govSss: 21250, govPhic: 10563, govPagibig: 5000 });
  });

  it('enforces the staff rules', async () => {
    const admin = await loggedIn('super_admin');
    const base = { firstName: 'A', lastName: 'B', displayName: 'AB' };
    expect((await admin.post('/settings/staff', { ...PERSON, ...base, kind: 'therapist' })).status).toBe(400);
    expect((await admin.post('/settings/staff', { ...PERSON, ...base, kind: 'receptionist' })).status).toBe(400);
    expect((await admin.post('/settings/staff', { ...PERSON, ...base, kind: 'receptionist', dailyRate: 1, isOnCall: true })).status).toBe(400);
    // Personal fields are required for new staff.
    expect((await admin.post('/settings/staff', { ...base, kind: 'therapist', therapistClass: 'regular' })).status).toBe(400);
    // Only a DOH-licensed therapist can be an LMT.
    expect((await admin.post('/settings/staff', { ...PERSON, ...base, kind: 'therapist', therapistClass: 'lmt', qualification: 'nc2' })).status).toBe(400);
    const { id } = await json<{ id: string }>(
      await admin.post('/settings/staff', { ...PERSON, ...base, kind: 'therapist', therapistClass: 'regular', qualification: 'nc2' }),
    );
    expect((await admin.send('PATCH', `/settings/staff/${id}`, { therapistClass: 'lmt' })).status).toBe(400);
    expect((await admin.send('PATCH', `/settings/staff/${id}`, { therapistClass: 'lmt', qualification: 'doh' })).status).toBe(200);
  });

  it('keeps each therapist\'s Certificates, Super Admin only', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const { id } = await json<{ id: string }>(
      await admin.post('/settings/staff', { ...PERSON, firstName: 'Ana', lastName: 'Cruz', displayName: 'Ana C', kind: 'therapist', therapistClass: 'lmt', qualification: 'doh' }),
    );
    const doh = { type: 'doh', number: 'DOH-123', issuedOn: '2025-01-10', expiresOn: '2028-01-10' };
    expect((await desk.post(`/settings/staff/${id}/certificates`, doh)).status).toBe(403);
    expect((await admin.post(`/settings/staff/${id}/certificates`, { ...doh, expiresOn: '2024-01-01' })).status).toBe(400);
    const { id: cert } = await json<{ id: string }>(await admin.post(`/settings/staff/${id}/certificates`, doh));
    await admin.post(`/settings/staff/${id}/certificates`, { type: 'nc2', expiresOn: '2027-06-30' });

    type Row = { id: string; certificates: { id: string; type: string; expiresOn: string }[] };
    const mine = async () => (await json<{ staff: Row[] }>(await admin.get('/settings/staff'))).staff.find((s) => s.id === id)!;
    expect((await mine()).certificates.map((x) => x.type)).toEqual(['nc2', 'doh']);
    expect((await admin.send('PATCH', `/settings/certificates/${cert}`, { expiresOn: '2029-01-10' })).status).toBe(200);
    expect((await admin.send('DELETE', `/settings/certificates/${cert}`)).status).toBe(200);
    expect((await mine()).certificates).toHaveLength(1);
  });
});

describe('commission rates and pay rules', () => {
  it('adds a future commission rate', async () => {
    const admin = await loggedIn('super_admin');
    const body = { therapistClass: 'regular', normalBp: 3200, holidayBp: 5200, effectiveFrom: daysFromToday(30) };
    expect((await admin.post('/settings/commission-rates', body)).status).toBe(201);
    expect((await admin.post('/settings/commission-rates', body)).status).toBe(409);
  });

  it('validates each pay rule against its own shape', async () => {
    const admin = await loggedIn('super_admin');
    const { payRules } = await json<{ payRules: Record<string, unknown> }>(await admin.get('/settings/pay-rules'));
    expect(payRules.receptionist_shift).toEqual({ start: '14:00', end: '23:00', mealBreakMin: 60 });
    expect(payRules.receptionist_rest_weekday).toBe(0);

    expect((await admin.send('PUT', '/settings/pay-rules/receptionist_shift', { value: { start: '15:00', end: '23:00', mealBreakMin: 60 } })).status).toBe(200);
    expect((await admin.send('PUT', '/settings/pay-rules/receptionist_shift', { value: { start: '23:00', end: '14:00', mealBreakMin: 60 } })).status).toBe(400);
    expect((await admin.send('PUT', '/settings/pay-rules/receptionist_rest_weekday', { value: 9 })).status).toBe(400);
    expect((await admin.send('PUT', '/settings/pay-rules/nope', { value: 1 })).status).toBe(404);
  });
});
