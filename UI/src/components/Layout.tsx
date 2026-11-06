import type { ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../lib/api';
import { BrandMark } from './Brand';
import { can, type Capability, type Role } from '@spa/domain';
import { ROLE_LABELS, useCurrentUser, useLogout } from '../lib/auth';
import { useAttention } from '../lib/attention';

/** Menu entries appear only for roles that hold the capability. */
const NAV: { to: string; label: string; capability?: Capability; hideFor?: Role }[] = [
  { to: '/', label: 'Dashboard', capability: 'reports.all' },
  { to: '/front-desk', label: 'Front Desk' },
  { to: '/guests', label: 'Guests', capability: 'bookings.manage' },
  { to: '/vouchers', label: 'Vouchers', capability: 'sales.manage' },
  { to: '/cash', label: 'Cash', capability: 'cashouts.record' },
  { to: '/dtr', label: 'Time Records', capability: 'dtr.correct.therapist' },
  { to: '/payroll', label: 'Payroll', capability: 'payroll.therapist.generate' },
  // The Super Admin holds every capability but has no payslips of her own.
  { to: '/my-pay', label: 'My Pay', capability: 'payroll.view_own', hideFor: 'super_admin' },
  { to: '/inventory', label: 'Inventory', capability: 'inventory.stock_out' },
  { to: '/expenses', label: 'Expenses', capability: 'expenses.manage' },
  { to: '/reports', label: 'Reports', capability: 'reports.daily' },
  { to: '/finance', label: 'Finance', capability: 'reports.all' },
  { to: '/price-list', label: 'Price List' },
  { to: '/paper-sheet', label: 'Paper backup', capability: 'bookings.manage' },
  { to: '/settings', label: 'Settings', capability: 'settings.manage' },
  { to: '/admin/go-live', label: 'Go-live', capability: 'settings.manage' },
  { to: '/admin/backfill', label: 'This year’s records', capability: 'settings.manage' },
  { to: '/admin/users', label: 'Users', capability: 'users.manage' },
];

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isPending } = useCurrentUser();
  const location = useLocation();
  if (isPending) return <p className="p-10 text-stone-500">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}

export function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const { data: user } = useCurrentUser();
  if (!can(user?.role, capability)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function Layout() {
  const { data: user } = useCurrentUser();
  const attention = useAttention(can(user?.role, 'settings.manage'));
  const waiting = attention.data?.items.length ?? 0;
  const urgent = attention.data?.items.some((i) => i.tone === 'urgent') ?? false;
  const logout = useLogout();
  const navigate = useNavigate();
  if (!user) return null;
  const dayOpen = logout.error instanceof ApiError && logout.error.code === 'day_open';

  return (
    <div className="flex min-h-screen bg-stone-100 text-stone-800">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-stone-200 bg-white print:hidden">
        <div className="px-5 py-5">
          <BrandMark />
        </div>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {NAV.filter((n) => (!n.capability || can(user.role, n.capability)) && n.hideFor !== user.role).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? 'bg-teal-50 text-teal-800' : 'text-stone-600 hover:bg-stone-100'
                }`
              }
            >
              <span className="flex items-center justify-between">
                {n.label}
                {n.to === '/' && waiting > 0 && (
                  <span
                    title="Needs attention"
                    className={`rounded-full px-2 text-xs font-semibold text-white ${urgent ? 'bg-red-600' : 'bg-amber-500'}`}
                  >
                    {waiting}
                  </span>
                )}
              </span>
            </NavLink>
          ))}
        </nav>
        <div className="shrink-0 border-t border-stone-200 p-4">
          <p className="text-sm font-medium">
            {user.firstName} {user.lastName}
          </p>
          <p className="text-xs text-stone-500">
            {ROLE_LABELS[user.role]}
            {user.actingAs && ` · ${user.actingAs.displayName} relieving`}
          </p>
          <div className="mt-3 flex gap-3 text-xs">
            <NavLink to="/change-password" className="text-stone-600 hover:underline">
              Change password
            </NavLink>
            <button type="button" className="text-stone-600 hover:underline" onClick={() => logout.mutate()}>
              Log out
            </button>
          </div>
          {logout.error && (
            <div className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              <p>{logout.error.message}</p>
              {dayOpen && (
                <button
                  type="button"
                  className="mt-1 font-medium underline"
                  onClick={() => {
                    logout.reset();
                    navigate('/?close=1');
                  }}
                >
                  Go to Day Close
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-8 print:p-0">
        <Outlet />
      </main>
    </div>
  );
}
