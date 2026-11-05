import { describe, expect, it } from 'vitest';
import { manilaInstant } from './business-day';
import {
  cashAdvanceCap,
  caRepaymentFor,
  dayKind,
  lastCompletedPayWeek,
  nextPayWeekStart,
  payLines,
  payWeekOf,
  receptionistDay,
  receptionistPayroll,
  therapistPayroll,
  thirteenthMonth,
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
