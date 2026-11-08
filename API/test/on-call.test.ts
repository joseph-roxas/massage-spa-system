import { describe, expect, it } from 'vitest';
import { can } from '@spa/domain';
import { loggedIn } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const body = (firstName: string) => ({ firstName, lastName: 'Cruz', pin: '4321' });

describe('adding an On-call Therapist from the desk', () => {
  it('lets them clock in and join the Rotation at once, on the regular rate', async () => {
    const desk = await loggedIn('receptionist');
    const res = await desk.post('/on-call-therapists', body('Oncall'));
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    expect((await desk.post('/clock/punch', { staffId: id, pin: '4321', action: 'in' })).status).toBe(200);
    const board = await json<{ rotation: { staffId: string; therapistClass: string; isOnCall: boolean }[] }>(await desk.get('/front-desk'));
    expect(board.rotation.find((r) => r.staffId === id)).toMatchObject({ therapistClass: 'regular', isOnCall: true });
  });

  it('refuses a name already on the Clock-in Screen and a bad PIN', async () => {
    const desk = await loggedIn('receptionist');
    expect((await desk.post('/on-call-therapists', body('Twice'))).status).toBe(201);
    expect((await desk.post('/on-call-therapists', body('twice'))).status).toBe(409);
    expect((await desk.post('/on-call-therapists', { ...body('Other'), pin: '12' })).status).toBe(400);
  });

  it('saves first name and surname capitalized, on the Staff form too', async () => {
    const desk = await loggedIn('receptionist');
    const admin = await loggedIn('super_admin');
    const { id } = await json<{ id: string }>(await desk.post('/on-call-therapists', { firstName: 'JUANA', lastName: 'dela cruz', pin: '1234' }));
    const created = await admin.post('/settings/staff', { firstName: 'mARIA', lastName: 'TORRES', displayName: 'MARIA T', gender: 'female', birthdate: '1995-05-01', hireDate: '2026-01-05', kind: 'receptionist', dailyRate: 69200 });
    const staffId = (await json<{ id: string }>(created)).id;
    expect((await admin.send('PATCH', `/settings/staff/${staffId}`, { lastName: 'SANTOS-REYES' })).status).toBe(200);
    const { staff } = await json<{ staff: { id: string; firstName: string; lastName: string; displayName: string }[] }>(await admin.get('/settings/staff'));
    expect(staff.find((s) => s.id === id)).toMatchObject({ firstName: 'Juana', lastName: 'Dela Cruz', displayName: 'Juana' });
    // Shown as stays exactly as typed.
    expect(staff.find((s) => s.id === staffId)).toMatchObject({ firstName: 'Maria', lastName: 'Santos-Reyes', displayName: 'MARIA T' });
  });

  it('cannot make someone an LMT', async () => {
    const desk = await loggedIn('receptionist');
    const res = await desk.post('/on-call-therapists', { ...body('Licensed'), therapistClass: 'lmt', qualification: 'doh' });
    const { id } = await json<{ id: string }>(res);
    const admin = await loggedIn('super_admin');
    const { staff } = await json<{ staff: { id: string; therapistClass: string; govSss: number }[] }>(await admin.get('/settings/staff'));
    expect(staff.find((s) => s.id === id)).toMatchObject({ therapistClass: 'regular', govSss: 0 });
  });

  it('is for the Receptionist and Super Admin, not the Reliever Login', () => {
    expect(can('receptionist', 'staff.add_on_call')).toBe(true);
    expect(can('super_admin', 'staff.add_on_call')).toBe(true);
    expect(can('reliever', 'staff.add_on_call')).toBe(false);
  });
});
