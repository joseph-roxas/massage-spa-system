import { describe, expect, it } from 'vitest';
import { autoClockOutAt } from './day-close';

describe('autoClockOutAt', () => {
  const entry = { businessDay: '2026-11-09', clockIn: '2026-11-09T06:09:00.000Z' };

  it('uses the Day Close time when the day was closed', () => {
    expect(autoClockOutAt(entry, '2026-11-09T15:40:00.000Z')).toBe('2026-11-09T15:40:00.000Z');
  });

  it('uses 11:00pm Manila when the day was never closed', () => {
    expect(autoClockOutAt(entry, null)).toBe('2026-11-09T15:00:00.000Z');
  });

  it('never ends before the clock-in, e.g. someone who clocked in after the close', () => {
    const late = { businessDay: '2026-11-09', clockIn: '2026-11-09T16:30:00.000Z' };
    expect(autoClockOutAt(late, '2026-11-09T15:40:00.000Z')).toBe(late.clockIn);
    expect(autoClockOutAt(late, null)).toBe(late.clockIn);
  });
});
