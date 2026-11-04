import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { PaymentLine } from './sales';

export type VoucherStatus = 'in_shop' | 'unused' | 'redeemed' | 'voided';

export const VOUCHER_STATUS_LABELS: Record<VoucherStatus, string> = {
  in_shop: 'In shop, not sold',
  unused: 'Sold, unused',
  redeemed: 'Used',
  voided: 'Cancelled',
};

export type Voucher = {
  id: string;
  serial: string;
  cardNo: number | null;
  serviceId: string;
  serviceName: string;
  isFree: boolean;
  status: VoucherStatus;
  imported: boolean;
  redeemedAt: string | null;
  buyerName: string | null;
  soldOn: string | null;
  voidReason: string | null;
  createdAt: string;
};

export type VoucherSale = {
  id: string;
  businessDay: string;
  status: 'paid' | 'voided';
  serviceName: string;
  buyerName: string | null;
  buyerPhone: string | null;
  qtyPaid: number;
  qtyFree: number;
  unitPrice: number;
  total: number;
  createdAt: string;
  used: number;
  /** In the order used; `free` once all the paid ones were used. */
  vouchers: { serial: string; status: VoucherStatus; redeemedAt: string | null; free: boolean }[];
  payments: PaymentLine[];
};

export type Endorsement = {
  id: string;
  serviceId: string;
  serviceName: string;
  fromNo: number;
  toNo: number;
  count: number;
  firstSerial: string;
  lastSerial: string;
  endorsedOn: string;
  note: string | null;
  receivedAt: string | null;
  receiveNote: string | null;
};

/** The Bundle of a Voucher typed in at checkout. */
export type VoucherBundle = {
  buyerName: string | null;
  buyerPhone: string | null;
  soldOn: string | null;
  qtyPaid: number | null;
  vouchers: { serial: string; redeemedAt: string | null; free: boolean }[];
  thisIsFree: boolean;
};

export const useVouchers = (filter: { q?: string; status?: VoucherStatus | ''; serviceId?: string }, enabled = true) =>
  useQuery({
    queryKey: ['vouchers', filter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.q?.trim()) params.set('q', filter.q.trim());
      if (filter.status) params.set('status', filter.status);
      if (filter.serviceId) params.set('serviceId', filter.serviceId);
      return api<{ vouchers: Voucher[] }>(`/vouchers?${params}`);
    },
    placeholderData: (prev) => prev,
    enabled,
  });

export const useVoucherSales = (filter: { from: string; to: string; q: string }) =>
  useQuery({
    queryKey: ['voucher-sales', filter],
    queryFn: () => {
      const params = new URLSearchParams({ from: filter.from, to: filter.to });
      if (filter.q.trim()) params.set('q', filter.q.trim());
      return api<{ voucherSales: VoucherSale[] }>(`/voucher-sales?${params}`);
    },
    placeholderData: (prev) => prev,
  });

export const useEndorsements = () =>
  useQuery({ queryKey: ['vouchers', 'endorsements'], queryFn: () => api<{ endorsements: Endorsement[] }>('/voucher-endorsements') });
