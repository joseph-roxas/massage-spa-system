import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type ItemKind = 'consumable' | 'reusable' | 'equipment';
export const ITEM_KIND_LABELS: Record<ItemKind, string> = { consumable: 'Consumable', reusable: 'Reusable supply', equipment: 'Equipment' };

export type Item = {
  id: string;
  name: string;
  unit: string;
  kind: ItemKind;
  reorderLevel: number;
  active: boolean;
  sortOrder: number;
  /** The Super Admin's own stock. */
  storage: number;
  /** Sent to the shop, not yet received. */
  inTransit: number;
  /** At the shop: what was received, less used and discarded. Same as `onHand`. */
  shop: number;
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

export type Move = {
  type: 'in' | 'opening' | 'use' | 'discard' | 'turnover';
  location: 'storage' | 'shop';
  id: string;
  date: string;
  qty: number;
  unitPrice: number | null;
  who: string | null;
  note: string | null;
};

export type Turnover = {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  qty: number;
  sentOn: string;
  takeoutRequestId: string | null;
  note: string | null;
  receivedQty: number | null;
  receivedAt: string | null;
  receiveNote: string | null;
  /** Sent but not received; open until the Super Admin resolves it. */
  short: number;
  shortfallOutcome: 'in_storage' | 'lost' | null;
  shortfallResolvedAt: string | null;
};

export type TakeoutRequest = {
  id: string;
  itemId: string | null;
  itemName: string;
  unit: string | null;
  qty: number;
  level: 'low' | 'out';
  note: string | null;
  createdAt: string;
  requestedByName: string | null;
  resolvedAt: string | null;
  dismissReason: string | null;
  /** Quantity already sent against it. */
  sent: number;
};

export const DISCARD_REASON_LABELS = { broken: 'Broken', worn_out: 'Worn out', lost: 'Lost' } as const;

export const itemLabel = (i: { name: string; unit: string }) => `${i.name} (${i.unit})`;

export const useItems = () => useQuery({ queryKey: ['inventory', 'items'], queryFn: () => api<{ items: Item[] }>('/inventory/items') });
export const useVendors = () => useQuery({ queryKey: ['inventory', 'vendors'], queryFn: () => api<{ vendors: Vendor[] }>('/inventory/vendors') });
export const usePurchaseOrders = (enabled = true) =>
  useQuery({ queryKey: ['inventory', 'orders'], queryFn: () => api<{ purchaseOrders: PurchaseOrder[] }>('/inventory/purchase-orders'), enabled });
export const useItemHistory = (id: string) =>
  useQuery({ queryKey: ['inventory', 'history', id], queryFn: () => api<{ moves: Move[] }>(`/inventory/items/${id}/history`) });
export const useTurnovers = () => useQuery({ queryKey: ['inventory', 'turnovers'], queryFn: () => api<{ turnovers: Turnover[] }>('/inventory/turnovers') });
export const useTakeoutRequests = () =>
  useQuery({ queryKey: ['inventory', 'requests'], queryFn: () => api<{ requests: TakeoutRequest[] }>('/inventory/takeout-requests') });

export function useInventoryAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) =>
      api<{ id?: string; status?: PoStatus }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}
