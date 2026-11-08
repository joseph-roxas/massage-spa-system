import { toManila } from './calendar';

/** Every report is a table: typed columns and rows keyed by column. */
export type ColumnType = 'text' | 'int' | 'money' | 'date';
export type Column = { key: string; label: string; type: ColumnType };
export type Row = Record<string, string | number | null>;
export type Report = { title: string; columns: Column[]; rows: Row[]; totals?: Row; note?: string };

export const REPORTS = [
  'daily-sales',
  'therapist-sales',
  'guests',
  'service-times',
  'foc',
  'payroll',
  'inventory',
  'expenses',
] as const;
export type ReportName = (typeof REPORTS)[number];

/** What the Receptionist may run: today's operational figures only. */
export const DAILY_REPORTS: readonly ReportName[] = ['daily-sales', 'guests'];

/** Sums the money and count columns of `rows`. */
export function totalsOf(columns: readonly Column[], rows: readonly Row[], label = 'Total'): Row {
  const out: Row = {};
  columns.forEach((c, i) => {
    if (c.type === 'int' || c.type === 'money') out[c.key] = rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
    else out[c.key] = i === 0 ? label : null;
  });
  return out;
}

/** The Manila hour (0–23) a Service started. */
export function manilaHour(iso: string): number {
  return Number(toManila(new Date(iso)).time.slice(0, 2));
}

/**
 * Services × hour of day they started: how busy each hour is for each Service.
 * Hours run from the earliest to the latest seen, wrapping past midnight
 * (a 1am start sorts after 11pm).
 */
export function serviceTimes(starts: readonly { service: string; startedAt: string }[]): { hours: number[]; rows: { service: string; counts: Record<number, number>; total: number }[] } {
  const order = (h: number) => (h < 6 ? h + 24 : h);
  const byService = new Map<string, Record<number, number>>();
  const seen = new Set<number>();
  for (const s of starts) {
    const h = manilaHour(s.startedAt);
    seen.add(h);
    const counts = byService.get(s.service) ?? {};
    counts[h] = (counts[h] ?? 0) + 1;
    byService.set(s.service, counts);
  }
  const hours = [...seen].sort((a, b) => order(a) - order(b));
  const span = hours.length ? Array.from({ length: order(hours.at(-1)!) - order(hours[0]!) + 1 }, (_, i) => (order(hours[0]!) + i) % 24) : [];
  const rows = [...byService]
    .map(([service, counts]) => ({ service, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.service.localeCompare(b.service));
  return { hours: span, rows };
}

export const FOC_LABELS = {
  senior: 'Senior Citizen (20%)',
  pwd: 'PWD (20%)',
  promo: 'Promo',
  voucher_paid: 'Voucher, paid · Prepaid FOC',
  voucher_free: 'Voucher, free 5+1 · Real FOC',
  complimentary: 'Complimentary · Real FOC',
} as const;
export type FocGroup = keyof typeof FOC_LABELS;

/** Which FOC / Discount group a sale belongs to, or null for a full-price sale. */
export function focGroup(discountType: string, focKind: string): FocGroup | null {
  switch (discountType) {
    case 'senior':
    case 'pwd':
    case 'promo':
    case 'complimentary':
      return discountType;
    case 'voucher':
      return focKind === 'real' ? 'voucher_free' : 'voucher_paid';
    default:
      return null;
  }
}
