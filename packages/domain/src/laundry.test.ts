import { describe, expect, it } from 'vitest';
import { laundryBreakdownProblem, laundryDaysPaidBefore, laundryTotal } from './laundry';
import { pesos } from './money';

const today = '2026-11-14';

describe('Laundry Breakdown', () => {
  it('pays the total of its days', () => {
    expect(laundryTotal([{ day: '2026-11-10', amount: pesos(180) }, { day: '2026-11-11', amount: pesos(220) }])).toBe(pesos(400));
  });

  it('covers the 14 days up to today, each day once, each with an amount', () => {
    expect(laundryBreakdownProblem([{ day: '2026-11-01', amount: pesos(100) }, { day: today, amount: pesos(100) }], today)).toBeNull();
    expect(laundryBreakdownProblem([], today)).toMatch(/at least one/);
    expect(laundryBreakdownProblem([{ day: '2026-10-31', amount: pesos(100) }], today)).toMatch(/14 days/);
    expect(laundryBreakdownProblem([{ day: '2026-11-15', amount: pesos(100) }], today)).toMatch(/hasn’t come/);
    expect(laundryBreakdownProblem([{ day: '2026-11-10', amount: pesos(100) }, { day: '2026-11-10', amount: pesos(50) }], today)).toMatch(/only once/);
    expect(laundryBreakdownProblem([{ day: '2026-11-10', amount: 0 }], today)).toMatch(/amount due/);
  });

  it('points out days an earlier payment already covered', () => {
    expect(laundryDaysPaidBefore([{ day: '2026-11-10', amount: 1 }, { day: '2026-11-11', amount: 1 }], ['2026-11-11'])).toEqual(['2026-11-11']);
  });
});
