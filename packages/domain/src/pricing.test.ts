import type { Centavos } from './money';
import { describe, expect, it } from 'vitest';
import { commissionFor, paymentProblem, quoteSale, type QuoteInput, splitPayments } from './pricing';
import { dayTotals, onCallOwed } from './day-close';
import { pesos } from './money';

const happyHours = {
  id: 'hh',
  name: 'Happy Hours',
  serviceId: 'swedish-60',
  percentBp: 1000,
  startTime: '14:00',
  endTime: '18:00',
  validFrom: '2026-01-01',
  validTo: '2026-11-30',
  active: true,
};

const swedish = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  serviceId: 'swedish-60',
  regularPrice: pesos(500),
  startDate: '2026-11-03',
  startTime: '15:00',
  promos: [happyHours],
  ...over,
});

describe('quoteSale', () => {
  it.each([
    ['13:59', 0],
    ['14:00', pesos(50)],
    ['17:59', pesos(50)],
    ['18:00', 0],
  ])('applies Happy Hours by start time %s', (startTime, discount) => {
    expect(quoteSale(swedish({ startTime })).discount.amount).toBe(discount);
  });

  it('ends Happy Hours after 2026-11-30', () => {
    expect(quoteSale(swedish({ startDate: '2026-11-30' })).discount.type).toBe('promo');
    expect(quoteSale(swedish({ startDate: '2026-12-01' })).discount.type).toBe('none');
  });

  it('gives only the largest Discount: Statutory 20% beats the 10% Promo', () => {
    const q = quoteSale(swedish({ statutory: 'senior' }));
    expect(q.discount).toMatchObject({ type: 'senior', bp: 2000, amount: pesos(100) });
    expect(q.serviceAmount).toBe(pesos(400));
  });

  it('prefers the Statutory Discount on a tie', () => {
    const big = { ...happyHours, percentBp: 2000 };
    expect(quoteSale(swedish({ promos: [big], statutory: 'pwd' })).discount.type).toBe('pwd');
  });

  it('applies only the Promo picked at checkout, or none', () => {
    expect(quoteSale(swedish({ promoId: 'hh' })).discount).toMatchObject({ type: 'promo', promoId: 'hh', amount: pesos(50) });
    expect(quoteSale(swedish({ promoId: null })).discount.type).toBe('none');
    expect(quoteSale(swedish({ promoId: 'hh', startTime: '19:00' })).discount.type).toBe('none');
    expect(quoteSale(swedish({ promoId: 'other' })).discount.type).toBe('none');
  });

  it('gives the Statutory Discount when it is picked instead of a Promo', () => {
    const big = { ...happyHours, percentBp: 3000 };
    expect(quoteSale(swedish({ promos: [big], promoId: null, statutory: 'senior' })).discount).toMatchObject({ type: 'senior', bp: 2000 });
  });

  it('charges the Service after its Discount', () => {
    expect(quoteSale(swedish({ statutory: 'pwd' }))).toMatchObject({ serviceAmount: pesos(400), amountDue: pesos(400) });
  });

  describe('with Top-ups', () => {
    const topped = (extra: Partial<QuoteInput>) => quoteSale(swedish({ topUpsTotal: pesos(250), ...extra }));

    it('takes Senior/PWD off the whole bill', () => {
      expect(topped({ statutory: 'senior' })).toMatchObject({ discount: { amount: pesos(150) }, amountDue: pesos(600) });
    });

    it('takes a Promo off the original Service only', () => {
      expect(topped({ promos: [{ ...happyHours, percentBp: 1000 }] })).toMatchObject({ discount: { type: 'promo', amount: pesos(50) }, amountDue: pesos(700) });
    });

    it('has the Guest pay Top-ups on a Voucher', () => {
      expect(topped({ promos: [], voucher: { serial: 'X', isFree: false } })).toMatchObject({ discount: { amount: pesos(500) }, amountDue: pesos(250), focKind: 'prepaid' });
    });

    it('covers everything when Complimentary', () => {
      expect(topped({ complimentary: true })).toMatchObject({ discount: { amount: pesos(750) }, amountDue: 0 });
    });
  });

  it('makes a Complimentary Service a Real FOC', () => {
    const q = quoteSale(swedish({ complimentary: true, statutory: 'senior' }));
    expect(q.discount).toMatchObject({ type: 'complimentary', amount: pesos(500) });
    expect(q).toMatchObject({ serviceAmount: 0, amountDue: 0, focKind: 'real' });
  });

  it('ignores Promos for other Services', () => {
    expect(quoteSale(swedish({ serviceId: 'thai-60' })).discount.type).toBe('none');
  });
});

describe('commissionFor', () => {
  const regular = { therapistClass: 'regular' as const, normalBp: 3000, holidayBp: 5000, effectiveFrom: '2026-01-01' };
  const lmt = { therapistClass: 'lmt' as const, normalBp: 4000, holidayBp: 6000, effectiveFrom: '2026-01-01' };

  it('uses the Regular Price at the normal or holiday rate', () => {
    expect(commissionFor(pesos(500), regular, false)).toEqual({ bp: 3000, amount: pesos(150) });
    expect(commissionFor(pesos(500), regular, true)).toEqual({ bp: 5000, amount: pesos(250) });
    expect(commissionFor(pesos(750), lmt, false).amount).toBe(pesos(300));
    expect(commissionFor(pesos(750), lmt, true).amount).toBe(pesos(450));
  });

  it('takes the Owner’s Set-aside off first', () => {
    expect(commissionFor(pesos(700), regular, false, pesos(50))).toEqual({ bp: 3000, amount: pesos(195) });
    expect(commissionFor(pesos(700), lmt, false, pesos(50)).amount).toBe(pesos(260));
    expect(commissionFor(pesos(700), regular, true, pesos(50)).amount).toBe(pesos(325));
    expect(commissionFor(pesos(700), lmt, true, pesos(50)).amount).toBe(pesos(390));
  });
});

describe('paymentProblem', () => {
  it('accepts a Cash and GCash split that adds up', () => {
    expect(paymentProblem(pesos(450), [
      { method: 'cash', amount: pesos(200) },
      { method: 'gcash', amount: pesos(250), gcashRef: '1009 223 4456' },
    ])).toBeNull();
  });

  it('needs a GCash reference', () => {
    expect(paymentProblem(pesos(450), [{ method: 'gcash', amount: pesos(450) }])).toMatch(/reference/);
  });

  it('must match the amount due exactly', () => {
    expect(paymentProblem(pesos(450), [{ method: 'cash', amount: pesos(500) }])).toMatch(/add up/);
    expect(paymentProblem(pesos(450), [])).toMatch(/how the Guest paid/);
  });

  it('records nothing when nothing is due', () => {
    expect(paymentProblem(0 as never, [])).toBeNull();
    expect(paymentProblem(0 as never, [{ method: 'cash', amount: pesos(1) }])).not.toBeNull();
  });
});

describe('Day Close totals', () => {
  it('expects cash received less Cash-outs in the drawer', () => {
    const t = dayTotals(
      [
        { method: 'cash', amount: pesos(900) },
        { method: 'gcash', amount: pesos(450) },
        { method: 'cash', amount: pesos(500) },
      ],
      [{ amount: pesos(150) }],
    );
    expect(t).toEqual({ carriedIn: 0, transfersOut: 0, cashIn: pesos(1400), gcashIn: pesos(450), cashOut: pesos(150), expectedCash: pesos(1250), expectedGcash: pesos(450) });
  });

  it('owes On-call Therapists their Commission less what was already paid', () => {
    expect(
      onCallOwed(
        [
          { staffId: 'a', amount: pesos(150) },
          { staffId: 'a', amount: pesos(210) },
          { staffId: 'b', amount: pesos(150) },
        ],
        [{ staffId: 'b', amount: pesos(150) }],
      ),
    ).toEqual([{ staffId: 'a', amount: pesos(360) }]);
  });
});

describe('splitPayments', () => {
  const c = (n: number) => n as Centavos;
  it('fills each Sale of a stay in order from the payment lines', () => {
    const split = splitPayments([c(50000), c(25000)], [
      { method: 'cash', amount: c(60000) },
      { method: 'gcash', amount: c(15000), gcashRef: 'R1' },
    ]);
    expect(split).toEqual([
      [{ method: 'cash', amount: 50000 }],
      [
        { method: 'cash', amount: 10000 },
        { method: 'gcash', amount: 15000, gcashRef: 'R1' },
      ],
    ]);
  });
  it('gives nothing to a Sale that owes nothing', () => {
    expect(splitPayments([c(0), c(45000)], [{ method: 'cash', amount: c(45000) }])).toEqual([[], [{ method: 'cash', amount: 45000 }]]);
  });
});
