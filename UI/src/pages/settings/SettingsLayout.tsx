import { NavLink, Outlet } from 'react-router';

const TABS = [
  { to: 'services', label: 'Services & Prices' },
  { to: 'promos', label: 'Promos' },
  { to: 'holidays', label: 'Holidays' },
  { to: 'rooms', label: 'Rooms & Add-ons' },
  { to: 'staff', label: 'Staff' },
  { to: 'pay', label: 'Commission & Pay' },
  { to: 'front-desk', label: 'Front-desk device' },
];

export function SettingsLayout() {
  return (
    <div className="max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <nav className="flex gap-1 border-b border-stone-200">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                isActive ? 'border-teal-700 text-teal-800' : 'border-transparent text-stone-500 hover:text-stone-800'
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
