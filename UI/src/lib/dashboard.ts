import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type Ranked = { name: string; amount: number; count: number };

export type Dashboard = {
  month: string;
  from: string;
  to: string;
  current: boolean;
  top: { sales: number; expenses: number; profit: number; profitForecast: number | null; pendingExpenses: number; cashIn: number; cashOut: number; averageSale: number };
  days: { date: string; sales: number; expenses: number }[];
  government: { employee: number; employer: number; total: number; noBasis: number };
  tax: { quarter: string; soFar: number; forecast: number; dueOn: string; filed: boolean };
  royalty: { status: 'paid' | 'not_paid' | 'forecast'; amount: number; owing: { months: number; total: number } };
  electricity: { month: string; amount: number }[];
  payroll: { therapists: number; receptionist: number; total: number };
  discounts: { label: string; amount: number; count: number }[];
  guests: {
    total: number;
    turnedAway: number;
    noShows: number;
    cancelled: number;
    noShowGuests: { name: string; count: number }[];
    cancelReasons: { date: string; guest: string | null; reason: string | null }[];
    byWeekday: { day: string; average: number }[];
  };
  topTherapists: Ranked[];
  topServices: Ranked[];
  consumables: { cost: number; perGuest: number } & ({ status: 'building' } | { status: 'normal' | 'high'; average: number; changeBp: number });
  vouchers: { count: number; value: number };
  variance: { total: number; days: number; worst: { date: string; variance: number | null } | null };
  birthdays: { name: string; day: number }[];
};

export const useDashboard = (month: string) =>
  useQuery({ queryKey: ['dashboard', month], queryFn: () => api<Dashboard>(`/dashboard?month=${month}`) });
