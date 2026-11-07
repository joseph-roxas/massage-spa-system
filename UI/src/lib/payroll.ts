import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/** `reliever`: an Outside Reliever on long cover, paid weekly. */
export type PayrollKind = 'therapist' | 'receptionist' | 'reliever';
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
  govDeferred: number;
  govCollected: number;
  govOverride: number | null;
  govAgreed: boolean;
  /** Therapists: what they still owe the shop, this Payroll included. */
  deferredOwed: { total: number; weeks: { weekStart: string; number: number; amount: number }[] } | null;
  commissionBefore: number;
  net: number;
  basic: number;
  displayName: string;
  fullName: string;
  therapistClass: 'regular' | 'lmt' | null;
  generatedAt: string;
  approvedAt: string | null;
  releasedAt: string | null;
  adjustments: Adjustment[];
  lines: PayLines;
};

/** The reason is sent to the Super Admin only. */
export type Adjustment = { id: string; label: string; amount: number; reason?: string };

export type EarningKey = 'commission' | 'commissionBefore' | 'holidayExtra' | 'reliefPay' | 'basic' | 'restDayPremium' | 'holidayPremium' | 'holidayUnworked' | 'overtime' | 'adjustments';
export type DeductionKey = 'late' | 'undertime' | 'sss' | 'phic' | 'pagibig' | 'deferred' | 'ca';
export type PayLines = {
  earnings: Record<EarningKey, number>;
  deductions: Record<DeductionKey, number>;
  totalEarned: number;
  totalDeductions: number;
  daysPresent: number;
};

/** Which lines each kind of Payroll shows, in Payslip order. */
export const EARNING_LINES: Record<PayrollKind, [EarningKey, string][]> = {
  therapist: [
    ['commission', 'Commission'],
    ['commissionBefore', 'Commission before go-live'],
    ['holidayExtra', 'Holiday Commission (extra)'],
    ['reliefPay', 'Relief pay (front desk)'],
    ['adjustments', 'Adjustments'],
  ],
  receptionist: [
    ['basic', 'Basic pay'],
    ['restDayPremium', 'Rest Day premium'],
    ['holidayPremium', 'Holiday premium (worked)'],
    ['holidayUnworked', 'Holiday pay (not worked)'],
    ['overtime', 'Overtime'],
    ['adjustments', 'Adjustments'],
  ],
  reliever: [
    ['basic', 'Basic pay (Minimum Wage Rate)'],
    ['holidayPremium', 'Holiday premium (worked)'],
    ['overtime', 'Overtime'],
    ['adjustments', 'Adjustments'],
  ],
};
export const DEDUCTION_LINES: Record<PayrollKind, [DeductionKey, string][]> = {
  therapist: [
    ['sss', 'SSS'],
    ['phic', 'PhilHealth'],
    ['pagibig', 'Pag-IBIG'],
    ['deferred', 'Deferred Deductions'],
    ['ca', 'Cash Advance'],
  ],
  receptionist: [
    ['late', 'Late'],
    ['undertime', 'Undertime'],
    ['sss', 'SSS'],
    ['phic', 'PhilHealth'],
    ['pagibig', 'Pag-IBIG'],
    ['ca', 'Cash Advance'],
  ],
  reliever: [
    ['late', 'Late'],
    ['undertime', 'Undertime'],
  ],
};

export type TherapistDay = { date: string; services: number; commission: number; holidayExtra?: number; reliefPay?: number };
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
  /** Missing on Payrolls made before Payslip lines. */
  dailyRate?: number;
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
  /** Receptionist: the standing CA Repayment per Payroll. */
  caRepayment?: number;
  /** Receptionist: the balance her Past Payslips last recorded. */
  suggestedOpening?: number | null;
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
  /** Deferred Deductions taken off when paid. */
  deduction: number;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
};

export type BonusSuggestion = {
  period: PayWeek;
  shareBp: number;
  commission: number;
  profitBefore: number;
  thirteenthMonth: number;
  profit: number;
  bp: number | null;
  scenarios: { bp: number; cost: number; left: number }[];
  lines: { staffId: string; displayName: string; commission: number; deferred: number }[];
};

/** Basic pay earned before Go-live, for 13th Month Pay. */
export type OpeningBasic = { staffId: string; displayName: string; amount: number | null; suggested: number };

/** A Therapist's Commission for the days of the first Pay Week before Go-live. */
export type BeforeGoLive = { staffId: string; displayName: string; amount: number | null };

/** A Therapist's Pay Week from before Go-live, from the owner's records. */
export type RecordWeek = { staffId: string; displayName: string; gross: number; daysWorked: number; net: number };

export const usePayWeek = (start: string) =>
  useQuery({
    queryKey: ['payroll', 'week', start],
    queryFn: () => api<{ week: PayWeek; ended: boolean; unclosedDays: string[]; kinds: PayrollKind[]; beforeGoLive: BeforeGoLive[] | null; fromRecords: RecordWeek[]; payrolls: Payroll[] }>(`/payroll/weeks/${start}`),
    placeholderData: (prev) => prev,
  });

export const usePayroll = (id: string) =>
  useQuery({
    queryKey: ['payroll', 'one', id],
    queryFn: () =>
      api<{ payroll: Payroll & { days: (TherapistDay | ReceptionistDay)[] }; advances: CashAdvance[]; caBalance: number; deductionBalance: number; week: PayWeek }>(`/payrolls/${id}`),
  });

export type MyPay = {
  staff: { displayName: string; kind: 'therapist' | 'receptionist'; dailyRate: number | null; caRepayment: number } | null;
  payslips: { id: string; weekStart: string; net: number; releasedAt: string | null }[];
  pastPayslips: { id: string; weekStart: string; weekEnd: string; paidOn: string | null; net: number }[];
  ca: {
    entries: { id: string; entry: 'opening' | 'advance' | 'repayment'; amount: number; date: string; weekStart: string | null }[];
    totalTaken: number;
    totalRepaid: number;
    balance: number;
  } | null;
};

export const useMyPay = () => useQuery({ queryKey: ['my-pay'], queryFn: () => api<MyPay>('/me/pay') });

export const useMyPayslip = (id: string) =>
  useQuery({
    queryKey: ['my-pay', id],
    queryFn: () => api<{ payroll: Payroll & { days: (TherapistDay | ReceptionistDay)[] }; week: PayWeek }>(`/me/payslips/${id}`),
  });

export const useBalances = () =>
  useQuery({ queryKey: ['cash-advances', 'balances'], queryFn: () => api<{ balances: Balance[] }>('/cash-advances/balances') });

export const useBonuses = (year: number) =>
  useQuery({ queryKey: ['bonuses', year], queryFn: () => api<{ bonuses: Bonus[] }>(`/bonuses?year=${year}`) });

export const useBonusSuggestion = (year: number, shareBp: number) =>
  useQuery({ queryKey: ['bonuses', year, 'suggestion', shareBp], queryFn: () => api<BonusSuggestion>(`/bonuses/year-end/suggestion?year=${year}&share=${shareBp}`) });

export const useOpeningBasic = (year: number) =>
  useQuery({ queryKey: ['bonuses', year, 'opening-basic'], queryFn: () => api<{ people: OpeningBasic[] }>(`/bonuses/opening-basic?year=${year}`) });

export function usePayrollAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) =>
      api<{ generated?: number; computed?: number }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      for (const key of ['payroll', 'cash-advances', 'bonuses', 'cash-outs', 'close-preview', 'front-desk', 'cash']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const nextWeek = (start: string) => shift(start, 7);
export const payWeekEnd = (start: string) => shift(start, 6);
export const prevWeek = (start: string) => shift(start, -7);
