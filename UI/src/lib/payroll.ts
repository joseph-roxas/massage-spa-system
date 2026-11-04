import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type PayrollKind = 'therapist' | 'receptionist';
export type PayrollStatus = 'draft' | 'approved' | 'released';
export type PayWeek = { start: string; end: string };

export const STATUS_LABELS: Record<PayrollStatus, string> = { draft: 'Draft', approved: 'Approved', released: 'Released' };
export const STATUS_TONE = { draft: 'amber', approved: 'teal', released: 'stone' } as const;

export type Payroll = {
  id: string;
  weekStart: string;
  staffId: string;
  kind: PayrollKind;
  status: PayrollStatus;
  gross: number;
  govSss: number;
  govPhic: number;
  govPagibig: number;
  caDeduction: number;
  net: number;
  basic: number;
  displayName: string;
  fullName: string;
  therapistClass: 'regular' | 'lmt' | null;
  generatedAt: string;
  approvedAt: string | null;
  releasedAt: string | null;
};

export type TherapistDay = { date: string; services: number; commission: number };
export type DayKind = 'ordinary' | 'restDay' | 'special' | 'specialOnRestDay' | 'regular' | 'regularOnRestDay';
export type ReceptionistDay = {
  date: string;
  kind: DayKind;
  worked: boolean;
  lateMin: number;
  undertimeMin: number;
  overtimeMin: number;
  paidMin: number;
  basic: number;
  dayPay: number;
  overtimePay: number;
  holidayPay: number;
  total: number;
};

export const DAY_KIND_LABELS: Record<DayKind, string> = {
  ordinary: 'Ordinary',
  restDay: 'Rest Day',
  special: 'Special Day',
  specialOnRestDay: 'Special Day on Rest Day',
  regular: 'Regular Holiday',
  regularOnRestDay: 'Regular Holiday on Rest Day',
};

export type CashAdvance = { id: string; amount: number; businessDay: string; againstWeekStart: string | null; overrideBy: string | null; note: string | null; createdAt: string; cashOutId: string | null };

export type Balance = {
  staffId: string;
  displayName: string;
  kind: PayrollKind;
  balance: number;
  cap?: { week: PayWeek; net: number; taken: number; cap: number };
};

export type Bonus = {
  id: string;
  year: number;
  staffId: string;
  displayName: string;
  kind: 'year_end_bonus' | 'thirteenth_month';
  basis: number;
  bp: number | null;
  amount: number;
  paidAt: string | null;
};

export const usePayWeek = (start: string) =>
  useQuery({
    queryKey: ['payroll', 'week', start],
    queryFn: () => api<{ week: PayWeek; ended: boolean; unclosedDays: string[]; kinds: PayrollKind[]; payrolls: Payroll[] }>(`/payroll/weeks/${start}`),
    placeholderData: (prev) => prev,
  });

export const usePayroll = (id: string) =>
  useQuery({
    queryKey: ['payroll', 'one', id],
    queryFn: () =>
      api<{ payroll: Payroll & { days: (TherapistDay | ReceptionistDay)[] }; advances: CashAdvance[]; caBalance: number; week: PayWeek }>(`/payrolls/${id}`),
  });

export const useBalances = () =>
  useQuery({ queryKey: ['cash-advances', 'balances'], queryFn: () => api<{ balances: Balance[] }>('/cash-advances/balances') });

export const useBonuses = (year: number) =>
  useQuery({ queryKey: ['bonuses', year], queryFn: () => api<{ bonuses: Bonus[] }>(`/bonuses?year=${year}`) });

export function usePayrollAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) =>
      api<{ generated?: number; computed?: number }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      for (const key of ['payroll', 'cash-advances', 'bonuses', 'cash-outs', 'close-preview', 'front-desk']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const nextWeek = (start: string) => shift(start, 7);
export const prevWeek = (start: string) => shift(start, -7);
