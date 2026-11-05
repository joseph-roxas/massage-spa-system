export type Role = 'super_admin' | 'receptionist';

/**
 * What a logged-in role may do. The API guards routes with these and the UI
 * uses the same list to decide which menus to show.
 */
export const CAPABILITIES = [
  'users.manage',
  'settings.manage',
  'bookings.manage',
  'sales.manage',
  'sales.complimentary',
  'vouchers.import',
  'vouchers.endorse',
  'cashouts.record',
  'cash.receive',
  'day.close',
  'day.reopen',
  'dtr.correct.therapist',
  'dtr.correct.receptionist',
  'payroll.therapist.generate',
  'payroll.therapist.approve',
  'payroll.receptionist.manage',
  /** See one's own released Payslips and Cash Advances (My Pay). */
  'payroll.view_own',
  'cash_advance.therapist',
  'cash_advance.override',
  'inventory.stock_out',
  'inventory.po.request',
  'inventory.po.approve',
  'inventory.receive',
  'expenses.manage',
  'royalty.manage',
  'reports.all',
  'reports.daily',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const RECEPTIONIST: readonly Capability[] = [
  'bookings.manage',
  'sales.manage',
  'cashouts.record',
  'day.close',
  'dtr.correct.therapist',
  'payroll.therapist.generate',
  'payroll.view_own',
  'cash_advance.therapist',
  'inventory.stock_out',
  'reports.daily',
];

const GRANTS: Record<Role, ReadonlySet<Capability>> = {
  super_admin: new Set(CAPABILITIES),
  receptionist: new Set(RECEPTIONIST),
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  return role ? GRANTS[role].has(capability) : false;
}
