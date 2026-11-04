import { describe, expect, it } from 'vitest';
import { isHhMm, isIsoDate, toManila } from './calendar';
import { commissionRateOn, effectiveOn, promoApplies, promoProblem, type CommissionRate, type Promo } from './catalogue';
import { pesos } from './money';

describe('effectiveOn', () => {
  const prices = [
    { effectiveFrom: '2026-01-01', regularPrice: pesos(500) },
    { effectiveFrom: '2027-01-01', regularPrice: pesos(550) },
  ];

  it('uses the latest entry already in force', () => {
    expect(effectiveOn(prices, '2026-12-31')?.regularPrice).toBe(pesos(500));
    expect(effectiveOn(prices, '2027-01-01')?.regularPrice).toBe(pesos(550));
  });

  it('has nothing before the first entry', () => {
    expect(effectiveOn(prices, '2025-12-31')).toBeUndefined();
  });

  it('does not depend on input order', () => {
    expect(effectiveOn([...prices].reverse(), '2027-06-01')?.regularPrice).toBe(pesos(550));
  });
});

describe('commissionRateOn', () => {
  const rates: CommissionRate[] = [
    { therapistClass: 'regular', normalBp: 3000, holidayBp: 5000, effectiveFrom: '2020-01-01' },
    { therapistClass: 'lmt', normalBp: 4000, holidayBp: 6000, effectiveFrom: '2020-01-01' },
  ];

  it('picks the rate for the therapist class', () => {
    expect(commissionRateOn(rates, 'regular', '2026-11-03')?.normalBp).toBe(3000);
    expect(commissionRateOn(rates, 'lmt', '2026-11-03')?.holidayBp).toBe(6000);
  });
});

describe('promoApplies (Happy Hours)', () => {
  const happyHours: Promo = {
    serviceId: 'swedish-60',
    percentBp: 1000,
    startTime: '14:00',
    endTime: '18:00',
    validFrom: '2026-01-01',
    validTo: '2026-11-30',
    active: true,
  };
  const at = (startDate: string, startTime: string, serviceId = 'swedish-60') =>
    promoApplies(happyHours, { serviceId, startDate, startTime });

  it('covers starts from 2:00pm up to 5:59pm', () => {
    expect(at('2026-11-03', '13:59')).toBe(false);
    expect(at('2026-11-03', '14:00')).toBe(true);
    expect(at('2026-11-03', '17:59')).toBe(true);
    expect(at('2026-11-03', '18:00')).toBe(false);
  });

  it('runs through November 30, 2026 only', () => {
    expect(at('2026-11-30', '15:00')).toBe(true);
    expect(at('2026-12-01', '15:00')).toBe(false);
  });

  it('applies only to its Service and only while active', () => {
    expect(at('2026-11-03', '15:00', 'thai-60')).toBe(false);
    expect(promoApplies({ ...happyHours, active: false }, { serviceId: 'swedish-60', startDate: '2026-11-03', startTime: '15:00' })).toBe(false);
  });
});

describe('promoProblem', () => {
  const happyHours = {
    serviceId: 'swedish-60',
    serviceName: 'Swedish Massage (1hr)',
    percentBp: 1000,
    startTime: '14:00',
    endTime: '18:00',
    validFrom: '2026-01-01',
    validTo: '2026-11-30',
    active: true,
  };
  const at = (startDate: string, startTime: string, serviceId = 'swedish-60') => promoProblem(happyHours, { serviceId, startDate, startTime });

  it('says why Happy Hours does not apply', () => {
    expect(at('2026-11-03', '15:00')).toBeNull();
    expect(at('2026-11-03', '15:00', 'thai-60')).toBe('Only for Swedish Massage (1hr)');
    expect(at('2026-11-03', '18:00')).toBe('Only for services starting 2:00pm–6:00pm');
    expect(at('2026-12-01', '15:00')).toBe('Ended 2026-11-30');
    expect(at('2025-12-31', '15:00')).toBe('Starts 2026-01-01');
    expect(promoProblem({ ...happyHours, active: false }, { serviceId: 'swedish-60', startDate: '2026-11-03', startTime: '15:00' })).toBe('Not running');
  });
});

describe('calendar', () => {
  it('converts an instant to Manila wall-clock time', () => {
    // 2026-11-03 18:30 UTC is 2026-11-04 02:30 in Manila, a Wednesday
    expect(toManila(new Date('2026-11-03T18:30:00Z'))).toEqual({ date: '2026-11-04', time: '02:30', weekday: 3 });
  });

  it('validates dates and times', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isHhMm('23:59')).toBe(true);
    expect(isHhMm('24:00')).toBe(false);
  });
});
