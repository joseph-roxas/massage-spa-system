import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type DiscountType = 'none' | 'senior' | 'pwd' | 'promo' | 'voucher' | 'complimentary';

export type PriceChoice = {
  bookingId: string;
  statutory: 'senior' | 'pwd' | null;
  /** The Promo picked, or null for none; left out, the server uses the best that applies. */
  promoId?: string | null;
  addonIds: string[];
  complimentary: boolean;
  voucherSerial: string | null;
};

export type Quote = {
  regularPrice: number;
  discount: { type: DiscountType; bp: number; amount: number; promoId: string | null; label: string };
  serviceAmount: number;
  addonsTotal: number;
  amountDue: number;
  focKind: 'none' | 'prepaid' | 'real';
  addons: { id: string; name: string; price: number }[];
  /** Every running Promo, with why it doesn't cover this Service (null if it does). */
  promos: { id: string; name: string; percentBp: number; problem: string | null }[];
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
  laundry: 'Laundry',
  supplies: 'Supplies',
  food: 'Food / rice',
  transport: 'Transport',
  other: 'Other',
  on_call_commission: 'On-call pay',
  cash_advance: 'Cash Advance',
} as const;

/** What the Cash-out form offers, and where each one's cash comes from. */
export const FORM_CASH_OUTS = {
  petty_cash: { hint: 'From the petty cash fund: rice, ballpens, paper, tape, phone load' },
  laundry: { hint: 'From sales cash' },
} as const;

export type CashOut = {
  id: string;
  category: keyof typeof CASH_OUT_CATEGORIES;
  source: 'sales' | 'petty';
  amount: number;
  purpose: string;
  createdAt: string;
};

export type ClosePreview = {
  day: BusinessDay;
  blockers: { bookingId: string; guest: string; service: string; problem: string }[];
  owed: { staffId: string; displayName: string; amount: number }[];
  totals: { cashIn: number; gcashIn: number; cashOut: number; expectedCash: number; expectedGcash: number };
  /** Paid into the drawer for Vouchers sold today; already in the cash and GCash totals. */
  vouchersSold: number;
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
      api<{ id?: string; total?: number; serials?: { serial: string; isFree: boolean }[] }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      for (const key of ['front-desk', 'cash-outs', 'close-preview', 'voucher-sales', 'vouchers']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
