import { describe, expect, it } from 'vitest';
import { CAPABILITIES, can } from './permissions';

describe('permissions', () => {
  it('grants the Super Admin everything', () => {
    for (const cap of CAPABILITIES) expect(can('super_admin', cap)).toBe(true);
  });

  it('keeps admin-only areas away from the Receptionist', () => {
    for (const cap of [
      'users.manage',
      'settings.manage',
      'sales.complimentary',
      'day.reopen',
      'dtr.correct.receptionist',
      'payroll.therapist.approve',
      'payroll.receptionist.manage',
      'cash_advance.override',
      'inventory.po.approve',
      'expenses.manage',
      'royalty.manage',
      'reports.all',
    ] as const) {
      expect(can('receptionist', cap)).toBe(false);
    }
  });

  it('lets the Receptionist run the front desk', () => {
    expect(can('receptionist', 'bookings.manage')).toBe(true);
    expect(can('receptionist', 'payroll.therapist.generate')).toBe(true);
  });

  it('grants nothing without a role', () => {
    expect(can(null, 'bookings.manage')).toBe(false);
  });
});
