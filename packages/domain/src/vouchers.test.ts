import { describe, expect, it } from 'vitest';
import { quoteSale } from './pricing';
import { pesos } from './money';
import { newSerial, normalizeSerial, redemptionProblem, voucherOrder } from './vouchers';

describe('voucherOrder', () => {
  it.each([
    [1, 0],
    [4, 0],
    [5, 1],
    [9, 1],
    [10, 2],
  ])('buying %i earns %i free', (qty, free) => {
    expect(voucherOrder(pesos(500), qty)).toEqual({ paid: qty, free, total: pesos(500 * qty) });
  });
});

describe('serials', () => {
  it('builds a readable serial from the Service code', () => {
    expect(newSerial('swe', new Uint8Array([0, 1, 2, 3, 4, 30, 99]))).toBe('SWE-23456Z');
    expect(newSerial('SWE', new Uint8Array(6)).length).toBe('SWE-'.length + 6);
  });

  it('ignores case and spaces when typed back in', () => {
    expect(normalizeSerial('  swe-7k3 m9p ')).toBe('SWE-7K3M9P');
  });
});

describe('redemption', () => {
  const unused = { serviceId: 'swedish-60', status: 'unused' as const };

  it('accepts an unused Voucher for its exact Service only', () => {
    expect(redemptionProblem(unused, 'swedish-60')).toBeNull();
    expect(redemptionProblem(unused, 'aroma-90')).toMatch(/different service/);
    expect(redemptionProblem({ ...unused, status: 'redeemed' }, 'swedish-60')).toMatch(/already been used/);
    expect(redemptionProblem(null, 'swedish-60')).toMatch(/No voucher/);
  });

  const quote = (isFree: boolean) =>
    quoteSale({
      serviceId: 'swedish-60',
      regularPrice: pesos(500),
      startDate: '2026-11-03',
      startTime: '15:00',
      promos: [],
      statutory: 'senior',
      voucher: { serial: 'SWE-AAAAAA', isFree },
      addonPrices: [pesos(50)],
    });

  it('covers the Service as a Prepaid FOC, excluding other Discounts; Add-ons are still paid', () => {
    const q = quote(false);
    expect(q.discount).toMatchObject({ type: 'voucher', amount: pesos(500) });
    expect(q).toMatchObject({ serviceAmount: 0, amountDue: pesos(50), focKind: 'prepaid' });
  });

  it('makes the free sixth Voucher a Real FOC', () => {
    expect(quote(true).focKind).toBe('real');
  });
});
