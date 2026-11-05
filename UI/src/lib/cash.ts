import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type CashTransfer = {
  id: string;
  kind: 'opening' | 'payroll' | 'petty_topup' | 'handover';
  amount: number;
  businessDay: string;
  payrollId: string | null;
  note: string | null;
  createdAt: string;
  createdByName?: string | null;
  receivedAmount: number | null;
  receivedOn: string | null;
  receivedByName: string | null;
  receiveNote: string | null;
  confirmedAt: string | null;
  confirmedByName?: string | null;
};

export const TRANSFER_LABELS: Record<CashTransfer['kind'], string> = {
  opening: 'Opening count',
  payroll: 'Payroll paid',
  petty_topup: 'Petty cash top-up',
  handover: 'Handed to owner',
};

export type CashSummary = {
  day: string;
  salesCash: number;
  pettyCash: number;
  /** Sunday or Monday only: what brings petty cash back to ₱800. */
  topUpDue: number;
  reminder: 'hold' | 'hand_over' | 'none';
  /** Logged in as the Reliever: hand over all Sales Cash at the end of the Relief Shift. */
  relief: boolean;
  payWeek: { start: string; end: string };
  payrollReleased: boolean;
  laundryPaid: boolean;
  lastHandover: CashTransfer | null;
  waiting: CashTransfer[];
};

export const useCashSummary = () => useQuery({ queryKey: ['cash', 'summary'], queryFn: () => api<CashSummary>('/cash/summary') });

export const useCashTransfers = (from: string, to: string) =>
  useQuery({
    queryKey: ['cash', 'transfers', from, to],
    queryFn: () => api<{ transfers: CashTransfer[] }>(`/cash/transfers?from=${from}&to=${to}`),
    placeholderData: (prev) => prev,
  });

/** Any cash write; refreshes the summary, history and Day Close. */
export function useCashAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) => api<{ id?: string }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      for (const key of ['cash', 'cash-outs', 'close-preview', 'front-desk', 'attention']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
