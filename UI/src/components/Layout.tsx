import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../lib/api';
import { DefaultAvatar } from './Avatar';
import { BrandMark } from './Brand';
import { can, type Capability, type Role } from '@spa/domain';
import { ROLE_LABELS, useCurrentUser, useLogout } from '../lib/auth';
import { useAttention } from '../lib/attention';

/** Menu entries appear only for roles that hold the capability. */
const FRONT_DESK_ROLES: Role[] = ['receptionist', 'reliever'];
const NAV: { to: string; label: string; capability?: Capability; hideFor?: Role[] }[] = [
  { to: '/', label: 'Dashboard', capability: 'reports.all' },
  { to: '/front-desk', label: 'Front Desk' },
  { to: '/guests', label: 'Guests', capability: 'bookings.manage' },
  { to: '/vouchers', label: 'Vouchers', capability: 'sales.manage' },
  { to: '/cash', label: 'Cash', capability: 'cashouts.record' },
  { to: '/dtr', label: 'Time Records', capability: 'dtr.correct.therapist' },
  { to: '/payroll', label: 'Payroll', capability: 'payroll.therapist.generate' },
  // The Super Admin holds every capability but has no payslips of her own.
  { to: '/my-pay', label: 'My Pay', capability: 'payroll.view_own', hideFor: ['super_admin'] },
  { to: '/inventory', label: 'Inventory', capability: 'inventory.stock_out' },
  { to: '/expenses', label: 'Expenses', capability: 'expenses.manage' },
  { to: '/reports', label: 'Reports', capability: 'reports.daily' },
  { to: '/finance', label: 'Finance', capability: 'reports.all' },
  { to: '/price-list', label: 'Price List', hideFor: FRONT_DESK_ROLES },
  { to: '/paper-sheet', label: 'Paper backup', capability: 'bookings.manage', hideFor: FRONT_DESK_ROLES },
  { to: '/settings', label: 'Settings', capability: 'settings.manage' },
  { to: '/admin/go-live', label: 'Go-live', capability: 'settings.manage' },
  { to: '/admin/correct-sales', label: 'Correct sales', capability: 'day.reopen' },
  { to: '/admin/catch-up', label: 'Nov 2–8 entry', capability: 'settings.manage' },
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
  // Below 1280px the menu folds into a top bar; this opens it over the page.
  // Remembered with the page it was opened on, so going anywhere closes it.
  const location = useLocation();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const menuOpen = openOn === location.key;
  const setMenuOpen = (open: boolean) => setOpenOn(open ? location.key : null);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenOn(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  if (!user) return null;
  const dayOpen = logout.error instanceof ApiError && logout.error.code === 'day_open';
  const badge = waiting > 0 && (
    <span title="Needs attention" className={`rounded-full px-2 text-xs font-semibold text-white ${urgent ? 'bg-red-600' : 'bg-amber-500'}`}>
      {waiting}
    </span>
  );

  return (
    <div className="min-h-screen bg-stone-100 text-stone-800 xl:flex">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-2 xl:hidden print:hidden">
        <div className="min-w-0">
          <BrandMark />
        </div>
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls="main-menu"
          className="flex shrink-0 items-center gap-2 rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
          onClick={() => setMenuOpen(true)}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
          Menu
          {badge}
        </button>
      </header>
      {menuOpen && <div className="fixed inset-0 z-40 bg-stone-900/40 xl:hidden print:hidden" onClick={() => setMenuOpen(false)} />}
      <aside
        id="main-menu"
        className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-64 max-w-[85vw] flex-col border-r border-stone-200 bg-white shadow-xl transition-transform duration-200 xl:sticky xl:top-0 xl:z-auto xl:w-60 xl:shrink-0 xl:translate-x-0 xl:shadow-none print:hidden ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-start justify-between gap-2 px-5 py-5">
          <BrandMark stacked />
          <button
            type="button"
            aria-label="Close menu"
            className="-mr-2 rounded-md p-2 text-stone-500 hover:bg-stone-100 xl:hidden"
            onClick={() => setMenuOpen(false)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {NAV.filter((n) => (!n.capability || can(user.role, n.capability)) && !n.hideFor?.includes(user.role)).map((n) => (
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
                {n.to === '/' && badge}
              </span>
            </NavLink>
          ))}
        </nav>
        {/* Always in view: only the list of pages above scrolls. */}
        <div className="shrink-0 border-t border-stone-200 p-4">
          <div className="flex items-center gap-3">
            <DefaultAvatar />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {user.firstName} {user.lastName}
              </p>
              <p className="text-xs text-stone-500">
                {ROLE_LABELS[user.role]}
                {user.actingAs && ` · ${user.actingAs.displayName} relieving`}
              </p>
            </div>
          </div>
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
                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={() => {
                      logout.reset();
                      navigate('/?close=1');
                    }}
                  >
                    Go to Day Close
                  </button>
                  <button type="button" className="font-medium text-red-700 underline" onClick={() => logout.mutate(true)}>
                    Log out anyway
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 2xl:p-8 print:p-0">
        {/* Grows past the window only when a page truly can't fit, so the whole page scrolls sideways, never a box inside it. */}
        <div className="min-w-fit">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
