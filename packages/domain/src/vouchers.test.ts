import { describe, expect, it } from 'vitest';
import { quoteSale } from './pricing';
import { pesos } from './money';
import { bundleUse, cardSerial, compactSerial, normalizeSerial, parseCardNumbers, redemptionIsFree, redemptionProblem, voucherOrder } from './vouchers';

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
  it('prints the card number after the branch and Service code', () => {
    expect(cardSerial('NTL-SM', 271)).toBe('NTL-SM-0271');
    expect(cardSerial('NTL-TB', 9)).toBe('NTL-TB-0009');
  });

  it('matches a serial however it is typed', () => {
    for (const typed of ['NTL-SM-0271', 'NTLSM0271', 'ntl-sm 0271', ' ntl sm-0271 ']) expect(compactSerial(typed)).toBe('NTLSM0271');
    expect(normalizeSerial('  swe-7k3 m9p ')).toBe('SWE-7K3M9P');
  });

  it('reads card numbers and ranges', () => {
    expect(parseCardNumbers('271-273, 280 0275')).toEqual([271, 272, 273, 275, 280]);
    expect(parseCardNumbers('92-142')).toHaveLength(51);
    expect(parseCardNumbers('320-271')).toMatch(/not a valid range/);
    expect(parseCardNumbers('271-3200')).toMatch(/more than 500/);
    expect(parseCardNumbers('SM-271')).toMatch(/not a card number/);
    expect(parseCardNumbers('  ')).toMatch(/at least one/);
  });
});

describe('free Vouchers of a Bundle', () => {
  it('are the ones redeemed after all the paid ones, whichever serial', () => {
    const sold = { imported: false, isFree: false, qtyPaid: 10 };
    expect(redemptionIsFree({ ...sold, redeemedBefore: 9 })).toBe(false);
    expect(redemptionIsFree({ ...sold, redeemedBefore: 10 })).toBe(true);
    expect(redemptionIsFree({ ...sold, redeemedBefore: 11 })).toBe(true);
  });

  it('keep the flag entered for imported paper Vouchers', () => {
    expect(redemptionIsFree({ imported: true, isFree: true, qtyPaid: null, redeemedBefore: 0 })).toBe(true);
    expect(redemptionIsFree({ imported: true, isFree: false, qtyPaid: null, redeemedBefore: 0 })).toBe(false);
  });

  it('show in the order used', () => {
    const v = (serial: string, redeemedAt: string | null) => ({ serial, redeemedAt });
    const use = bundleUse(2, [v('A', '2026-11-03T10:00:00Z'), v('B', null), v('C', '2026-11-01T10:00:00Z'), v('D', '2026-11-04T10:00:00Z')]);
    expect(use.map((x) => [x.serial, x.free])).toEqual([
      ['C', false],
      ['A', false],
      ['D', true],
      ['B', false],
    ]);
  });
});

describe('redemption', () => {
  const unused = { serviceId: 'swedish-60', status: 'unused' as const };

  it('accepts an unused Voucher for its exact Service only', () => {
    expect(redemptionProblem(unused, 'swedish-60')).toBeNull();
    expect(redemptionProblem(unused, 'aroma-90')).toMatch(/different service/);
    expect(redemptionProblem({ ...unused, status: 'redeemed' }, 'swedish-60')).toMatch(/already been used/);
    expect(redemptionProblem({ ...unused, status: 'used_before_golive' }, 'swedish-60')).toMatch(/before the system started/);
    expect(redemptionProblem(null, 'swedish-60')).toMatch(/No voucher/);
    expect(redemptionProblem({ ...unused, status: 'in_shop' }, 'swedish-60')).toMatch(/never sold/);
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
    });

  it('covers the Service as a Prepaid FOC, excluding other Discounts', () => {
    const q = quote(false);
    expect(q.discount).toMatchObject({ type: 'voucher', amount: pesos(500) });
    expect(q).toMatchObject({ serviceAmount: 0, amountDue: 0, focKind: 'prepaid' });
  });

  it('makes a free Voucher a Real FOC', () => {
    expect(quote(true).focKind).toBe('real');
  });
});
