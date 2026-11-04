import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type Item = {
  id: string;
  name: string;
  unit: string;
  reorderLevel: number;
  active: boolean;
  sortOrder: number;
  onHand: number;
  low: boolean;
  lastStockOut: string | null;
  latestPurchase: { unitPrice: number | null; purchaseDate: string; vendorName: string | null } | null;
};

export type Vendor = { id: string; name: string; contact: string | null; active: boolean };

export type PoStatus = 'requested' | 'approved' | 'partially_received' | 'received' | 'cancelled';
export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  requested: 'Waiting for approval',
  approved: 'Approved',
  partially_received: 'Partly delivered',
  received: 'Delivered',
  cancelled: 'Cancelled',
};
export const PO_STATUS_TONE = { requested: 'amber', approved: 'teal', partially_received: 'teal', received: 'stone', cancelled: 'red' } as const;

export type PurchaseOrder = {
  id: string;
  vendorId: string;
  vendorName: string;
  status: PoStatus;
  note: string | null;
  requestedAt: string;
  requestedBy: string | null;
  requestedByName: string | null;
  cancelReason: string | null;
  lines: { id: string; itemId: string; itemName: string; unit: string; qty: number; expectedPrice: number | null; received: number }[];
};

export type Move = { type: 'in' | 'out' | 'opening'; id: string; date: string; qty: number; unitPrice: number | null; who: string | null; note: string | null };

export const itemLabel = (i: { name: string; unit: string }) => `${i.name} (${i.unit})`;

export const useItems = () => useQuery({ queryKey: ['inventory', 'items'], queryFn: () => api<{ items: Item[] }>('/inventory/items') });
export const useVendors = () => useQuery({ queryKey: ['inventory', 'vendors'], queryFn: () => api<{ vendors: Vendor[] }>('/inventory/vendors') });
export const usePurchaseOrders = () =>
  useQuery({ queryKey: ['inventory', 'orders'], queryFn: () => api<{ purchaseOrders: PurchaseOrder[] }>('/inventory/purchase-orders') });
export const useItemHistory = (id: string) =>
  useQuery({ queryKey: ['inventory', 'history', id], queryFn: () => api<{ moves: Move[] }>(`/inventory/items/${id}/history`) });

export function useInventoryAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) =>
      api<{ id?: string; status?: PoStatus }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}
