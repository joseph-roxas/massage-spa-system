import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { PaymentLine } from './sales';

export type VoucherStatus = 'unused' | 'redeemed' | 'voided';

export const VOUCHER_STATUS_LABELS: Record<VoucherStatus, string> = {
  unused: 'Unused',
  redeemed: 'Used',
  voided: 'Cancelled',
};

export type Voucher = {
  id: string;
  serial: string;
  serviceId: string;
  serviceName: string;
  isFree: boolean;
  status: VoucherStatus;
  imported: boolean;
  redeemedAt: string | null;
  buyerName: string | null;
  soldOn: string | null;
  createdAt: string;
};

export type VoucherSale = {
  id: string;
  businessDay: string;
  status: 'paid' | 'voided';
  serviceName: string;
  buyerName: string | null;
  qtyPaid: number;
  qtyFree: number;
  unitPrice: number;
  total: number;
  createdAt: string;
  vouchers: { serial: string; isFree: boolean; status: VoucherStatus }[];
  payments: PaymentLine[];
};

export const useVouchers = (filter: { q: string; status: VoucherStatus | '' }) =>
  useQuery({
    queryKey: ['vouchers', filter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.q.trim()) params.set('q', filter.q.trim());
      if (filter.status) params.set('status', filter.status);
      return api<{ vouchers: Voucher[] }>(`/vouchers?${params}`);
    },
    placeholderData: (prev) => prev,
  });

export const useVoucherSales = (day: string) =>
  useQuery({ queryKey: ['voucher-sales', day], queryFn: () => api<{ voucherSales: VoucherSale[] }>(`/voucher-sales?day=${day}`) });
