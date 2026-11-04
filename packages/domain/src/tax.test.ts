import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTRIBUTION_RATES as R, monthlyContributions, payWeekEndsIn, sssMsc, weeklyPart } from './contributions';
import { pesos } from './money';
import { daysUntil, incomeStatement, percentageTax, percentageTaxDue, previousQuarter, quarterOf, quarterRange } from './tax';

const ALL = { sss: true, phic: true, pagibig: true };

describe('employer and employee contributions', () => {
  it('match the owner’s figures for a therapist on ₱8,000', () => {
    const c = monthlyContributions(pesos(8000), R, ALL);
    expect(c.sss).toEqual({ ee: pesos(400), er: pesos(810) });
    expect(c.phic).toEqual({ ee: pesos(250), er: pesos(250) }); // ₱10,000 floor
    expect(c.pagibig).toEqual({ ee: pesos(160), er: pesos(160) });
    expect(c.er).toBe(pesos(1220));
  });

  it('match the owner’s figures for the receptionist on ₱16,900', () => {
    const c = monthlyContributions(pesos(16900), R, ALL);
    expect(c.sss).toEqual({ ee: pesos(850), er: pesos(1730) }); // MSC ₱17,000, EC ₱30
    expect(c.phic).toEqual({ ee: 42250, er: 42250 });
    expect(c.pagibig).toEqual({ ee: pesos(200), er: pesos(200) }); // fund salary capped at ₱10,000
    expect(c.er).toBe(235250);
  });

  it('rounds the SSS salary credit to the ₱500 bracket within ₱5,000–₱35,000', () => {
    expect(sssMsc(pesos(16749), R.sss)).toBe(pesos(16500));
    expect(sssMsc(pesos(16750), R.sss)).toBe(pesos(17000));
    expect(sssMsc(pesos(3000), R.sss)).toBe(pesos(5000));
    expect(sssMsc(pesos(90000), R.sss)).toBe(pesos(35000));
  });

  it('leaves out an agency whose ID number is not on file', () => {
    const c = monthlyContributions(pesos(8000), R, { sss: false, phic: true, pagibig: false });
    expect(c).toMatchObject({ ee: pesos(250), er: pesos(250) });
  });

  it('splits a month evenly over the Pay Weeks ending in it, adding up exactly', () => {
    expect(payWeekEndsIn('2026-10')).toEqual(['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']);
    const parts = payWeekEndsIn('2026-10').map((d) => weeklyPart(pesos(810), d));
    expect(parts).toEqual([16200, 16200, 16200, 16200, 16200]);
    const nov = payWeekEndsIn('2026-11').map((d) => weeklyPart(42250, d));
    expect(nov).toEqual([10562, 10562, 10562, 10564]);
    expect(nov.reduce((a, b) => a + b, 0)).toBe(42250);
  });
});

describe('Percentage Tax (2551Q)', () => {
  it('is 3% of the quarter’s gross sales', () => {
    expect(percentageTax(pesos(300000))).toBe(pesos(9000));
  });

  it('knows its quarter', () => {
    expect(quarterOf('2026-11-04')).toBe('2026-Q4');
    expect(quarterRange('2026-Q3')).toEqual({ start: '2026-07-01', end: '2026-09-30' });
    expect(previousQuarter('2026-Q1')).toBe('2025-Q4');
  });

  it('is due 25 days after the quarter, moved past weekends and Holidays', () => {
    expect(percentageTaxDue('2026-Q2')).toBe('2026-07-27'); // the 25th is a Saturday
    expect(percentageTaxDue('2026-Q3')).toBe('2026-10-26'); // the 25th is a Sunday
    expect(percentageTaxDue('2026-Q1', new Set(['2026-04-27']))).toBe('2026-04-28');
    expect(daysUntil('2026-10-26', '2026-11-04')).toBe(-9);
  });
});

describe('Income Statement', () => {
  it('is revenue less every cost', () => {
    const s = incomeStatement(
      [
        { label: 'Services', amount: pesos(100000) },
        { label: 'Add-ons', amount: pesos(0) },
      ],
      [
        { label: 'Commission', amount: pesos(35000) },
        { label: 'Laundry', amount: pesos(5000) },
      ],
    );
    expect(s).toMatchObject({ revenueTotal: pesos(100000), costTotal: pesos(40000), net: pesos(60000) });
    expect(s.revenue).toHaveLength(1);
  });
});
