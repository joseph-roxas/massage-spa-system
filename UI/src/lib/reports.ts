import { useQuery } from '@tanstack/react-query';
import { toCsv, toXlsx, type Report, type ReportName } from '@spa/domain';
import { api } from './api';

export const REPORT_LABELS: Record<ReportName, { title: string; blurb: string }> = {
  'daily-sales': { title: 'Daily sales', blurb: 'Guests, sales, discounts, cash and GCash per day' },
  payments: { title: 'Payments', blurb: 'Each payment: time, guest, amount, cash or GCash' },
  'therapist-sales': { title: 'Sales per therapist', blurb: 'Services, requests, FOCs and commission' },
  'therapist-detail': { title: 'Therapist Commission', blurb: 'Each service, its price and commission' },
  'therapist-changes': { title: 'Therapist Changes', blurb: 'Who took over a service, and why' },
  guests: { title: 'Guests per day', blurb: 'Walk-ins, scheduled, no-shows, cancelled' },
  'service-times': { title: 'Services by time of day', blurb: 'Which services start at which hour' },
  foc: { title: 'Discounts & FOCs', blurb: 'Senior, PWD, promo, vouchers, complimentary' },
  payroll: { title: 'Payroll', blurb: 'Weekly pay, deductions and net' },
  inventory: { title: 'Inventory', blurb: 'Received, spent, taken out, on hand' },
  expenses: { title: 'Expenses', blurb: 'Spending by category' },
};

/** Filters some reports take besides the dates; empty ones are left out. */
export type ReportFilters = { therapist?: string; guest?: string; method?: string };

export const useReport = (name: ReportName, from: string, to: string, filters: ReportFilters = {}) =>
  useQuery({
    queryKey: ['reports', name, from, to, filters],
    queryFn: () => {
      const q = new URLSearchParams({ from, to });
      for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
      return api<{ report: Report }>(`/reports/${name}?${q}`);
    },
    // Keep the last figures while new dates load, but never another report's rows under this one's chart.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === name ? prev : undefined),
  });

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads the table as shown, with the totals row last. */
export function download(report: Report, format: 'csv' | 'xlsx', from: string, to: string) {
  const rows = report.totals ? [...report.rows, report.totals] : report.rows;
  const base = `${report.title} ${from === to ? from : `${from} to ${to}`}`;
  if (format === 'csv') save(new Blob([toCsv(report.columns, rows)], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
  else save(new Blob([toXlsx(report.title, report.columns, rows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${base}.xlsx`);
}
