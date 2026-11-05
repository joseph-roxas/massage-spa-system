import { manilaInstant } from './business-day';
import type { IsoDate } from './calendar';
import type { Centavos } from './money';

/** A Pay Week runs Sunday to Saturday. */
export type PayWeek = { start: IsoDate; end: IsoDate };

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: IsoDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function payWeekOf(date: IsoDate): PayWeek {
  const start = addDays(date, -weekdayOf(date));
  return { start, end: addDays(start, 6) };
}

/** The Pay Week before the one `date` falls in: the latest that has ended. */
export function lastCompletedPayWeek(date: IsoDate): PayWeek {
  return payWeekOf(addDays(payWeekOf(date).start, -1));
}

/** The first Pay Week that starts on or after `date`: a good day to go live. */
export function nextPayWeekStart(date: IsoDate): IsoDate {
  return weekdayOf(date) === 0 ? date : addDays(payWeekOf(date).end, 1);
}

export function daysOf(week: PayWeek): IsoDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(week.start, i));
}

export type GovShares = { sss: number; phic: number; pagibig: number };

/** `amount × num / den`, rounded half away from zero to the centavo. */
function share(amount: number, num: number, den: number): Centavos {
  const raw = (amount * num) / den;
  return (Math.sign(raw) * Math.round(Math.abs(raw))) as Centavos;
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

// ---------------------------------------------------------------- Therapists

export type TherapistDay = {
  date: IsoDate;
  services: number;
  commission: Centavos;
  /** The part of `commission` earned only because the day was a Holiday. */
  holidayExtra: Centavos;
  /** Pay for a Relief Shift that day, at the Minimum Wage Rate; not Commission. */
  reliefPay?: Centavos;
};

export type PayrollTotals = {
  gross: Centavos;
  govSss: Centavos;
  govPhic: Centavos;
  govPagibig: Centavos;
  caDeduction: Centavos;
  net: Centavos;
};

/** Government Deductions are withheld only in a week the person worked at least one day. Adjustments are part of gross. */
function totals(earned: number, adjustments: number, worked: boolean, gov: GovShares, caDeduction: number): PayrollTotals {
  const gross = earned + adjustments;
  const g = worked ? gov : { sss: 0, phic: 0, pagibig: 0 };
  return {
    gross: gross as Centavos,
    govSss: g.sss as Centavos,
    govPhic: g.phic as Centavos,
    govPagibig: g.pagibig as Centavos,
    caDeduction: caDeduction as Centavos,
    net: (gross - g.sss - g.phic - g.pagibig - caDeduction) as Centavos,
  };
}

/**
 * A Therapist's week: Gross is the Commission on every Service they did, less
 * Government Deductions and every Cash Advance taken against this week.
 */
export function therapistPayroll(input: {
  week: PayWeek;
  /** One per paid sale in the week; `holidayExtra` is what the Holiday rate added. */
  commissions: readonly { businessDay: IsoDate; amount: number; holidayExtra?: number }[];
  /** Business Days they clocked in. */
  daysWorked: readonly IsoDate[];
  gov: GovShares;
  cashAdvances: number;
  /** Σ of the week's Adjustments, signed. */
  adjustments?: number;
  /** Relief pay per Business Day, for Relief Shifts this week. */
  relief?: readonly { date: IsoDate; pay: number }[];
}): PayrollTotals & { days: TherapistDay[] } {
  const days = daysOf(input.week).map((date) => {
    const mine = input.commissions.filter((c) => c.businessDay === date);
    const reliefPay = sum((input.relief ?? []).filter((r) => r.date === date).map((r) => r.pay));
    return {
      date,
      services: mine.length,
      commission: sum(mine.map((c) => c.amount)) as Centavos,
      holidayExtra: sum(mine.map((c) => c.holidayExtra ?? 0)) as Centavos,
      ...(reliefPay ? { reliefPay: reliefPay as Centavos } : {}),
    };
  });
  const worked = input.daysWorked.length > 0 || input.commissions.length > 0;
  const earned = sum(days.map((d) => d.commission + (d.reliefPay ?? 0)));
  return { ...totals(earned, input.adjustments ?? 0, worked, input.gov, input.cashAdvances), days };
}

/** How much more a Therapist may take as a Cash Advance against a week: what is left of its net pay. */
export function cashAdvanceCap(netBeforeAdvances: number, alreadyTaken: number): Centavos {
  return Math.max(0, netBeforeAdvances - alreadyTaken) as Centavos;
}

// --------------------------------------------------------------- Receptionist

export type Premium = { workedPct: number; otPct: number };
export type DayKind = 'ordinary' | 'restDay' | 'special' | 'specialOnRestDay' | 'regular' | 'regularOnRestDay';
export type Premiums = Record<DayKind, Premium> & { regularUnworkedPct: number };
export type ShiftHours = { start: string; end: string; mealBreakMin: number };
export type HolidayType = 'regular' | 'special';

export type ReceptionistRules = { shift: ShiftHours; restWeekday: number; premiums: Premiums };

export function dayKind(weekday: number, restWeekday: number, holiday: HolidayType | null): DayKind {
  const rest = weekday === restWeekday;
  if (holiday === 'regular') return rest ? 'regularOnRestDay' : 'regular';
  if (holiday === 'special') return rest ? 'specialOnRestDay' : 'special';
  return rest ? 'restDay' : 'ordinary';
}

export type ReceptionistDay = {
  date: IsoDate;
  kind: DayKind;
  worked: boolean;
  lateMin: number;
  undertimeMin: number;
  overtimeMin: number;
  /** Minutes paid out of the 8-hour day, after Late and Undertime. */
  paidMin: number;
  /** Daily rate for the paid minutes at 100%; the base for 13th Month Pay. */
  basic: Centavos;
  /** What the day pays at its premium, Overtime excluded. */
  dayPay: Centavos;
  overtimePay: Centavos;
  /** Pay for a Regular Holiday not worked. */
  holidayPay: Centavos;
  total: Centavos;
  // How `dayPay` reads on a Payslip: fullBasic + premium − lateDeduction − undertimeDeduction = dayPay.
  dailyRate: Centavos;
  /** The daily rate on a day worked, 0 otherwise. */
  fullBasic: Centavos;
  /** What the day's premium adds to a full day (Rest Day, Special Day or Regular Holiday). */
  premium: Centavos;
  lateDeduction: Centavos;
  undertimeDeduction: Centavos;
};

type Entry = { clockIn: Date; clockOut: Date };

const minutes = (ms: number) => Math.floor(ms / 60_000);

/** Minutes of `entries` inside [from, to). */
function overlapMin(entries: readonly Entry[], from: Date, to: Date): number {
  return sum(entries.map((e) => minutes(Math.max(0, Math.min(+e.clockOut, +to) - Math.max(+e.clockIn, +from)))));
}

/**
 * One day of Receptionist pay. Late, Undertime and gaps longer than the meal
 * break come off the 8 paid hours; after an Early Close the shift ends then.
 * Time after the shift's end is Overtime, paid without approval.
 */
export function receptionistDay(input: {
  date: IsoDate;
  holiday: HolidayType | null;
  /** Closed DTR entries of the day. */
  entries: readonly Entry[];
  earlyCloseAt: Date | null;
  dailyRate: number;
  rules: ReceptionistRules;
}): ReceptionistDay {
  const { shift, premiums } = input.rules;
  const kind = dayKind(weekdayOf(input.date), input.rules.restWeekday, input.holiday);
  const start = manilaInstant(input.date, shift.start);
  let end = manilaInstant(input.date, shift.end);
  if (end <= start) end = new Date(+end + 86_400_000);
  const shiftEnd = input.earlyCloseAt && input.earlyCloseAt < end ? input.earlyCloseAt : end;
  const fullMin = minutes(+end - +start) - shift.mealBreakMin;
  const entries = [...input.entries].sort((a, b) => +a.clockIn - +b.clockIn);
  const zero = 0 as Centavos;

  const rate = input.dailyRate as Centavos;
  if (!entries.length) {
    const holidayPay = kind === 'regular' ? share(input.dailyRate, premiums.regularUnworkedPct, 100) : zero;
    return {
      date: input.date,
      kind,
      worked: false,
      lateMin: 0,
      undertimeMin: 0,
      overtimeMin: 0,
      paidMin: 0,
      basic: zero,
      dayPay: zero,
      overtimePay: zero,
      holidayPay,
      total: holidayPay,
      dailyRate: rate,
      fullBasic: zero,
      premium: zero,
      lateDeduction: zero,
      undertimeDeduction: zero,
    };
  }

  const first = entries[0]!.clockIn;
  const last = entries.reduce((m, e) => (e.clockOut > m ? e.clockOut : m), entries[0]!.clockOut);
  const lateMin = minutes(Math.max(0, Math.min(+first, +shiftEnd) - +start));
  const leftEarlyMin = minutes(Math.max(0, +shiftEnd - Math.max(+last, +start)));
  // Time away between the first punch-in and last punch-out, beyond the meal break.
  const windowFrom = new Date(Math.max(+first, +start));
  const windowTo = new Date(Math.min(+last, +shiftEnd));
  const span = minutes(Math.max(0, +windowTo - +windowFrom));
  const gapMin = Math.max(0, span - overlapMin(entries, windowFrom, windowTo) - shift.mealBreakMin);
  const undertimeMin = leftEarlyMin + gapMin;
  const paidMin = Math.max(0, fullMin - lateMin - undertimeMin);
  const overtimeMin = overlapMin(entries, end, new Date(+end + 86_400_000));

  const perDay = fullMin; // the daily rate buys this many minutes
  const basic = share(input.dailyRate, paidMin, perDay);
  const dayPay = share(input.dailyRate * paidMin, premiums[kind].workedPct, perDay * 100);
  const overtimePay = share(input.dailyRate * overtimeMin, premiums[kind].otPct, perDay * 100);
  // A full day at the premium, less what Late and Undertime cost; the split keeps the centavos exact.
  const premium = share(input.dailyRate, premiums[kind].workedPct - 100, 100);
  const lost = input.dailyRate + premium - dayPay;
  const lateDeduction = lateMin + undertimeMin ? share(lost, lateMin, lateMin + undertimeMin) : zero;
  return {
    date: input.date,
    kind,
    worked: true,
    lateMin,
    undertimeMin,
    overtimeMin,
    paidMin,
    basic,
    dayPay,
    overtimePay,
    holidayPay: zero,
    total: (dayPay + overtimePay) as Centavos,
    dailyRate: rate,
    fullBasic: rate,
    premium,
    lateDeduction,
    undertimeDeduction: (lost - lateDeduction) as Centavos,
  };
}

/** A Receptionist's week: the days' pay and Adjustments, less Government Deductions and the CA Repayment. */
export function receptionistPayroll(input: {
  days: readonly ReceptionistDay[];
  gov: GovShares;
  caRepayment: number;
  /** Σ of the week's Adjustments, signed. They are not basic pay. */
  adjustments?: number;
}): PayrollTotals & { basic: Centavos } {
  const earned = sum(input.days.map((d) => d.total));
  return {
    ...totals(earned, input.adjustments ?? 0, input.days.some((d) => d.worked), input.gov, input.caRepayment),
    basic: sum(input.days.map((d) => d.basic)) as Centavos,
  };
}

// -------------------------------------------------------------------- Relief

/** Covering the front desk this long or less takes no meal break. */
const SHORT_COVER_MIN = 5 * 60;

/**
 * Relief pay for one Relief Shift day: the Receptionist's rules (late,
 * undertime, Overtime, Holiday premiums) at the Minimum Wage Rate, with no Rest
 * Day premium (it is not the Reliever's rest day) and nothing for a day not
 * covered. Covering part of the day pays the minutes covered.
 */
export function reliefDay(input: {
  date: IsoDate;
  holiday: HolidayType | null;
  /** Closed relief entries of the day. */
  entries: readonly Entry[];
  earlyCloseAt: Date | null;
  minimumWage: number;
  rules: ReceptionistRules;
}): ReceptionistDay | null {
  if (!input.entries.length) return null;
  const { shift } = input.rules;
  const start = manilaInstant(input.date, shift.start);
  let end = manilaInstant(input.date, shift.end);
  if (end <= start) end = new Date(+end + 86_400_000);
  // A short cover (5 hours or less) has no meal break, so its hour is not taken off:
  // credit it by stretching the cover, within the shift.
  let entries = [...input.entries].sort((a, b) => +a.clockIn - +b.clockIn);
  if (overlapMin(entries, start, end) <= SHORT_COVER_MIN && shift.mealBreakMin > 0) {
    const ms = shift.mealBreakMin * 60_000;
    const last = entries.at(-1)!;
    const first = entries[0]!;
    if (+last.clockOut + ms <= +end) entries = [...entries.slice(0, -1), { ...last, clockOut: new Date(+last.clockOut + ms) }];
    else if (+first.clockIn - ms >= +start) entries = [{ ...first, clockIn: new Date(+first.clockIn - ms) }, ...entries.slice(1)];
  }
  return receptionistDay({
    date: input.date,
    holiday: input.holiday,
    entries,
    earlyCloseAt: input.earlyCloseAt,
    dailyRate: input.minimumWage,
    // No weekday is a Reliever's Rest Day.
    rules: { ...input.rules, restWeekday: -1 },
  });
}

/** This week's CA Repayment: the standing amount, never more than what is still owed. */
export function caRepaymentFor(standing: number, balance: number): Centavos {
  return Math.max(0, Math.min(standing, balance)) as Centavos;
}

// ------------------------------------------------------------- Payslip lines

export type EarningKey = 'commission' | 'holidayExtra' | 'reliefPay' | 'basic' | 'restDayPremium' | 'holidayPremium' | 'holidayUnworked' | 'overtime' | 'adjustments';
export type DeductionKey = 'late' | 'undertime' | 'sss' | 'phic' | 'pagibig' | 'ca';
export type PayLines = {
  earnings: Record<EarningKey, Centavos>;
  deductions: Record<DeductionKey, Centavos>;
  /** Everything earned before any deduction. */
  totalEarned: Centavos;
  totalDeductions: Centavos;
  /** Receptionist only: days with a DTR entry. */
  daysPresent: number;
};

/**
 * A Payroll as Payslip and Pay Breakdown lines. Late and Undertime, already
 * netted out of each day's pay, are shown as deductions so basic pay reads as
 * days present × daily rate. totalEarned − totalDeductions = net.
 */
export function payLines(
  input: PayrollTotals & { adjustments: number } & (
      | { kind: 'therapist'; days: readonly Partial<TherapistDay>[] }
      | { kind: 'receptionist' | 'reliever'; days: readonly Partial<ReceptionistDay>[] }
    ),
): PayLines {
  const z = 0 as Centavos;
  const earnings: Record<EarningKey, Centavos> = {
    commission: z,
    holidayExtra: z,
    reliefPay: z,
    basic: z,
    restDayPremium: z,
    holidayPremium: z,
    holidayUnworked: z,
    overtime: z,
    adjustments: input.adjustments as Centavos,
  };
  const deductions: Record<DeductionKey, Centavos> = { late: z, undertime: z, sss: input.govSss, phic: input.govPhic, pagibig: input.govPagibig, ca: input.caDeduction };
  const add = <K extends string>(rec: Record<K, Centavos>, key: K, v: number | undefined) => {
    rec[key] = (rec[key] + (v ?? 0)) as Centavos;
  };
  let daysPresent = 0;

  if (input.kind === 'therapist') {
    for (const d of input.days) {
      add(earnings, 'commission', (d.commission ?? 0) - (d.holidayExtra ?? 0));
      add(earnings, 'holidayExtra', d.holidayExtra);
      add(earnings, 'reliefPay', d.reliefPay);
    }
  } else {
    for (const d of input.days) {
      if (d.worked) daysPresent++;
      add(earnings, 'overtime', d.overtimePay);
      add(earnings, 'holidayUnworked', d.holidayPay);
      if (d.fullBasic === undefined) {
        // Payrolls from before these lines existed: the day's pay is all shown as basic.
        add(earnings, 'basic', d.dayPay);
        continue;
      }
      add(earnings, 'basic', d.fullBasic);
      add(earnings, d.kind === 'restDay' ? 'restDayPremium' : 'holidayPremium', d.premium);
      add(deductions, 'late', d.lateDeduction);
      add(deductions, 'undertime', d.undertimeDeduction);
    }
  }
  const totalEarned = sum(Object.values<number>(earnings)) as Centavos;
  const totalDeductions = sum(Object.values<number>(deductions)) as Centavos;
  return { earnings, deductions, totalEarned, totalDeductions, daysPresent };
}

// ------------------------------------------------------------------ December

/** Year-end Bonus: a year's Commission times the percentage the Super Admin chooses. */
export function yearEndBonus(commission: number, bp: number): Centavos {
  return share(commission, bp, 10_000);
}

/** 13th Month Pay: the year's basic pay divided by 12. */
export function thirteenthMonth(basicPay: number): Centavos {
  return share(basicPay, 1, 12);
}
