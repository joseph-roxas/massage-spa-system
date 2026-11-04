import { useQuery } from '@tanstack/react-query';
import { toCsv, toXlsx, type Report, type ReportName } from '@spa/domain';
import { api } from './api';

export const REPORT_LABELS: Record<ReportName, { title: string; blurb: string }> = {
  'daily-sales': { title: 'Daily sales', blurb: 'Guests, sales, discounts, cash and GCash per day' },
  'therapist-sales': { title: 'Sales per therapist', blurb: 'Services, requests, FOCs and commission' },
  guests: { title: 'Guests per day', blurb: 'Walk-ins, scheduled, no-shows, cancelled' },
  'service-times': { title: 'Services by time of day', blurb: 'Which services start at which hour' },
  foc: { title: 'Discounts & FOCs', blurb: 'Senior, PWD, promo, vouchers, complimentary' },
  addons: { title: 'Add-ons', blurb: 'Extra oil and other add-ons sold' },
  payroll: { title: 'Payroll', blurb: 'Weekly pay, deductions and net' },
  inventory: { title: 'Inventory', blurb: 'Received, spent, taken out, on hand' },
  expenses: { title: 'Expenses', blurb: 'Spending by category' },
};

export const useReport = (name: ReportName, from: string, to: string) =>
  useQuery({
    queryKey: ['reports', name, from, to],
    queryFn: () => api<{ report: Report }>(`/reports/${name}?from=${from}&to=${to}`),
    placeholderData: (prev) => prev,
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
