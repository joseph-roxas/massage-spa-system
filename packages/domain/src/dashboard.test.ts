import { describe, expect, it } from 'vitest';
import { consumablesTrend, daysIn, projected, shiftMonth, weekdayAverages } from './dashboard';

describe('Dashboard figures', () => {
  it('projects so far plus the daily average for the rest', () => {
    expect(projected(100_000, 10, 30)).toBe(300_000);
    expect(projected(100_000, 30, 30)).toBe(100_000);
    expect(projected(100_000, 0, 30)).toBe(100_000);
  });
  it('counts days and moves between months across a year', () => {
    expect(daysIn('2026-10-01', '2026-12-31')).toBe(92);
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', 2)).toBe('2027-01');
  });
  it('averages Guests by weekday, Monday first', () => {
    // Nov 2 and 9, 2026 are Mondays; Nov 8 is a Sunday.
    const rows = weekdayAverages([
      { date: '2026-11-02', guests: 10 },
      { date: '2026-11-09', guests: 15 },
      { date: '2026-11-08', guests: 30 },
    ]);
    expect(rows[0]).toEqual({ day: 'Mon', average: 12.5 });
    expect(rows[6]).toEqual({ day: 'Sun', average: 30 });
    expect(rows[1]).toEqual({ day: 'Tue', average: 0 });
  });
  it('builds a baseline until a full month exists', () => {
    expect(consumablesTrend(5000, [])).toEqual({ status: 'building', perGuest: 5000 });
  });
  it('flags consumables only above 20% over the average', () => {
    expect(consumablesTrend(12_000, [10_000, 10_000])).toMatchObject({ status: 'normal', average: 10_000, changeBp: 2000 });
    expect(consumablesTrend(12_100, [10_000, 10_000])).toMatchObject({ status: 'high', changeBp: 2100 });
    expect(consumablesTrend(8000, [10_000])).toMatchObject({ status: 'normal', changeBp: -2000 });
  });
});
