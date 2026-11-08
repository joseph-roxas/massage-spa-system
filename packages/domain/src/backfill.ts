import { royaltyAmount } from './expenses';

/** What a spreadsheet cell can hold once read. */
export type Cell = string | number | boolean | Date | null | undefined;
export type Grid = Cell[][];
export type Workbook = Record<string, Grid>;

export type DailySummaryDraft = {
  date: string;
  /** Centavos. */
  cash: number;
  gcash: number;
  oil: number;
  voucher: number;
  foc: number;
  commission: number;
  guests: number;
  therapists: number;
  rejects: number;
  laundry: number;
  expenses: number;
};

export type MonthDraft = {
  /** YYYY-MM */
  month: string;
  days: DailySummaryDraft[];
  receptionistPay: number;
  electricity: number;
  supplies: number;
  maintenance: number;
  bookkeeping: number;
  bir: number;
  permits: number;
  /** SSS, PhilHealth and Pag-IBIG remitted, employee and employer shares together. */
  remitted: number;
  /** Penalties and fees on remittances; never withheld from staff. */
  remittanceFees: number;
};

export type TherapistWeekDraft = { weekStart: string; name: string; gross: number; daysWorked: number; net: number };
export type FilingDraft = { quarter: string; grossSales: number; amountPaid: number; filedOn: string };
export type SalesWorkbook = { months: MonthDraft[]; weeks: TherapistWeekDraft[]; names: string[]; filings: FilingDraft[]; warnings: string[] };

export type PastPayslipDay = { date: string; worked: boolean; timeIn: string | null; timeOut: string | null; hours: number; lateHours: number; overtimeHours: number; note: string | null };
export type PastPayslipDraft = {
  weekStart: string;
  weekEnd: string;
  paidOn: string | null;
  dailyRate: number;
  daysWorked: number;
  basic: number;
  overtimeHours: number;
  overtimePay: number;
  premiumPay: number;
  lateUndertime: number;
  sss: number;
  hdmf: number;
  phic: number;
  caRepayment: number;
  gross: number;
  net: number;
  caBalance: number | null;
  days: PastPayslipDay[];
};
export type ReceptionistWorkbook = { name: string; payslips: PastPayslipDraft[]; warnings: string[] };

const SHEETS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const FIRST_DAY_ROW = 5;
const LAST_DAY_ROW = 35;
/** Summary tab: January's figures are in column C, February's in D, and so on. */
const SUMMARY_FIRST_MONTH_COL = 2;
const THERAPISTS_FIRST_COL = 8;
/** Paid Royalty so far, and the months computed the old way, on the cash column. */
const ROYALTY_PAID_THROUGH = '2026-05';
const ROYALTY_CASH_RULE_THROUGH = '2026-09';
const ROYALTY_BP = 300;
const PERCENTAGE_TAX = 0.03;
/** Past Payslips start with the week paid in January 2026. */
const FIRST_PAST_PAYSLIP = '2025-12-28';

const num = (c: Cell) => (typeof c === 'number' && Number.isFinite(c) ? c : 0);
const cents = (c: Cell) => Math.round(num(c) * 100);
const whole = (c: Cell) => Math.round(num(c));
/** A broken date cell can read as a year far in the future, and counts as blank. */
const isoOf = (c: Cell) => (c instanceof Date && !Number.isNaN(c.getTime()) && c.getUTCFullYear() >= 2000 && c.getUTCFullYear() < 2100 ? c.toISOString().slice(0, 10) : null);
const text = (c: Cell) => (typeof c === 'string' ? c.trim() : '');

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The month a seven-day week counts toward: the one holding most of it. */
export function monthOfWeek(weekStart: string): string {
  return addDays(weekStart, 3).slice(0, 7);
}

/** Money received for the day. Oil is the Owner's Set-aside, already inside the sales, so unlike the sheet's NET SALES it isn't added. */
export const moneyReceived = (d: DailySummaryDraft) => d.cash + d.gcash + d.voucher - d.foc;

/** Odd figures to look at before saving: a mistyped amount shows up against the Guests or Commission. */
export function dayWarnings(d: DailySummaryDraft): string[] {
  const sales = d.cash + d.gcash;
  const out: string[] = [];
  if (sales === 0 && (d.guests > 0 || d.commission > 0)) out.push('Guests or Commission but no sales');
  if (sales > 0) {
    const share = d.commission / sales;
    if (share > 0.6 || share < 0.25) out.push(`Commission is ${Math.round(share * 100)}% of sales`);
    if (d.guests === 0) out.push('Sales but no Guests');
    else if (sales / d.guests < 25_000 || sales / d.guests > 90_000) out.push(`₱${Math.round(sales / d.guests / 100)} per Guest`);
  }
  return out;
}

function monthSheet(grid: Grid): DailySummaryDraft[] {
  const days: DailySummaryDraft[] = [];
  for (let r = FIRST_DAY_ROW; r <= LAST_DAY_ROW; r++) {
    const row = grid[r] ?? [];
    const date = isoOf(row[2]);
    if (!date) continue;
    const day: DailySummaryDraft = {
      date,
      cash: cents(row[3]),
      gcash: cents(row[4]),
      oil: cents(row[5]),
      voucher: cents(row[6]),
      foc: cents(row[7]),
      commission: cents(row[9]),
      guests: whole(row[10]),
      therapists: whole(row[11]),
      rejects: whole(row[12]),
      laundry: cents(row[13]),
      expenses: cents(row[14]),
    };
    // A closed or not-yet-entered day has nothing on it.
    if (day.cash || day.gcash || day.oil || day.voucher || day.foc || day.commission || day.guests || day.laundry || day.expenses) days.push(day);
  }
  return days;
}

const rowLabelled = (grid: Grid, label: string) => grid.findIndex((row) => text(row?.[1]) === label);

/** Reads the owner's sales workbook: one tab a month, the Summary tab, and the weekly Therapists tab. */
export function parseSalesWorkbook(book: Workbook): SalesWorkbook {
  const summary = book.Summary;
  const therapists = book.Therapists;
  if (!summary || !therapists || !book.JAN) throw new Error('This is not the sales workbook: it needs the Summary, Therapists and monthly tabs.');
  const warnings: string[] = [];
  const at = {
    receptionist: rowLabelled(summary, 'Receptionist'),
    veco: rowLabelled(summary, 'VECO'),
    supplies: rowLabelled(summary, 'Supplies'),
    maintenance: rowLabelled(summary, 'Maintenance'),
    bookkeeping: rowLabelled(summary, 'BOOKKEEPING'),
    government: rowLabelled(summary, "GOV'T CONTRIBUTIONS"),
  };
  if (Object.values(at).some((r) => r < 0)) throw new Error('The Summary tab is missing a row it should have (Receptionist, VECO, Supplies, Maintenance, BOOKKEEPING or GOV’T CONTRIBUTIONS).');

  const months: MonthDraft[] = [];
  const filings: FilingDraft[] = [];
  SHEETS.forEach((sheet, i) => {
    const grid = book[sheet];
    if (!grid) return;
    const days = monthSheet(grid);
    const col = SUMMARY_FIRST_MONTH_COL + i;
    const cell = (r: number) => cents(summary[r]?.[col]);
    if (!days.length) return;
    const month = days[0]!.date.slice(0, 7);

    const split = { bookkeeping: 0, bir: 0, permits: 0 };
    for (let r = at.bookkeeping + 1; r < at.government; r++) {
      const label = text(summary[r]?.[1]);
      const amount = cell(r);
      if (!label || !amount) continue;
      if (/BIR|ITR|tax due|1701|2551Q|0605|convenience|receipt|annex/i.test(label) && !/business tax/i.test(label)) split.bir += amount;
      else if (/bookkeeping fee|service charges/i.test(label)) split.bookkeeping += amount;
      else split.permits += amount;
      if (/^2551Q - quarter/i.test(label)) {
        const y = Number(month.slice(0, 4));
        const q = Math.floor(i / 3);
        filings.push({ quarter: q === 0 ? `${y - 1}-Q4` : `${y}-Q${q}`, grossSales: Math.round(amount / PERCENTAGE_TAX), amountPaid: amount, filedOn: `${month}-25` });
      }
    }
    const listed = split.bookkeeping + split.bir + split.permits;
    if (listed !== cell(at.bookkeeping)) {
      warnings.push(`${month}: the Bookkeeping breakdown adds up to ₱${(listed / 100).toFixed(2)}, not the ₱${(cell(at.bookkeeping) / 100).toFixed(2)} on its total. The difference is put under Bookkeeping.`);
      split.bookkeeping += cell(at.bookkeeping) - listed;
    }

    let remitted = 0;
    let remittanceFees = 0;
    for (let r = at.government + 1; r < summary.length; r++) {
      const label = text(summary[r]?.[1]);
      if (!label) break;
      if (/penalt|fee/i.test(label)) remittanceFees += cell(r);
      else remitted += cell(r);
    }

    months.push({
      month,
      days,
      receptionistPay: cell(at.receptionist),
      electricity: cell(at.veco),
      supplies: cell(at.supplies),
      maintenance: cell(at.maintenance),
      ...split,
      remitted,
      remittanceFees,
    });
    for (const d of days) for (const w of dayWarnings(d)) warnings.push(`${d.date}: ${w}`);
  });

  const header = therapists[0] ?? [];
  const people: { col: number; name: string }[] = [];
  for (let c = THERAPISTS_FIRST_COL; c < header.length; c += 3) if (text(header[c])) people.push({ col: c, name: text(header[c]) });
  const weeks: TherapistWeekDraft[] = [];
  for (let r = 2; r < therapists.length; r++) {
    const row = therapists[r] ?? [];
    const weekStart = isoOf(row[2]);
    if (!weekStart) break;
    for (const p of people) {
      // A week not entered yet has no Gross, only the sheet's standing deduction.
      if (row[p.col] === null || row[p.col] === undefined) continue;
      const gross = cents(row[p.col]);
      weeks.push({ weekStart, name: p.name, gross, daysWorked: whole(row[p.col + 1]), net: row[p.col + 2] === null || row[p.col + 2] === undefined ? gross : cents(row[p.col + 2]) });
    }
  }
  return { months, weeks, names: people.map((p) => p.name), filings, warnings };
}

/** What each month cost the shop in contributions: what was remitted less what staff had withheld. Overpaid months carry forward. */
export function employerShares(months: readonly MonthDraft[], withheld: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  let carried = 0;
  for (const m of [...months].sort((a, b) => a.month.localeCompare(b.month))) {
    const share = m.remitted - (withheld.get(m.month) ?? 0) - carried;
    out.set(m.month, Math.max(0, share));
    carried = share < 0 ? -share : 0;
  }
  return out;
}

/** Government Deductions actually taken, per month, from both workbooks. A deduction shown against no earnings was never collected. */
export function withheldByMonth(weeks: readonly TherapistWeekDraft[], payslips: readonly PastPayslipDraft[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (weekStart: string, amount: number) => out.set(monthOfWeek(weekStart), (out.get(monthOfWeek(weekStart)) ?? 0) + amount);
  for (const w of weeks) if (w.gross > 0 && w.gross > w.net) add(w.weekStart, w.gross - w.net);
  for (const p of payslips) add(p.weekStart, p.sss + p.hdmf + p.phic);
  return out;
}

export type RoyaltyDraft = { serviceSales: number; voucherSales: number; grossSales: number; bp: number; amount: number; paid: boolean };

/** A month's Royalty before Go-live: as paid on the cash column through September, by the corrected rule after. */
export function royaltyForMonth(month: string, days: readonly DailySummaryDraft[]): RoyaltyDraft {
  const sum = (f: (d: DailySummaryDraft) => number) => days.reduce((s, d) => s + f(d), 0);
  const cashRule = month <= ROYALTY_CASH_RULE_THROUGH;
  const serviceSales = cashRule ? sum((d) => d.cash) : sum((d) => d.cash + d.gcash - d.foc);
  const voucherSales = cashRule ? 0 : sum((d) => d.voucher);
  const grossSales = serviceSales + voucherSales;
  return { serviceSales, voucherSales, grossSales, bp: ROYALTY_BP, amount: royaltyAmount(grossSales, ROYALTY_BP), paid: month <= ROYALTY_PAID_THROUGH };
}

export type MonthExpense = { categoryId: string; description: string; amount: number };

/** The month's Expenses. Commission and the Receptionist's pay are pay lines; Royalty has its own statement. */
export function monthExpenses(m: MonthDraft, employerShare: number): MonthExpense[] {
  const sum = (key: 'laundry' | 'expenses') => m.days.reduce((s, d) => s + d[key], 0);
  return [
    { categoryId: 'electricity', description: 'VECO', amount: m.electricity },
    { categoryId: 'laundry', description: 'Laundry', amount: sum('laundry') },
    { categoryId: 'supplies-tools', description: 'Supplies', amount: m.supplies },
    { categoryId: 'other', description: 'Miscellaneous', amount: sum('expenses') },
    { categoryId: 'maintenance', description: 'Maintenance', amount: m.maintenance },
    { categoryId: 'bookkeeping', description: 'Bookkeeping', amount: m.bookkeeping },
    { categoryId: 'bir', description: 'BIR', amount: m.bir },
    { categoryId: 'business-permit', description: 'Business permit and requirements', amount: m.permits },
    { categoryId: 'government', description: 'Employer share of contributions', amount: employerShare },
    { categoryId: 'government', description: 'Remittance penalties and fees', amount: m.remittanceFees },
  ].filter((e) => e.amount > 0);
}

function timeOf(c: Cell): string | null {
  if (!(c instanceof Date)) return null;
  return c.toISOString().slice(11, 16);
}

/** Reads the Receptionist's time record: the weekly Summary tab and the daily Timesheet. */
export function parseReceptionistWorkbook(book: Workbook): ReceptionistWorkbook {
  const summary = book.Summary;
  const timesheet = book.Timesheet;
  const head = summary?.[1] ?? [];
  if (!summary || !timesheet || text(head[2]) !== 'Start Coverage' || text(head[27]) !== 'NET') {
    throw new Error('This is not the Receptionist time record: it needs the Timesheet and Summary tabs.');
  }
  const warnings: string[] = [];
  const days = new Map<string, PastPayslipDay>();
  for (const row of timesheet.slice(1)) {
    const date = isoOf(row?.[2]);
    if (!date) continue;
    days.set(date, {
      date,
      worked: num(row![1]) === 1,
      timeIn: timeOf(row![2]),
      timeOut: timeOf(row![4]),
      hours: Math.round(num(row![5]) * 100) / 100,
      lateHours: Math.round(num(row![8]) * 100) / 100,
      overtimeHours: Math.round(num(row![6]) * 100) / 100,
      note: text(row![13]) || null,
    });
  }
  let name = '';
  const payslips: PastPayslipDraft[] = [];
  for (const row of summary.slice(2)) {
    const weekStart = isoOf(row?.[2]);
    const weekEnd = isoOf(row?.[3]);
    if (!row || !weekStart || !weekEnd || weekStart < FIRST_PAST_PAYSLIP || typeof row[27] !== 'number') continue;
    name = text(row[1]) || name;
    const p: PastPayslipDraft = {
      weekStart,
      weekEnd,
      paidOn: isoOf(row[28]),
      dailyRate: cents(row[6]),
      daysWorked: whole(row[5]),
      basic: cents(row[7]),
      overtimeHours: Math.round(num(row[11]) * 100),
      overtimePay: cents(row[12]),
      premiumPay: cents(row[16]),
      lateUndertime: cents(row[23]),
      sss: cents(row[19]),
      hdmf: cents(row[20]),
      phic: cents(row[21]),
      caRepayment: cents(row[22]),
      gross: cents(row[26]),
      net: cents(row[27]),
      caBalance: typeof row[29] === 'number' ? cents(row[29]) : null,
      days: [...days.values()].filter((d) => d.date >= weekStart && d.date <= weekEnd),
    };
    if (Math.abs(p.gross - (p.basic + p.overtimePay + p.premiumPay - p.lateUndertime)) > 2) warnings.push(`Week of ${weekStart}: the Gross does not match its parts.`);
    if (Math.abs(p.net - (p.gross - p.sss - p.hdmf - p.phic - p.caRepayment)) > 2) warnings.push(`Week of ${weekStart}: the Net does not match its parts.`);
    if (!p.paidOn) warnings.push(`Week of ${weekStart}: no date paid.`);
    payslips.push(p);
  }
  return { name, payslips, warnings };
}
