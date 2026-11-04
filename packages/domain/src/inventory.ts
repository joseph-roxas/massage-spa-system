/** Quantities are whole units of the Item's unit of measure (1 gal, 1 pack of 50, 1 roll…). */

export const PO_STATUSES = ['requested', 'approved', 'partially_received', 'received', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

const sum = (xs: readonly { qty: number }[]) => xs.reduce((s, x) => s + x.qty, 0);

/** On hand = everything received (including the opening count) less everything taken out. */
export function onHand(stockIns: readonly { qty: number }[], stockOuts: readonly { qty: number }[]): number {
  return sum(stockIns) - sum(stockOuts);
}

/** Low once on hand falls to the reorder level. A level of 0 never warns. */
export function isLowStock(qty: number, reorderLevel: number): boolean {
  return reorderLevel > 0 && qty <= reorderLevel;
}

export function stockOutProblem(qty: number, available: number): string | null {
  if (qty > available) return available > 0 ? `Only ${available} on hand.` : 'None on hand.';
  return null;
}

export type ItemKind = 'consumable' | 'reusable' | 'equipment';

/**
 * Where an Item's stock is. Storage holds purchases until the Super Admin
 * sends them; a Turnover is in transit until the Shop receives it, and any
 * shortfall stays counted in Storage. Shop Stock is only what was received.
 */
export function stockLevels(m: {
  storageIns: number;
  shopIns: number;
  /** Turnovers sent and not yet received. */
  inTransit: number;
  /** Quantity actually received from Turnovers. */
  received: number;
  storageOuts: number;
  shopOuts: number;
}): { storage: number; inTransit: number; shop: number } {
  return {
    storage: m.storageIns - m.inTransit - m.received - m.storageOuts,
    inTransit: m.inTransit,
    shop: m.shopIns + m.received - m.shopOuts,
  };
}

/** Use is for Consumables; Discard is for Reusable Supplies and Equipment. */
export function takeOutProblem(kind: 'use' | 'discard', itemKind: ItemKind, qty: number, available: number): string | null {
  if (kind === 'use' && itemKind !== 'consumable') return 'Only consumables are used up. Discard a broken, worn-out or lost item instead.';
  if (kind === 'discard' && itemKind === 'consumable') return 'Consumables are used, not discarded.';
  if (qty > available) return available > 0 ? `Only ${available} at the shop.` : 'None at the shop.';
  return null;
}

/** The Super Admin can send only what Storage has. */
export function turnoverProblem(qty: number, inStorage: number): string | null {
  if (qty > inStorage) return inStorage > 0 ? `Only ${inStorage} in storage. Record the purchase first.` : 'None in storage. Record the purchase first.';
  return null;
}

/** The Shop can receive up to what was sent; less is a shortfall. */
export function receiveTurnoverProblem(receivedQty: number, sentQty: number): string | null {
  if (receivedQty > sentQty) return `Only ${sentQty} were sent.`;
  return null;
}

export type PoLine = { id: string; qty: number; received: number };

/** A delivery may not bring more of a line than is still to come. */
export function receiveProblem(lines: readonly PoLine[], delivery: readonly { lineId: string; qty: number }[]): string | null {
  if (!delivery.some((d) => d.qty > 0)) return 'Enter at least one quantity received.';
  for (const d of delivery) {
    const line = lines.find((l) => l.id === d.lineId);
    if (!line) return 'That line is not on this order.';
    if (d.qty > line.qty - line.received) return `Only ${line.qty - line.received} still to come on a line.`;
  }
  return null;
}

/** After a delivery: received once every line is complete, otherwise partially received. */
export function statusAfterDelivery(lines: readonly PoLine[]): PoStatus {
  return lines.every((l) => l.received >= l.qty) ? 'received' : 'partially_received';
}

/** Which moves an order may make from its current status. */
export function poCan(status: PoStatus, action: 'approve' | 'receive' | 'cancel'): boolean {
  switch (action) {
    case 'approve':
      return status === 'requested';
    case 'receive':
      return status === 'approved' || status === 'partially_received';
    case 'cancel':
      return status === 'requested' || status === 'approved' || status === 'partially_received';
  }
}
