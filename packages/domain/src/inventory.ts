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
