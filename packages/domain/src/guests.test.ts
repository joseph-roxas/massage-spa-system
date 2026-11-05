import { describe, expect, it } from 'vitest';
import { DEFAULT_REGULAR_RULE, maskId, visitStats } from './guests';

describe('Guest Visits', () => {
  it('counts each Business Day once and finds the last Visit', () => {
    const s = visitStats(['2026-10-01', '2026-10-01', '2026-10-15', '2026-11-04'], '2026-11-05', DEFAULT_REGULAR_RULE);
    expect(s).toMatchObject({ visits: 3, lastVisit: '2026-11-04', recentVisits: 3, isRegular: true });
    // 34 days over two gaps
    expect(s.avgDaysBetween).toBe(17);
  });

  it('is a Regular only with enough Visits inside the window', () => {
    // 2026-08-07 is exactly 90 days back: outside the window.
    const s = visitStats(['2026-08-07', '2026-09-01', '2026-11-01'], '2026-11-05', DEFAULT_REGULAR_RULE);
    expect(s).toMatchObject({ visits: 3, recentVisits: 2, isRegular: false });
    expect(visitStats(['2026-08-08', '2026-09-01', '2026-11-01'], '2026-11-05', DEFAULT_REGULAR_RULE).isRegular).toBe(true);
    expect(visitStats(['2026-11-01'], '2026-11-05', { visits: 1, days: 30 }).isRegular).toBe(true);
  });

  it('has no average with fewer than two Visits', () => {
    expect(visitStats([], '2026-11-05', DEFAULT_REGULAR_RULE)).toEqual({ visits: 0, lastVisit: null, recentVisits: 0, isRegular: false, avgDaysBetween: null });
    expect(visitStats(['2026-11-01'], '2026-11-05', DEFAULT_REGULAR_RULE).avgDaysBetween).toBeNull();
  });

  it('masks a saved ID to its last four characters', () => {
    expect(maskId('SC-2019 004821')).toBe('••••4821');
    expect(maskId(null)).toBeNull();
  });
});
