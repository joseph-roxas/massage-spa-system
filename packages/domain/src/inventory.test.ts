import { describe, expect, it } from 'vitest';
import {
  isLowStock,
  onHand,
  poCan,
  receiveProblem,
  receiveTurnoverProblem,
  statusAfterDelivery,
  stockLevels,
  stockOutProblem,
  takeOutProblem,
  turnoverProblem,
} from './inventory';

describe('on hand', () => {
  it('is everything in less everything out', () => {
    expect(onHand([{ qty: 4 }, { qty: 2 }], [{ qty: 1 }, { qty: 3 }])).toBe(2);
    expect(onHand([], [])).toBe(0);
  });

  it('is low at or below the reorder level, never with no level', () => {
    expect(isLowStock(2, 2)).toBe(true);
    expect(isLowStock(3, 2)).toBe(false);
    expect(isLowStock(0, 0)).toBe(false);
  });

  it('refuses taking out more than is on hand', () => {
    expect(stockOutProblem(2, 2)).toBeNull();
    expect(stockOutProblem(3, 2)).toBe('Only 2 on hand.');
    expect(stockOutProblem(1, 0)).toBe('None on hand.');
  });
});

describe('purchase orders', () => {
  const lines = [
    { id: 'a', qty: 4, received: 0 },
    { id: 'b', qty: 2, received: 1 },
  ];

  it('takes deliveries up to what is still to come', () => {
    expect(receiveProblem(lines, [{ lineId: 'a', qty: 4 }, { lineId: 'b', qty: 1 }])).toBeNull();
    expect(receiveProblem(lines, [{ lineId: 'b', qty: 2 }])).toBe('Only 1 still to come on a line.');
    expect(receiveProblem(lines, [{ lineId: 'a', qty: 0 }])).toBe('Enter at least one quantity received.');
    expect(receiveProblem(lines, [{ lineId: 'x', qty: 1 }])).toBe('That line is not on this order.');
  });

  it('is received once every line is complete', () => {
    expect(statusAfterDelivery([{ id: 'a', qty: 4, received: 4 }, { id: 'b', qty: 2, received: 1 }])).toBe('partially_received');
    expect(statusAfterDelivery([{ id: 'a', qty: 4, received: 4 }, { id: 'b', qty: 2, received: 2 }])).toBe('received');
  });

  it('moves requested → approved → received, and can be cancelled until fully received', () => {
    expect(poCan('requested', 'approve')).toBe(true);
    expect(poCan('requested', 'receive')).toBe(false);
    expect(poCan('approved', 'receive')).toBe(true);
    expect(poCan('partially_received', 'receive')).toBe(true);
    expect(poCan('partially_received', 'cancel')).toBe(true);
    expect(poCan('received', 'cancel')).toBe(false);
    expect(poCan('cancelled', 'approve')).toBe(false);
  });
});

describe('Storage and Shop Stock', () => {
  it('counts a Turnover in transit until received; a shortfall stays in Storage', () => {
    const base = { storageIns: 20, shopIns: 3, inTransit: 0, received: 0, storageOuts: 0, shopOuts: 1 };
    expect(stockLevels(base)).toEqual({ storage: 20, inTransit: 0, shop: 2 });
    expect(stockLevels({ ...base, inTransit: 10 })).toEqual({ storage: 10, inTransit: 10, shop: 2 });
    // 10 sent, 8 received: the 2 short are back in Storage.
    expect(stockLevels({ ...base, received: 8 })).toEqual({ storage: 12, inTransit: 0, shop: 10 });
  });

  it('uses only Consumables and discards only the rest', () => {
    expect(takeOutProblem('use', 'consumable', 2, 5)).toBeNull();
    expect(takeOutProblem('use', 'reusable', 1, 5)).toMatch(/Discard/);
    expect(takeOutProblem('discard', 'consumable', 1, 5)).toMatch(/used, not discarded/);
    expect(takeOutProblem('discard', 'equipment', 1, 1)).toBeNull();
    expect(takeOutProblem('discard', 'reusable', 3, 2)).toMatch(/Only 2 at the shop/);
  });

  it('sends only what Storage has, and receives no more than was sent', () => {
    expect(turnoverProblem(5, 5)).toBeNull();
    expect(turnoverProblem(6, 5)).toMatch(/Only 5 in storage/);
    expect(receiveTurnoverProblem(8, 10)).toBeNull();
    expect(receiveTurnoverProblem(11, 10)).toMatch(/Only 10/);
  });
});
