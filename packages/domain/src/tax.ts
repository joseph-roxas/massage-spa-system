import type { IsoDate } from './calendar';
import type { Centavos } from './money';

/** Percentage Tax for a non-VAT business: 3% of gross sales, filed quarterly on BIR Form 2551Q. */
export const PERCENTAGE_TAX_BP = 300;

/** "2026-Q3" */
export type Quarter = string;

export function isQuarter(value: string): boolean {
  return /^\d{4}-Q[1-4]$/.test(value);
}

export function quarterOf(date: IsoDate): Quarter {
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

export function quarterRange(q: Quarter): { start: IsoDate; end: IsoDate } {
  const y = Number(q.slice(0, 4));
  const first = (Number(q.slice(6)) - 1) * 3;
  const start = new Date(Date.UTC(y, first, 1));
  const end = new Date(Date.UTC(y, first + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function previousQuarter(q: Quarter): Quarter {
  const y = Number(q.slice(0, 4));
  const n = Number(q.slice(6));
  return n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`;
}

export function percentageTax(grossSales: number): Centavos {
  return Math.round((grossSales * PERCENTAGE_TAX_BP) / 10_000) as Centavos;
}

/**
 * When 2551Q is due: the 25th day after the quarter ends, moved to the next
 * working day if that falls on a weekend or Holiday.
 */
export function percentageTaxDue(q: Quarter, holidays: ReadonlySet<IsoDate> = new Set()): IsoDate {
  const d = new Date(`${quarterRange(q).end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 25);
  for (;;) {
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(iso)) return iso;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** Days from `today` to `due`: negative once overdue. */
export function daysUntil(due: IsoDate, today: IsoDate): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export type StatementLine = { label: string; amount: Centavos };

export type IncomeStatement = {
  revenue: StatementLine[];
  revenueTotal: Centavos;
  costs: StatementLine[];
  costTotal: Centavos;
  net: Centavos;
};

/** Revenue less every cost, dropping empty lines. */
export function incomeStatement(revenue: readonly StatementLine[], costs: readonly StatementLine[]): IncomeStatement {
  const sum = (xs: readonly StatementLine[]) => xs.reduce((s, x) => s + x.amount, 0) as Centavos;
  const r = revenue.filter((x) => x.amount !== 0);
  const c = costs.filter((x) => x.amount !== 0);
  return { revenue: r, revenueTotal: sum(r), costs: c, costTotal: sum(c), net: (sum(r) - sum(c)) as Centavos };
}
