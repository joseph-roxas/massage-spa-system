import { describe, expect, it } from 'vitest';
import { certificateStatus, govIdWarning, isBirthday, lmtProblem } from './staff';

describe('government ID numbers', () => {
  it('warns on the wrong number of digits, ignoring dashes and spaces', () => {
    expect(govIdWarning('sss', '34-1234567-8')).toBeNull();
    expect(govIdWarning('sss', '34-123456-8')).toMatch(/SSS numbers have 10 digits; this has 9/);
    expect(govIdWarning('phic', '12-345678901-2')).toBeNull();
    expect(govIdWarning('pagibig', '1234-5678-9012')).toBeNull();
    expect(govIdWarning('tin', '123-456-789')).toBeNull();
    expect(govIdWarning('tin', '123-456-789-000')).toBeNull();
    expect(govIdWarning('tin', '123-456-78')).toMatch(/9 or 12 digits/);
    expect(govIdWarning('sss', '')).toBeNull();
  });
});

describe('Certificates', () => {
  it('are flagged 60 days before they expire', () => {
    expect(certificateStatus('2027-03-01', '2026-11-04')).toEqual({ status: 'valid', daysLeft: 117 });
    expect(certificateStatus('2027-01-03', '2026-11-04')).toEqual({ status: 'expiring', daysLeft: 60 });
    expect(certificateStatus('2026-11-03', '2026-11-04')).toEqual({ status: 'expired', daysLeft: -1 });
    expect(certificateStatus(null, '2026-11-04').status).toBe('no_expiry');
  });
});

describe('LMT', () => {
  it('needs a DOH licence', () => {
    expect(lmtProblem('lmt', 'doh')).toBeNull();
    expect(lmtProblem('lmt', 'nc2')).toMatch(/DOH-licensed/);
    expect(lmtProblem('lmt', null)).toMatch(/DOH-licensed/);
    expect(lmtProblem('regular', 'doh')).toBeNull();
  });
});

describe('isBirthday', () => {
  it('matches month and day, whatever the year', () => {
    expect(isBirthday('1995-11-05', '2026-11-05')).toBe(true);
    expect(isBirthday('1995-11-06', '2026-11-05')).toBe(false);
    expect(isBirthday(null, '2026-11-05')).toBe(false);
  });
  it('celebrates a 29 February birthday on the 28th outside leap years', () => {
    expect(isBirthday('2000-02-29', '2027-02-28')).toBe(true);
    expect(isBirthday('2000-02-29', '2028-02-28')).toBe(false);
    expect(isBirthday('2000-02-29', '2028-02-29')).toBe(true);
  });
});
