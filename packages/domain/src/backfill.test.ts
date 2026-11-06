import { describe, expect, it } from 'vitest';
import {
  dayWarnings,
  employerShares,
  moneyReceived,
  monthExpenses,
  monthOfWeek,
  parseReceptionistWorkbook,
  parseSalesWorkbook,
  royaltyForMonth,
  withheldByMonth,
  type DailySummaryDraft,
  type Grid,
  type MonthDraft,
} from './backfill';

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);
const day = (d: Partial<DailySummaryDraft> = {}): DailySummaryDraft => ({
  date: '2026-10-04',
  cash: 828_000,
  gcash: 0,
  oil: 12_000,
  voucher: 0,
  foc: 210_000,
  commission: 233_400,
  guests: 13,
  therapists: 5,
  rejects: 0,
  laundry: 81_500,
  expenses: 0,
  ...d,
});

/** Puts rows at their real spreadsheet positions, one-indexed. */
function grid(cells: Record<number, Grid[number]>): Grid {
  const out: Grid = [];
  for (const [r, row] of Object.entries(cells)) out[Number(r) - 1] = row;
  return out;
}

const summary = grid({
  11: [null, 'Receptionist', 16_800.41],
  14: [null, 'VECO', 8_246.98],
  15: [null, 'Bookkeeping', 15_551.61],
  17: [null, 'Supplies', 9_787.69],
  20: [null, 'Maintenance', 21_165.42],
  48: [null, 'BOOKKEEPING', 15_551.61],
  49: [null, 'Bookkeeping fee', 1_250],
  50: [null, '2551Q - quarter', 13_959.40],
  51: [null, 'Clearances (barangay)', 342.21],
  77: [null, "GOV'T CONTRIBUTIONS", 13_025],
  78: [null, 'Employer Registration fee'],
  79: [null, 'SSS', 13_000],
  80: [null, 'Convenience fee', 25],
});

const therapists = grid({
  1: [null, null, null, null, null, null, null, null, 'Gura, Evelyn', null, null, 'Vecin, Cristina'],
  2: [null, 'Week'],
  3: [null, 1, date('2025-12-29'), date('2026-01-04'), 7, 92, 62.5, 50, 0, 0, -204.5, 270, 1, 270],
  4: [null, 2, date('2026-01-05'), date('2026-01-11'), 7, 92, 62.5, 50, 4578, 7, 4373.5, null, null, null],
  5: [null, 3, date('2026-01-12'), date('2026-01-18'), 7, 92, 62.5, 50, null, null, -204.5, null, null, null],
  6: [null, null, null, null, null, null, null, null, 4578],
});

const jan = grid({
  6: [null, 'Thu', date('2026-01-01'), 15_880, 0, 120, 0, 0, 16_000, 7_715, 28, 7, 0, 2_275, 0],
  7: [null, 'Fri', date('2026-01-02'), 7_010, 450, 40, 0, 0, 7_500, 2_661, 17, 5, 1, 1_115, 128],
  8: [null, 'Sat', date('2026-01-03'), null, null, null, null, null, 0],
});

describe('Daily Summaries', () => {
  it('money received is the sheet’s NET SALES', () => {
    expect(moneyReceived(day())).toBe(630_000);
  });

  it('flags days whose figures do not fit', () => {
    expect(dayWarnings(day())).toEqual([]);
    expect(dayWarnings(day({ date: '2026-10-28', cash: 57_000, commission: 202_500, guests: 11, oil: 0, foc: 0 })).join()).toMatch(/355%.*₱52 per Guest/);
    expect(dayWarnings(day({ commission: 26_500 })).join()).toMatch(/3% of sales/);
    expect(dayWarnings(day({ cash: 0, foc: 0, oil: 0, guests: 0, commission: 0 }))).toEqual([]);
  });

  it('a week counts toward the month holding most of it', () => {
    expect(monthOfWeek('2025-12-29')).toBe('2026-01');
    expect(monthOfWeek('2025-12-28')).toBe('2025-12');
    expect(monthOfWeek('2026-04-26')).toBe('2026-04');
  });
});

describe('the sales workbook', () => {
  const book = parseSalesWorkbook({ Summary: summary, Therapists: therapists, JAN: jan });

  it('reads the days, skipping empty ones, and the month’s rows', () => {
    const [m] = book.months;
    expect(m!.month).toBe('2026-01');
    expect(m!.days.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-02']);
    expect(m!.days[1]).toMatchObject({ cash: 701_000, gcash: 45_000, oil: 4_000, commission: 266_100, guests: 17, rejects: 1, laundry: 111_500, expenses: 12_800 });
    expect(m).toMatchObject({ receptionistPay: 1_680_041, electricity: 824_698, supplies: 978_769, maintenance: 2_116_542 });
  });

  it('splits Bookkeeping, finds the 2551Q filing and keeps fees apart from contributions', () => {
    const [m] = book.months;
    expect(m).toMatchObject({ bookkeeping: 125_000, bir: 1_395_940, permits: 34_221, remitted: 1_300_000, remittanceFees: 2_500 });
    expect(book.filings).toEqual([{ quarter: '2025-Q4', grossSales: 46_531_333, amountPaid: 1_395_940, filedOn: '2026-01-25' }]);
    expect(book.warnings).toEqual([]);
  });

  it('reads weeks entered so far and stops at the totals row', () => {
    expect(book.names).toEqual(['Gura, Evelyn', 'Vecin, Cristina']);
    expect(book.weeks).toEqual([
      { weekStart: '2025-12-29', name: 'Gura, Evelyn', gross: 0, daysWorked: 0, net: -20_450 },
      { weekStart: '2025-12-29', name: 'Vecin, Cristina', gross: 27_000, daysWorked: 1, net: 27_000 },
      { weekStart: '2026-01-05', name: 'Gura, Evelyn', gross: 457_800, daysWorked: 7, net: 437_350 },
    ]);
  });

  it('refuses the wrong file', () => {
    expect(() => parseSalesWorkbook({ Sheet1: [] })).toThrow(/not the sales workbook/);
    expect(() => parseReceptionistWorkbook({ Sheet1: [] })).toThrow(/not the Receptionist/);
  });
});

describe('contributions, Royalty and Expenses', () => {
  const month = (m: string, remitted: number): MonthDraft => ({ month: m, days: [], receptionistPay: 0, electricity: 0, supplies: 0, maintenance: 0, bookkeeping: 0, bir: 0, permits: 0, remitted, remittanceFees: 0 });

  it('the shop’s share is remitted less withheld, and an overpaid month carries forward', () => {
    const shares = employerShares([month('2026-02', 10_000), month('2026-01', 5_000), month('2026-03', 10_000)], new Map([['2026-01', 7_000], ['2026-02', 3_000], ['2026-03', 3_000]]));
    expect([...shares.entries()]).toEqual([['2026-01', 0], ['2026-02', 5_000], ['2026-03', 7_000]]);
  });

  it('adds up what was withheld from both workbooks by each week’s month', () => {
    const held = withheldByMonth(
      [{ weekStart: '2025-12-29', name: 'A', gross: 100_000, daysWorked: 5, net: 79_550 }, { weekStart: '2025-12-29', name: 'B', gross: 0, daysWorked: 0, net: -20_450 }, { weekStart: '2026-01-05', name: 'V', gross: 50_000, daysWorked: 3, net: 50_000 }],
      [{ weekStart: '2026-01-04', sss: 16_110, hdmf: 6_929, phic: 8_661 } as never],
    );
    expect(held.get('2026-01')).toBe(20_450 + 31_700);
  });

  it('Royalty stays on the cash column through September, with the corrected rule after; paid through May', () => {
    expect(royaltyForMonth('2026-05', [day({ cash: 100_000_00 })])).toMatchObject({ grossSales: 100_000_00, amount: 3_000_00, paid: true });
    expect(royaltyForMonth('2026-09', [day({ cash: 100_000_00, gcash: 50_000_00 })])).toMatchObject({ grossSales: 100_000_00, paid: false });
    expect(royaltyForMonth('2026-10', [day({ cash: 100_000_00, gcash: 10_000_00, foc: 2_000_00, voucher: 1_500_00, oil: 620_00 })])).toMatchObject({ serviceSales: 108_000_00, voucherSales: 1_500_00, grossSales: 109_500_00, amount: 3_285_00, paid: false });
  });

  it('Expenses take Laundry and Miscellaneous from the days, skip what is zero, and leave pay out', () => {
    const m = { ...month('2026-01', 0), electricity: 100, maintenance: 200, days: [day({ laundry: 300, expenses: 400 }), day({ laundry: 300, expenses: 0 })] };
    expect(monthExpenses(m, 500)).toEqual([
      { categoryId: 'electricity', description: 'VECO', amount: 100 },
      { categoryId: 'laundry', description: 'Laundry', amount: 600 },
      { categoryId: 'other', description: 'Miscellaneous', amount: 400 },
      { categoryId: 'maintenance', description: 'Maintenance', amount: 200 },
      { categoryId: 'government', description: 'Employer share of contributions', amount: 500 },
    ]);
  });
});

describe('the Receptionist workbook', () => {
  const head: Grid[number] = [null, 'Name', 'Start Coverage', 'End Coverage'];
  head[27] = 'NET';
  const row = (start: string, end: string, extra: Record<number, Grid[number][number]>) => {
    const r: Grid[number] = [null, 'Marie Shimomukai', date(start), date(end)];
    for (const [k, v] of Object.entries(extra)) r[Number(k)] = v;
    return r;
  };
  const week = { 5: 7, 6: 692, 7: 4844, 11: 0.58, 12: 63.07, 16: 207.6, 19: 212.5, 20: 50, 21: 105.63, 22: 500, 23: 50.46, 26: 5064.21, 27: 4196.08, 28: date('2026-11-04'), 29: 5000 };
  const time = (h: number, m: number) => new Date(Date.UTC(1899, 11, 30, h, m));
  const book = parseReceptionistWorkbook({
    Summary: [[], head, row('2025-12-21', '2025-12-27', { 27: 3949.51 }), row('2026-10-25', '2026-10-31', week)],
    Timesheet: [[], [null, 1, new Date('2026-10-25T14:00:00Z'), 0.58, time(23, 10), 9.17, 0.17, 0, 0, 0, 0, 0, 0, 'Holiday'], [null, 0, new Date('2026-10-26T14:00:00Z'), 0.58, time(14, 0), 0]],
  });

  it('takes only this year’s weeks, exactly as paid, with their days', () => {
    expect(book.name).toBe('Marie Shimomukai');
    expect(book.warnings).toEqual([]);
    expect(book.payslips).toHaveLength(1);
    const [p] = book.payslips;
    expect(p).toMatchObject({ weekStart: '2026-10-25', dailyRate: 69_200, daysWorked: 7, basic: 484_400, overtimeHours: 58, overtimePay: 6_307, premiumPay: 20_760, lateUndertime: 5_046, sss: 21_250, caRepayment: 50_000, gross: 506_421, net: 419_608, paidOn: '2026-11-04', caBalance: 500_000 });
    expect(p!.days[0]).toEqual({ date: '2026-10-25', worked: true, timeIn: '14:00', timeOut: '23:10', hours: 9.17, lateHours: 0, overtimeHours: 0.17, note: 'Holiday' });
    expect(p!.days[1]).toMatchObject({ worked: false });
  });
});
