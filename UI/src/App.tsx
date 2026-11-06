import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Layout, RequireAuth, RequireCapability } from './components/Layout';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { UsersPage } from './pages/UsersPage';
import { PriceListPage } from './pages/PriceListPage';
import { ClockInPage } from './pages/ClockInPage';
import { DtrPage } from './pages/DtrPage';
import { VouchersPage } from './pages/VouchersPage';
import { CashPage } from './pages/CashPage';
import { FinancePage } from './pages/FinancePage';
import { PayrollPage } from './pages/PayrollPage';
import { InventoryPage } from './pages/InventoryPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { ReportsPage } from './pages/ReportsPage';
import { GoLivePage } from './pages/GoLivePage';
import { PaperSheetPage } from './pages/PaperSheetPage';
import { PayslipPage } from './pages/payroll/PayslipPage';
import { MyPayPage, MyPayslipPage } from './pages/MyPayPage';
import { GuestPage, GuestsPage } from './pages/GuestsPage';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { ServicesSettings } from './pages/settings/ServicesSettings';
import { PromosSettings } from './pages/settings/PromosSettings';
import { HolidaysSettings } from './pages/settings/HolidaysSettings';
import { RoomsSettings } from './pages/settings/RoomsSettings';
import { StaffSettings } from './pages/settings/StaffSettings';
import { PaySettings } from './pages/settings/PaySettings';
import { FrontDeskSettings } from './pages/settings/FrontDeskSettings';
import { BusinessSettings } from './pages/settings/BusinessSettings';
import { BackfillPage } from './pages/BackfillPage';
import { PastPayslipPage } from './pages/PastPayslipPage';
import { BrandingEffect } from './components/Brand';

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
    // Logged in, or on the Front-desk Device with no one logged in; the page sends anyone else to log in.
    path: '/clock',
    element: <ClockInPage />,
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
        path: '/vouchers',
        element: (
          <RequireCapability capability="sales.manage">
            <VouchersPage />
          </RequireCapability>
        ),
      },
      {
        path: '/finance',
        element: (
          <RequireCapability capability="reports.all">
            <FinancePage />
          </RequireCapability>
        ),
      },
      {
        path: '/cash',
        element: (
          <RequireCapability capability="cashouts.record">
            <CashPage />
          </RequireCapability>
        ),
      },
      { path: '/past-payslip/:id', element: <PastPayslipPage /> },
      {
        path: '/admin/backfill',
        element: (
          <RequireCapability capability="settings.manage">
            <BackfillPage />
          </RequireCapability>
        ),
      },
      {
        path: '/admin/go-live',
        element: (
          <RequireCapability capability="settings.manage">
            <GoLivePage />
          </RequireCapability>
        ),
      },
      {
        path: '/paper-sheet',
        element: (
          <RequireCapability capability="bookings.manage">
            <PaperSheetPage />
          </RequireCapability>
        ),
      },
      {
        path: '/reports',
        element: (
          <RequireCapability capability="reports.daily">
            <ReportsPage />
          </RequireCapability>
        ),
      },
      {
        path: '/expenses',
        element: (
          <RequireCapability capability="expenses.manage">
            <ExpensesPage />
          </RequireCapability>
        ),
      },
      {
        path: '/inventory',
        element: (
          <RequireCapability capability="inventory.stock_out">
            <InventoryPage />
          </RequireCapability>
        ),
      },
      {
        path: '/payroll',
        element: (
          <RequireCapability capability="payroll.therapist.generate">
            <PayrollPage />
          </RequireCapability>
        ),
      },
      {
        path: '/payroll/:id',
        element: (
          <RequireCapability capability="payroll.therapist.generate">
            <PayslipPage />
          </RequireCapability>
        ),
      },
      {
        path: '/guests',
        element: (
          <RequireCapability capability="bookings.manage">
            <GuestsPage />
          </RequireCapability>
        ),
      },
      {
        path: '/guests/:id',
        element: (
          <RequireCapability capability="bookings.manage">
            <GuestPage />
          </RequireCapability>
        ),
      },
      {
        path: '/my-pay',
        element: (
          <RequireCapability capability="payroll.view_own">
            <MyPayPage />
          </RequireCapability>
        ),
      },
      {
        path: '/my-pay/:id',
        element: (
          <RequireCapability capability="payroll.view_own">
            <MyPayslipPage />
          </RequireCapability>
        ),
      },
      {
        path: '/dtr',
        element: (
          <RequireCapability capability="dtr.correct.therapist">
            <DtrPage />
          </RequireCapability>
        ),
      },
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
          { path: 'front-desk', element: <FrontDeskSettings /> },
          { path: 'business', element: <BusinessSettings /> },
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
      <BrandingEffect />
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
