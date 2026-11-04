import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { CashOut } from './sales';

export type Category = { id: string; name: string; active: boolean; sortOrder: number };
export type Expense = {
  id: string;
  categoryId: string;
  date: string;
  amount: number;
  description: string;
  status: 'pending' | 'confirmed';
  recurringExpenseId: string | null;
  royaltyMonth: string | null;
};
export type Recurring = { id: string; categoryId: string; description: string; amount: number; dayOfMonth: number; active: boolean };
export type Purchase = { id: string; date: string; qty: number; unitPrice: number | null; itemName: string; unit: string; vendorName: string | null; total: number; fromDrawer: boolean };
export type MonthSpending = {
  start: string;
  end: string;
  expenses: Expense[];
  cashOuts: CashOut[];
  purchases: Purchase[];
  totals: { confirmed: number; pending: number; cashOuts: number; purchases: number };
};
export type RoyaltyStatement = {
  month: string;
  monthStart: string;
  monthEnd: string;
  serviceSales: number;
  voucherSales: number;
  grossSales: number;
  bp: number;
  amount: number;
  status: 'draft' | 'confirmed';
  computedAt: string;
  confirmedAt: string | null;
};

export const useCategories = () => useQuery({ queryKey: ['expenses', 'categories'], queryFn: () => api<{ categories: Category[] }>('/expenses/categories') });
export const useRecurring = () => useQuery({ queryKey: ['expenses', 'recurring'], queryFn: () => api<{ recurring: Recurring[] }>('/expenses/recurring') });
export const useMonthSpending = (month: string) =>
  useQuery({ queryKey: ['expenses', 'month', month], queryFn: () => api<MonthSpending>(`/expenses?month=${month}`), placeholderData: (prev) => prev });
export const useRoyalty = () =>
  useQuery({
    queryKey: ['expenses', 'royalty'],
    queryFn: () =>
      api<{
        statements: RoyaltyStatement[];
        current: { month: string; start: string; end: string; serviceSales: number; voucherSales: number; grossSales: number; bp: number; amount: number };
      }>('/royalty'),
  });

export function useExpenseAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) => api<{ id?: string }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'long', year: 'numeric' });
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
