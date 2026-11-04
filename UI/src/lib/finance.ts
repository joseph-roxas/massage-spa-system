import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { longDate } from './format';

export type QuarterStatus = {
  quarter: string;
  start: string;
  end: string;
  grossSales: { services: number; vouchers: number; total: number };
  tax: number;
  dueOn: string;
  /** Negative once overdue. */
  daysLeft: number;
  filing: { filedOn: string; amountPaid: number; computed: number } | null;
};

export type StatementLine = { label: string; amount: number };
export type Statement = {
  revenue: StatementLine[];
  revenueTotal: number;
  costs: StatementLine[];
  costTotal: number;
  net: number;
  discounts: number;
  /** Drafted Expenses not confirmed yet: not counted above. */
  pending: StatementLine[];
};

/** "is due Mon, Oct 26, 2026 (12 days)", or how late it is. */
export function dueText(s: QuarterStatus): string {
  if (s.daysLeft < 0) return `was due ${longDate(s.dueOn)} (${-s.daysLeft} day${s.daysLeft === -1 ? '' : 's'} late)`;
  if (s.daysLeft === 0) return `is due today, ${longDate(s.dueOn)}`;
  return `is due ${longDate(s.dueOn)} (${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'})`;
}

export const usePercentageTax = (quarter: string) =>
  useQuery({
    queryKey: ['finance', 'percentage-tax', quarter],
    queryFn: () => api<QuarterStatus & { currentQuarter: string }>(`/finance/percentage-tax${quarter ? `?quarter=${quarter}` : ''}`),
    placeholderData: (prev) => prev,
  });

export const useIncomeStatement = (from: string, to: string) =>
  useQuery({
    queryKey: ['finance', 'statement', from, to],
    queryFn: () => api<{ from: string; to: string; current: Statement; lastYear: Statement & { from: string; to: string } }>(`/finance/income-statement?from=${from}&to=${to}`),
    placeholderData: (prev) => prev,
  });

export function useFinanceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown }) => api<{ amount?: number }>(req.path, { method: 'POST', body: req.body ?? {} }),
    onSettled: () => {
      for (const key of ['finance', 'expenses', 'attention']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
