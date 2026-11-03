import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Layout, RequireAuth, RequireCapability } from './components/Layout';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { UsersPage } from './pages/UsersPage';
import { PriceListPage } from './pages/PriceListPage';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { ServicesSettings } from './pages/settings/ServicesSettings';
import { PromosSettings } from './pages/settings/PromosSettings';
import { HolidaysSettings } from './pages/settings/HolidaysSettings';
import { RoomsSettings } from './pages/settings/RoomsSettings';
import { StaffSettings } from './pages/settings/StaffSettings';
import { PaySettings } from './pages/settings/PaySettings';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  {
    path: '/change-password',
    element: (
      <RequireAuth>
        <ChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/price-list', element: <PriceListPage /> },
      {
        path: '/settings',
        element: (
          <RequireCapability capability="settings.manage">
            <SettingsLayout />
          </RequireCapability>
        ),
        children: [
          { index: true, element: <Navigate to="services" replace /> },
          { path: 'services', element: <ServicesSettings /> },
          { path: 'promos', element: <PromosSettings /> },
          { path: 'holidays', element: <HolidaysSettings /> },
          { path: 'rooms', element: <RoomsSettings /> },
          { path: 'staff', element: <StaffSettings /> },
          { path: 'pay', element: <PaySettings /> },
        ],
      },
      {
        path: '/admin/users',
        element: (
          <RequireCapability capability="users.manage">
            <UsersPage />
          </RequireCapability>
        ),
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
