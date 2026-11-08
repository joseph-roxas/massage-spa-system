/** `reliever`: the shared Reliever Login, usable only during a Relief Shift (ADR 0005). */
export type Role = 'super_admin' | 'receptionist' | 'reliever';

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
  /** Add an On-call Therapist from the desk. */
  'staff.add_on_call',
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
  'staff.add_on_call',
];

/** The Receptionist's powers minus Payroll and adding staff; a Reliever still records the Cash Handover. */
const RELIEVER = RECEPTIONIST.filter((c) => c !== 'payroll.therapist.generate' && c !== 'payroll.view_own' && c !== 'staff.add_on_call');

const GRANTS: Record<Role, ReadonlySet<Capability>> = {
  super_admin: new Set(CAPABILITIES),
  receptionist: new Set(RECEPTIONIST),
  reliever: new Set(RELIEVER),
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  return role ? GRANTS[role].has(capability) : false;
}
