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

export type TherapistDay = { date: IsoDate; services: number; commission: Centavos };

export type PayrollTotals = {
  gross: Centavos;
  govSss: Centavos;
  govPhic: Centavos;
  govPagibig: Centavos;
  caDeduction: Centavos;
  net: Centavos;
};

/** Government Deductions are withheld only in a week the person worked at least one day. */
function totals(gross: number, worked: boolean, gov: GovShares, caDeduction: number): PayrollTotals {
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
  /** One per paid sale in the week. */
  commissions: readonly { businessDay: IsoDate; amount: number }[];
  /** Business Days they clocked in. */
  daysWorked: readonly IsoDate[];
  gov: GovShares;
  cashAdvances: number;
}): PayrollTotals & { days: TherapistDay[] } {
  const days = daysOf(input.week).map((date) => {
    const mine = input.commissions.filter((c) => c.businessDay === date);
    return { date, services: mine.length, commission: sum(mine.map((c) => c.amount)) as Centavos };
  });
  const worked = input.daysWorked.length > 0 || input.commissions.length > 0;
  return { ...totals(sum(days.map((d) => d.commission)), worked, input.gov, input.cashAdvances), days };
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

  if (!entries.length) {
    const holidayPay = kind === 'regular' ? share(input.dailyRate, premiums.regularUnworkedPct, 100) : zero;
    return { date: input.date, kind, worked: false, lateMin: 0, undertimeMin: 0, overtimeMin: 0, paidMin: 0, basic: zero, dayPay: zero, overtimePay: zero, holidayPay, total: holidayPay };
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
  };
}

/** A Receptionist's week: the days' pay, less Government Deductions and the chosen CA repayment. */
export function receptionistPayroll(input: {
  days: readonly ReceptionistDay[];
  gov: GovShares;
  caRepayment: number;
}): PayrollTotals & { basic: Centavos } {
  const gross = sum(input.days.map((d) => d.total));
  return {
    ...totals(gross, input.days.some((d) => d.worked), input.gov, input.caRepayment),
    basic: sum(input.days.map((d) => d.basic)) as Centavos,
  };
}

/** Next week's CA repayment: last week's amount, never more than what is still owed. */
export function defaultRepayment(lastRepayment: number, balance: number): Centavos {
  return Math.max(0, Math.min(lastRepayment, balance)) as Centavos;
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
