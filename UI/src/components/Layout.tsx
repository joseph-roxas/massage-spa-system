import type { ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../lib/api';
import { can, type Capability } from '@spa/domain';
import { ROLE_LABELS, useCurrentUser, useLogout } from '../lib/auth';

/** Menu entries appear only for roles that hold the capability. */
const NAV: { to: string; label: string; capability?: Capability }[] = [
  { to: '/', label: 'Front Desk' },
  { to: '/vouchers', label: 'Vouchers', capability: 'sales.manage' },
  { to: '/cash', label: 'Cash', capability: 'cashouts.record' },
  { to: '/dtr', label: 'Time Records', capability: 'dtr.correct.therapist' },
  { to: '/payroll', label: 'Payroll', capability: 'payroll.therapist.generate' },
  { to: '/inventory', label: 'Inventory', capability: 'inventory.stock_out' },
  { to: '/expenses', label: 'Expenses', capability: 'expenses.manage' },
  { to: '/reports', label: 'Reports', capability: 'reports.daily' },
  { to: '/price-list', label: 'Price List' },
  { to: '/paper-sheet', label: 'Paper backup', capability: 'bookings.manage' },
  { to: '/settings', label: 'Settings', capability: 'settings.manage' },
  { to: '/admin/go-live', label: 'Go-live', capability: 'settings.manage' },
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
  const logout = useLogout();
  const navigate = useNavigate();
  if (!user) return null;
  const dayOpen = logout.error instanceof ApiError && logout.error.code === 'day_open';

  return (
    <div className="flex min-h-screen bg-stone-100 text-stone-800">
      <aside className="flex w-60 shrink-0 print:hidden flex-col border-r border-stone-200 bg-white">
        <div className="px-5 py-5">
          <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">Spa System</p>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.filter((n) => !n.capability || can(user.role, n.capability)).map((n) => (
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
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-stone-200 p-4">
          <p className="text-sm font-medium">
            {user.firstName} {user.lastName}
          </p>
          <p className="text-xs text-stone-500">{ROLE_LABELS[user.role]}</p>
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
