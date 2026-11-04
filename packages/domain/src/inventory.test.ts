import { describe, expect, it } from 'vitest';
import { isLowStock, onHand, poCan, receiveProblem, statusAfterDelivery, stockOutProblem } from './inventory';

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
