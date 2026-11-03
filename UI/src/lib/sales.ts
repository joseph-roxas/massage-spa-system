import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type DiscountType = 'none' | 'senior' | 'pwd' | 'promo' | 'complimentary';

export type PriceChoice = {
  bookingId: string;
  statutory: 'senior' | 'pwd' | null;
  addonIds: string[];
  complimentary: boolean;
};

export type Quote = {
  regularPrice: number;
  discount: { type: DiscountType; bp: number; amount: number; label: string };
  serviceAmount: number;
  addonsTotal: number;
  amountDue: number;
  focKind: 'none' | 'prepaid' | 'real';
  addons: { id: string; name: string; price: number }[];
};

export type PaymentLine = { method: 'cash' | 'gcash'; amount: number; gcashRef?: string | null };

export type BusinessDay = {
  date: string;
  openedAt: string;
  earlyCloseAt: string | null;
  earlyCloseReason: string | null;
  earlyCloseStatus: 'recorded' | 'rejected' | null;
  closedAt: string | null;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
};

export const CASH_OUT_CATEGORIES = {
  petty_cash: 'Petty cash',
  supplies: 'Supplies',
  food: 'Food / rice',
  transport: 'Transport',
  other: 'Other',
  on_call_commission: 'On-call pay',
} as const;

export type CashOut = {
  id: string;
  category: keyof typeof CASH_OUT_CATEGORIES;
  amount: number;
  purpose: string;
  createdAt: string;
};

export type ClosePreview = {
  day: BusinessDay;
  blockers: { bookingId: string; guest: string; service: string; problem: string }[];
  owed: { staffId: string; displayName: string; amount: number }[];
  totals: { cashIn: number; gcashIn: number; cashOut: number; expectedCash: number; expectedGcash: number };
  cashOuts: CashOut[];
  guests: number;
};

/** The server prices every change of discount or add-on, so the screen never disagrees with the record. */
export const useQuote = (choice: PriceChoice) =>
  useQuery({
    queryKey: ['quote', choice],
    queryFn: () => api<Quote>('/sales/quote', { body: choice }),
    placeholderData: (prev) => prev,
    retry: false,
  });

export const useClosePreview = (date: string) =>
  useQuery({ queryKey: ['close-preview', date], queryFn: () => api<ClosePreview>(`/days/${date}/close-preview`), staleTime: 0 });

export const useCashOuts = (day: string) =>
  useQuery({ queryKey: ['cash-outs', day], queryFn: () => api<{ cashOuts: CashOut[] }>(`/cash-outs?day=${day}`) });

/** Any sales or Business Day write; refreshes the board, the drawer and the close preview. */
export function useDayAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) =>
      api<{ id?: string }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      for (const key of ['front-desk', 'cash-outs', 'close-preview']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
