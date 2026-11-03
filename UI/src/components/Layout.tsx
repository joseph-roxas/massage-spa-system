import type { ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { can, type Capability } from '@spa/domain';
import { ROLE_LABELS, useCurrentUser, useLogout } from '../lib/auth';

/** Menu entries appear only for roles that hold the capability. */
const NAV: { to: string; label: string; capability?: Capability }[] = [
  { to: '/', label: 'Front Desk' },
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
  if (!user) return null;

  return (
    <div className="flex min-h-screen bg-stone-100 text-stone-800">
      <aside className="flex w-60 shrink-0 flex-col border-r border-stone-200 bg-white">
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
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
