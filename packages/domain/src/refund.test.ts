import { describe, expect, it } from 'vitest';
import type { IsoDate } from './calendar';
import { DEFAULT_REFUND_PLAN, refundChecklist } from './refund';

const base = { plan: DEFAULT_REFUND_PLAN, novemberFinal: false, entered: 0, eligible: 9, payrolls: [] as ('draft' | 'approved' | 'released' | null)[] };
const on = (today: string, more: Partial<typeof base> = {}) => refundChecklist({ ...base, ...more, today: today as IsoDate });

describe('Government Deduction Refund reminder', () => {
  it('starts two weeks before payout', () => {
    expect(on('2026-11-27')).toMatchObject({ remindFrom: '2026-11-28', remind: false });
    expect(on('2026-11-28')).toMatchObject({ remind: true, urgent: false, daysLeft: 14, done: 0 });
    expect(on('2026-12-10')).toMatchObject({ remind: true, urgent: true });
  });

  it('ticks the steps the Payrolls show, and the ones the Super Admin ticks', () => {
    const c = on('2026-12-01', { novemberFinal: true, entered: 3, plan: { ...DEFAULT_REFUND_PLAN, ticked: ['opening-weeks', 'recompute'] }, payrolls: ['draft', null, 'approved'] });
    expect(c.steps.filter((s) => s.done).map((s) => s.key)).toEqual(['november-final', 'opening-weeks', 'recompute']);
    expect(c.steps.find((s) => s.key === 'entered')).toMatchObject({ done: false, progress: '3 of 9 entered' });
  });

  it('stays up, even past payout, until every Payroll with a refund is released', () => {
    expect(on('2026-12-20', { entered: 9, payrolls: ['released', 'approved'] })).toMatchObject({ remind: true, finished: false });
    const done = on('2026-12-20', { entered: 9, payrolls: ['released', 'released'] });
    expect(done).toMatchObject({ remind: false, finished: true });
    expect(done.steps.find((s) => s.key === 'entered')?.done).toBe(true);
  });

  it('is not finished before any refund is entered', () => {
    expect(on('2026-12-20', { payrolls: [] })).toMatchObject({ finished: false, remind: true });
  });
});
