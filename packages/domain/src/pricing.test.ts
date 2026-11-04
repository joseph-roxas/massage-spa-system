import { describe, expect, it } from 'vitest';
import { commissionFor, paymentProblem, quoteSale, type QuoteInput } from './pricing';
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

  it('adds Add-ons on top, undiscounted', () => {
    const q = quoteSale(swedish({ statutory: 'pwd', addonPrices: [pesos(50)] }));
    expect(q).toMatchObject({ serviceAmount: pesos(400), addonsTotal: pesos(50), amountDue: pesos(450) });
  });

  it('makes a Complimentary Service a Real FOC, but Add-ons are still paid', () => {
    const q = quoteSale(swedish({ complimentary: true, statutory: 'senior', addonPrices: [pesos(50)] }));
    expect(q.discount).toMatchObject({ type: 'complimentary', amount: pesos(500) });
    expect(q).toMatchObject({ serviceAmount: 0, amountDue: pesos(50), focKind: 'real' });
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
    expect(t).toEqual({ cashIn: pesos(1400), gcashIn: pesos(450), cashOut: pesos(150), expectedCash: pesos(1250), expectedGcash: pesos(450) });
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
