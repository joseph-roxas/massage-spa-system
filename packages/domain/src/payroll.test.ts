import { describe, expect, it } from 'vitest';
import { manilaInstant } from './business-day';
import {
  refundSplit,
  cashAdvanceCap,
  caRepaymentFor,
  dayKind,
  lastCompletedPayWeek,
  nextPayWeekStart,
  payLines,
  payWeekOf,
  receptionistDay,
  receptionistPayroll,
  reliefDay,
  therapistPayroll,
  deferDeductions,
  openingWeeks,
  payPeriodRange,
  payWeekMiddle,
  weekNumber,
  weeksOwed,
  weekKindsOf,
  thirteenthMonth,
  bonusDeduction,
  bonusPeriod,
  suggestBonus,
  yearEndBonus,
  type ReceptionistRules,
} from './payroll';

const RULES: ReceptionistRules = {
  shift: { start: '14:00', end: '23:00', mealBreakMin: 60 },
  restWeekday: 0,
  premiums: {
    ordinary: { workedPct: 100, otPct: 125 },
    restDay: { workedPct: 130, otPct: 169 },
    special: { workedPct: 130, otPct: 169 },
    specialOnRestDay: { workedPct: 150, otPct: 195 },
    regular: { workedPct: 200, otPct: 260 },
    regularOnRestDay: { workedPct: 260, otPct: 338 },
    regularUnworkedPct: 100,
  },
};
const RATE = 69_200;
const GOV = { sss: 21_250, phic: 10_563, pagibig: 5_000 };

/** A punch pair on `date`; an `out` before 06:00 is after midnight. */
function shift(date: string, inAt: string, outAt: string) {
  const clockIn = manilaInstant(date, inAt);
  let clockOut = manilaInstant(date, outAt);
  if (clockOut < clockIn) clockOut = new Date(+clockOut + 86_400_000);
  return { clockIn, clockOut };
}

const day = (date: string, entries: ReturnType<typeof shift>[], extra: { holiday?: 'regular' | 'special'; earlyClose?: string } = {}) =>
  receptionistDay({
    date,
    holiday: extra.holiday ?? null,
    entries,
    earlyCloseAt: extra.earlyClose ? manilaInstant(date, extra.earlyClose) : null,
    dailyRate: RATE,
    rules: RULES,
  });

describe('Pay Week', () => {
  it('runs Sunday to Saturday', () => {
    expect(payWeekOf('2026-11-04')).toEqual({ start: '2026-11-01', end: '2026-11-07' });
    expect(payWeekOf('2026-11-01')).toEqual({ start: '2026-11-01', end: '2026-11-07' });
    expect(payWeekOf('2026-11-07')).toEqual({ start: '2026-11-01', end: '2026-11-07' });
  });
  it('goes live on the next Sunday', () => {
    expect(nextPayWeekStart('2026-11-04')).toBe('2026-11-08');
    expect(nextPayWeekStart('2026-11-08')).toBe('2026-11-08');
    expect(nextPayWeekStart('2026-11-07')).toBe('2026-11-08');
  });
  it('last completed week is the one before', () => {
    expect(lastCompletedPayWeek('2026-11-04')).toEqual({ start: '2026-10-25', end: '2026-10-31' });
    expect(lastCompletedPayWeek('2026-11-01')).toEqual({ start: '2026-10-25', end: '2026-10-31' });
  });
});

describe('therapist payroll', () => {
  const week = payWeekOf('2026-11-01');
  const tGov = { sss: 10_000, phic: 6_250, pagibig: 4_000 };

  it('sums commission and withholds government shares and CAs', () => {
    const p = therapistPayroll({
      week,
      commissions: [
        { businessDay: '2026-11-02', amount: 15_000 },
        { businessDay: '2026-11-02', amount: 21_000 },
        { businessDay: '2026-11-05', amount: 30_000 },
      ],
      daysWorked: ['2026-11-02', '2026-11-05'],
      gov: tGov,
      cashAdvances: 20_000,
    });
    expect(p.gross).toBe(66_000);
    expect(p.net).toBe(66_000 - 20_250 - 20_000);
    expect(p.days.find((d) => d.date === '2026-11-02')).toEqual({ date: '2026-11-02', services: 2, commission: 36_000, holidayExtra: 0 });
  });

  it('adds Adjustments to gross and splits out the Holiday extra on the Payslip', () => {
    const p = therapistPayroll({
      week,
      // ₱500 Service: 30% normally, 50% on the Holiday.
      commissions: [
        { businessDay: '2026-11-02', amount: 15_000 },
        { businessDay: '2026-11-03', amount: 25_000, holidayExtra: 10_000 },
      ],
      daysWorked: ['2026-11-02', '2026-11-03'],
      gov: tGov,
      cashAdvances: 5_000,
      adjustments: -2_000,
    });
    expect(p.gross).toBe(38_000);
    expect(p.net).toBe(38_000 - 20_250 - 5_000);
    const lines = payLines({ kind: 'therapist', ...p, adjustments: -2_000 });
    expect(lines.earnings).toMatchObject({ commission: 30_000, holidayExtra: 10_000, adjustments: -2_000 });
    expect(lines.deductions).toMatchObject({ sss: 10_000, phic: 6_250, pagibig: 4_000, ca: 5_000, late: 0 });
    expect(lines.totalEarned - lines.totalDeductions).toBe(p.net);
  });

  it('withholds nothing in a week not worked', () => {
    const p = therapistPayroll({ week, commissions: [], daysWorked: [], gov: tGov, cashAdvances: 0 });
    expect(p).toMatchObject({ gross: 0, govSss: 0, govPhic: 0, govPagibig: 0, net: 0 });
  });

  it('keeps a week away on the balance, taking nothing from pay', () => {
    const p = therapistPayroll({ week, commissions: [], daysWorked: [], gov: tGov, cashAdvances: 0, deferral: { balance: 0, floor: 100_000, owesWhenAway: true } });
    expect(p).toMatchObject({ gross: 0, govDeferred: tGov.sss + tGov.phic + tGov.pagibig, govCollected: 0, net: 0 });
  });

  it('owes nothing for a week after leaving or before starting', () => {
    const p = therapistPayroll({ week, commissions: [], daysWorked: [], gov: tGov, cashAdvances: 0, deferral: { balance: 0, floor: 100_000, owesWhenAway: false } });
    expect(p).toMatchObject({ govSss: 0, govDeferred: 0, net: 0 });
  });

  it('counts a day clocked in with no guests as worked', () => {
    const p = therapistPayroll({ week, commissions: [], daysWorked: ['2026-11-03'], gov: tGov, cashAdvances: 0 });
    expect(p.net).toBe(-20_250);
  });

  it('caps CAs at the net pay left', () => {
    expect(cashAdvanceCap(45_750, 20_000)).toBe(25_750);
    expect(cashAdvanceCap(10_000, 20_000)).toBe(0);
  });
});

describe('receptionist day kinds', () => {
  it.each([
    [1, null, 'ordinary'],
    [0, null, 'restDay'],
    [3, 'special', 'special'],
    [0, 'special', 'specialOnRestDay'],
    [3, 'regular', 'regular'],
    [0, 'regular', 'regularOnRestDay'],
  ] as const)('weekday %i holiday %s → %s', (weekday, holiday, kind) => {
    expect(dayKind(weekday, 0, holiday)).toBe(kind);
  });
});

describe('receptionist day pay (₱692 daily, ₱86.50/hr)', () => {
  // 2026-11-02 is a Monday; 2026-11-01 a Sunday.
  it('pays a full ordinary day exactly the daily rate', () => {
    const d = day('2026-11-02', [shift('2026-11-02', '13:55', '23:00')]);
    expect(d).toMatchObject({ kind: 'ordinary', lateMin: 0, undertimeMin: 0, overtimeMin: 0, paidMin: 480, total: 69_200, basic: 69_200 });
  });

  it('deducts late minutes per minute', () => {
    const d = day('2026-11-02', [shift('2026-11-02', '14:10', '23:00')]);
    expect(d.lateMin).toBe(10);
    // 692 × 470/480 = 677.583…
    expect(d.total).toBe(67_758);
  });

  it('deducts leaving early as Undertime', () => {
    const d = day('2026-11-02', [shift('2026-11-02', '14:00', '22:30')]);
    expect(d.undertimeMin).toBe(30);
    expect(d.total).toBe(64_875);
  });

  it('does not deduct for an Early Close', () => {
    const d = day('2026-11-02', [shift('2026-11-02', '14:00', '20:00')], { earlyClose: '20:00' });
    expect(d).toMatchObject({ undertimeMin: 0, paidMin: 480, total: 69_200 });
  });

  it('pays Overtime after 11pm at 125%, past midnight too', () => {
    const d = day('2026-11-02', [shift('2026-11-02', '14:00', '00:30')]);
    expect(d.overtimeMin).toBe(90);
    // 692/480 × 90 × 1.25 = 162.1875
    expect(d.overtimePay).toBe(16_219);
    expect(d.total).toBe(69_200 + 16_219);
  });

  it('allows a punched-out meal break up to an hour', () => {
    const d = day('2026-11-02', [shift('2026-11-02', '14:00', '18:00'), shift('2026-11-02', '18:45', '23:00')]);
    expect(d.undertimeMin).toBe(0);
    const long = day('2026-11-02', [shift('2026-11-02', '14:00', '18:00'), shift('2026-11-02', '19:20', '23:00')]);
    expect(long.undertimeMin).toBe(20);
  });

  it.each([
    ['restDay', '2026-11-01', undefined, 89_960, 14_619],
    ['special', '2026-11-02', 'special', 89_960, 14_619],
    ['specialOnRestDay', '2026-11-01', 'special', 103_800, 16_868],
    ['regular', '2026-11-02', 'regular', 138_400, 22_490],
    ['regularOnRestDay', '2026-11-01', 'regular', 179_920, 29_237],
  ] as const)('%s pays its premium on the day and on Overtime', (kind, date, holiday, dayPay, ot) => {
    const d = day(date, [shift(date, '14:00', '00:00')], { holiday });
    expect(d.kind).toBe(kind);
    expect(d.dayPay).toBe(dayPay);
    expect(d.overtimePay).toBe(ot);
    expect(d.basic).toBe(69_200);
  });

  it('pays an unworked Regular Holiday but not an unworked ordinary day', () => {
    expect(day('2026-11-30', [], { holiday: 'regular' })).toMatchObject({ worked: false, holidayPay: 69_200, total: 69_200, basic: 0 });
    expect(day('2026-11-02', [])).toMatchObject({ worked: false, total: 0 });
    expect(day('2026-11-02', [], { holiday: 'special' }).total).toBe(0);
  });
});

describe('receptionist week', () => {
  it('matches a hand-computed week to the centavo', () => {
    // Sun rest day off, Mon–Sat worked: one late, one OT night, Wed a Special Day.
    const days = [
      day('2026-11-01', []),
      day('2026-11-02', [shift('2026-11-02', '13:58', '23:00')]), // 692.00
      day('2026-11-03', [shift('2026-11-03', '14:15', '23:00')]), // 692 × 465/480 = 670.375 → 670.38
      day('2026-11-04', [shift('2026-11-04', '14:00', '23:00')], { holiday: 'special' }), // 899.60
      day('2026-11-05', [shift('2026-11-05', '14:00', '23:45')]), // 692 + 45 min × 1.441667 × 1.25 = 81.09
      day('2026-11-06', [shift('2026-11-06', '14:00', '21:00')], { earlyClose: '21:00' }), // 692.00
      day('2026-11-07', [shift('2026-11-07', '14:00', '23:00')]), // 692.00
    ];
    const p = receptionistPayroll({ days, gov: GOV, caRepayment: 50_000 });
    expect(p.gross).toBe(69_200 + 67_038 + 89_960 + 69_200 + 8_109 + 69_200 + 69_200);
    expect(p.basic).toBe(69_200 * 5 + 67_038);
    expect(p.net).toBe(p.gross - 36_813 - 50_000);
  });

  it('withholds nothing in a week not worked', () => {
    const p = receptionistPayroll({ days: [day('2026-11-02', [])], gov: GOV, caRepayment: 0 });
    expect(p).toMatchObject({ gross: 0, govSss: 0, net: 0 });
  });

  it('takes the standing CA Repayment, never above the balance', () => {
    expect(caRepaymentFor(50_000, 400_000)).toBe(50_000);
    expect(caRepaymentFor(100_000, 30_000)).toBe(30_000);
    expect(caRepaymentFor(50_000, 0)).toBe(0);
  });

  it('Adjustments change gross and net but not basic pay', () => {
    const days = [day('2026-11-02', [shift('2026-11-02', '14:00', '23:00')])];
    const p = receptionistPayroll({ days, gov: GOV, caRepayment: 0, adjustments: 20_000 });
    expect(p.gross).toBe(89_200);
    expect(p.basic).toBe(69_200);
  });
});

describe('Payslip lines', () => {
  it('shows late and undertime as deductions from a full day', () => {
    const d = day('2026-11-02', [shift('2026-11-02', '14:10', '22:30')]);
    expect(d).toMatchObject({ lateMin: 10, undertimeMin: 30, fullBasic: 69_200, premium: 0 });
    expect(d.fullBasic + d.premium - d.lateDeduction - d.undertimeDeduction).toBe(d.dayPay);
    // 692 × 10/480 = 14.42
    expect(d.lateDeduction).toBe(1_442);
  });

  it('splits a hand-computed week into its lines, exactly', () => {
    const days = [
      day('2026-11-01', [shift('2026-11-01', '14:00', '23:00')]), // Rest Day worked: +207.60
      day('2026-11-02', [shift('2026-11-02', '14:15', '23:00')]), // late 15 min
      day('2026-11-03', [shift('2026-11-03', '14:00', '23:30')]), // 30 min OT
      day('2026-11-04', [shift('2026-11-04', '14:00', '23:00')], { holiday: 'special' }), // +207.60
      day('2026-11-05', []), // absent
      day('2026-11-06', [], { holiday: 'regular' }), // not worked, paid
      day('2026-11-07', [shift('2026-11-07', '14:00', '22:00')]), // undertime 60 min
    ];
    const p = receptionistPayroll({ days, gov: GOV, caRepayment: 50_000, adjustments: 10_000 });
    const lines = payLines({ kind: 'receptionist', ...p, days, adjustments: 10_000 });
    expect(lines.daysPresent).toBe(5);
    expect(lines.earnings).toMatchObject({
      basic: 69_200 * 5,
      restDayPremium: 20_760,
      holidayPremium: 20_760,
      holidayUnworked: 69_200,
      overtime: days[2]!.overtimePay,
      adjustments: 10_000,
      commission: 0,
    });
    // Late is what the day lost: 692 − 670.38 (its pay rounded up), so 21.62.
    expect(lines.deductions).toMatchObject({ late: 2_162, undertime: 8_650, sss: 21_250, phic: 10_563, pagibig: 5_000, ca: 50_000 });
    expect(lines.totalEarned - lines.totalDeductions).toBe(p.net);
  });

  it('reads Payrolls made before the lines existed', () => {
    const old = [{ date: '2026-10-26', kind: 'ordinary' as const, worked: true, dayPay: 67_758, overtimePay: 0, holidayPay: 0, total: 67_758 }];
    const lines = payLines({ kind: 'receptionist', days: old, gross: 67_758, govSss: 0, govPhic: 0, govPagibig: 0, caDeduction: 0, net: 67_758, adjustments: 0 } as never);
    expect(lines.earnings.basic).toBe(67_758);
    expect(lines.totalEarned).toBe(67_758);
  });
});

describe('December pay', () => {
  it('Year-end Bonus is the year’s commission times the chosen percentage', () => {
    // ₱100,000 × 8.13%
    expect(yearEndBonus(10_000_000, 813)).toBe(813_000);
  });
  it('13th Month Pay is a twelfth of the year’s basic pay', () => {
    expect(thirteenthMonth(17_993_000)).toBe(1_499_417);
  });
});

describe('Relief pay (₱582 Minimum Wage Rate)', () => {
  const relief = (date: string, entries: ReturnType<typeof shift>[], holiday: 'regular' | 'special' | null = null) =>
    reliefDay({ date, holiday, entries, earlyCloseAt: null, minimumWage: 58_200, rules: RULES });

  it('pays a full Sunday at the ordinary rate: no Rest Day premium', () => {
    const d = relief('2026-11-01', [shift('2026-11-01', '14:00', '23:00')])!;
    expect(d).toMatchObject({ kind: 'ordinary', total: 58_200, premium: 0 });
  });

  it('keeps Holiday premiums, late and Overtime', () => {
    expect(relief('2026-11-02', [shift('2026-11-02', '14:00', '23:00')], 'regular')!.total).toBe(116_400);
    const d = relief('2026-11-02', [shift('2026-11-02', '14:30', '23:30')])!;
    expect(d.lateMin).toBe(30);
    expect(d.overtimeMin).toBe(30);
  });

  it('pays only the minutes covered on part of a day, and nothing for a day not covered', () => {
    // 14:00–17:00 covered: 3 of 8 hours, no meal break taken (₱582 × 180/480).
    expect(relief('2026-11-02', [shift('2026-11-02', '19:00', '23:00')])!.total).toBe(29_100);
    expect(relief('2026-11-02', [shift('2026-11-02', '14:00', '17:00')])!.total).toBe(21_825);
    expect(relief('2026-11-30', [], 'regular')).toBeNull();
  });

  it('adds to a Therapist’s week as its own line, not Commission', () => {
    const week = payWeekOf('2026-11-01');
    const p = therapistPayroll({ week, commissions: [{ businessDay: '2026-11-02', amount: 15_000 }], daysWorked: ['2026-11-01', '2026-11-02'], gov: GOV, cashAdvances: 0, relief: [{ date: '2026-11-01', pay: 58_200 }] });
    expect(p.gross).toBe(73_200);
    const lines = payLines({ kind: 'therapist', ...p, adjustments: 0 });
    expect(lines.earnings).toMatchObject({ commission: 15_000, reliefPay: 58_200 });
  });
});

describe('Pay Weeks', () => {
  it('runs Monday to Sunday for Therapists and Sunday to Saturday for everyone else', () => {
    expect(payWeekOf('2026-11-08', 'therapist')).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(payWeekOf('2026-11-08')).toEqual({ start: '2026-11-08', end: '2026-11-14' });
    expect(payWeekOf('2026-11-09', 'therapist').start).toBe('2026-11-09');
    expect(lastCompletedPayWeek('2026-11-09', 'therapist').start).toBe('2026-11-02');
    expect(lastCompletedPayWeek('2026-11-09').start).toBe('2026-11-01');
    expect(weekKindsOf('2026-11-02')).toEqual(['therapist']);
    expect(weekKindsOf('2026-11-08')).toEqual(['receptionist', 'reliever']);
  });
});

describe('Government Deduction Refund', () => {
  it('clears what is owed first and pays the rest in cash', () => {
    expect(refundSplit(29_600, 61_350)).toEqual({ applied: 29_600, cash: 0 });
    expect(refundSplit(29_600, 20_450)).toEqual({ applied: 20_450, cash: 9_150 });
    expect(refundSplit(29_600, 0)).toEqual({ applied: 0, cash: 29_600 });
  });
});

describe('Deferred Deductions', () => {
  const plan = (earned: number, balance = 0, extra = {}) => deferDeductions({ earned, week: 20_450, balance, floor: 100_000, cashAdvances: 0, ...extra });

  it('takes the week in full when there is room', () => {
    expect(plan(150_000)).toMatchObject({ govDeferred: 0, govCollected: 0 });
  });

  it('stops at the Take-home Floor and holds the rest over', () => {
    expect(plan(110_000)).toMatchObject({ govDeferred: 10_450, govCollected: 0 });
    expect(plan(90_000)).toMatchObject({ govDeferred: 20_450, govCollected: 0 });
  });

  it('takes only the week, however much is owed and however good the week', () => {
    expect(plan(500_000, 40_000)).toMatchObject({ govDeferred: 0, govCollected: 0 });
  });

  it('never takes more than what is left after Cash Advances', () => {
    expect(plan(150_000, 0, { cashAdvances: 140_000 })).toMatchObject({ govDeferred: 10_450 });
  });

  it('the Super Admin’s own figure replaces the floor, up to what is owed', () => {
    expect(plan(90_000, 0, { override: 20_450 })).toMatchObject({ govDeferred: 0, govOverride: 20_450 });
    expect(plan(90_000, 5_000, { override: 0 })).toMatchObject({ govDeferred: 20_450 });
    expect(plan(150_000, 5_000, { override: 99_000 })).toMatchObject({ govCollected: 5_000 });
  });

  it('the Super Admin’s own figure never takes more than the pay', () => {
    expect(plan(10_000, 0, { override: 20_450 })).toMatchObject({ govDeferred: 10_450 });
    expect(plan(150_000, 0, { override: 20_450, cashAdvances: 140_000 })).toMatchObject({ govDeferred: 10_450 });
  });

  it('a Payroll adds up with the amounts held over and the Commission before Go-live', () => {
    const p = therapistPayroll({
      week: { start: '2026-11-02', end: '2026-11-08' },
      commissions: [{ businessDay: '2026-11-08', amount: 30_000 }],
      daysWorked: ['2026-11-08'],
      gov: { sss: 10_000, phic: 6_250, pagibig: 4_200 },
      cashAdvances: 0,
      commissionBefore: 80_000,
      deferral: { balance: 0, floor: 100_000 },
    });
    expect(p).toMatchObject({ gross: 110_000, commissionBefore: 80_000, govDeferred: 10_450, net: 100_000 });
    const lines = payLines({ kind: 'therapist', ...p, adjustments: 0 });
    expect(lines.earnings).toMatchObject({ commission: 30_000, commissionBefore: 80_000 });
    expect(lines.deductions.deferred).toBe(-10_450);
    expect(lines.totalEarned - lines.totalDeductions).toBe(p.net);
  });

  it('works out the weeks owed at Go-live from the weekly record, worked or not', () => {
    const weeks = [
      { weekStart: '2026-01-05', gross: 400_000, net: 379_550 },
      { weekStart: '2026-01-12', gross: 300_000, net: 279_550 },
      { weekStart: '2026-01-19', gross: 70_000, net: 70_000 },
      { weekStart: '2026-01-26', gross: 0, net: -20_450 },
      { weekStart: '2026-02-02', gross: 0, net: 0 },
    ];
    expect(openingWeeks(weeks).map((w) => [w.weekStart, w.amount])).toEqual([['2026-01-19', 20_450], ['2026-01-26', 20_450], ['2026-02-02', 20_450]]);
    expect(openingWeeks([{ weekStart: '2026-01-19', gross: 70_000, net: 70_000 }])).toEqual([]);
  });

  it('gives the days of a week, month or year of Payroll totals', () => {
    expect(payPeriodRange('week', '2026-11-04')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(payPeriodRange('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(payPeriodRange('year', '2026-02-10')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('puts a week across two months in the one with most of its days', () => {
    expect(payWeekMiddle('2026-07-27')).toBe('2026-07-30'); // Therapist, Jul 27 to Aug 2
    expect(payWeekMiddle('2026-09-27')).toBe('2026-09-30'); // Receptionist, Sep 27 to Oct 3
  });

  it('clears the oldest weeks first', () => {
    const weeks = [{ weekStart: '2026-03-02', amount: 20_450 }, { weekStart: '2026-02-23', amount: 20_450 }];
    expect(weeksOwed(weeks, 30_000)).toEqual([{ weekStart: '2026-03-02', amount: 10_900 }]);
    expect(weeksOwed(weeks, 0).map((w) => w.weekStart)).toEqual(['2026-02-23', '2026-03-02']);
    expect(weeksOwed(weeks, 40_900)).toEqual([]);
  });

  it('numbers weeks the way the owner’s records do', () => {
    expect(weekNumber('2025-12-29')).toBe(1);
    expect(weekNumber('2026-02-23')).toBe(9);
    expect(weekNumber('2026-11-02')).toBe(45);
  });
});

describe('December pay', () => {
  it('covers 2026 from the week of New Year through the last finished Pay Week', () => {
    // Dec 14, 2026 is a Monday: the week of Dec 7-13 has just finished.
    expect(bonusPeriod(2026, null, '2026-12-14')).toEqual({ start: '2025-12-29', end: '2026-12-13' });
    // On that Sunday it has not.
    expect(bonusPeriod(2026, null, '2026-12-13').end).toBe('2026-12-06');
  });
  it('starts the next year the day after the cut-off', () => {
    expect(bonusPeriod(2027, '2026-12-13', '2027-12-13')).toEqual({ start: '2026-12-14', end: '2027-12-12' });
  });
  it('stops at the year end when computing a past year', () => {
    expect(bonusPeriod(2026, null, '2027-03-01').end).toBe('2026-12-27');
  });
  it('takes Deferred Deductions off the bonus, never more than the bonus', () => {
    expect(bonusDeduction(1_000_00, 409_00)).toBe(409_00);
    expect(bonusDeduction(300_00, 409_00)).toBe(300_00);
    expect(bonusDeduction(300_00, 0)).toBe(0);
  });
  it('suggests a share of the profit to the nearest 0.5%', () => {
    // 30% of 200,000 is 60,000; against 1,000,000 Commission that is 6%.
    const { bp, scenarios } = suggestBonus({ profit: 200_000_00, commission: 1_000_000_00, shareBp: 3000 });
    expect(bp).toBe(600);
    expect(scenarios).toEqual([
      { bp: 500, cost: 50_000_00, left: 150_000_00 },
      { bp: 600, cost: 60_000_00, left: 140_000_00 },
      { bp: 700, cost: 70_000_00, left: 130_000_00 },
    ]);
    expect(suggestBonus({ profit: 210_000_00, commission: 1_000_000_00, shareBp: 3000 }).bp).toBe(650);
  });
  it('adds a suggestion outside the usual range to the choices', () => {
    const { bp, scenarios } = suggestBonus({ profit: 300_000_00, commission: 1_000_000_00, shareBp: 3000 });
    expect(bp).toBe(900);
    expect(scenarios.map((x) => x.bp)).toEqual([500, 600, 700, 900]);
  });
  it('has no suggestion in a loss year but still shows the choices', () => {
    const { bp, scenarios } = suggestBonus({ profit: -50_000_00, commission: 1_000_000_00, shareBp: 3000 });
    expect(bp).toBeNull();
    expect(scenarios[0]).toEqual({ bp: 500, cost: 50_000_00, left: -100_000_00 });
  });
});
