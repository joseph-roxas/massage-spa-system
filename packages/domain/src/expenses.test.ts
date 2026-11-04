import { describe, expect, it } from 'vitest';
import { isMonth, monthRange, previousMonth, recurringDate, royaltyAmount, royaltyGross } from './expenses';

describe('months', () => {
  it('knows each month’s first and last day', () => {
    expect(monthRange('2026-11')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthRange('2026-12').end).toBe('2026-12-31');
  });
  it('steps back across New Year', () => {
    expect(previousMonth('2027-01')).toBe('2026-12');
    expect(previousMonth('2026-11')).toBe('2026-10');
  });
  it('validates YYYY-MM', () => {
    expect(isMonth('2026-11')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
  });
  it('puts a day-31 expense on the month’s last day', () => {
    expect(recurringDate('2026-11', 31)).toBe('2026-11-30');
    expect(recurringDate('2026-11', 5)).toBe('2026-11-05');
  });
});

describe('royalty', () => {
  it('counts Service payments after Discounts plus Vouchers sold', () => {
    // ₱500 regular, ₱400 Senior, ₱0 Voucher Redemption, ₱0 Complimentary; one 5+1 bundle sold.
    expect(royaltyGross([50_000, 40_000, 0, 0], [250_000])).toBe(340_000);
  });
  it('is 3% rounded to the centavo', () => {
    expect(royaltyAmount(340_000, 300)).toBe(10_200);
    expect(royaltyAmount(12_345, 300)).toBe(370);
  });
});
