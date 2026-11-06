import { useQuery } from '@tanstack/react-query';
import type { Cell, PastPayslipDay, Workbook } from '@spa/domain';
import { api } from './api';

export type BackfillStatus = {
  months: { month: string; days: number; received: number }[];
  therapistWeeks: number;
  pastPayslips: number;
  filings: number;
};

export const useBackfillStatus = () => useQuery({ queryKey: ['backfill'], queryFn: () => api<BackfillStatus>('/backfill/status') });

export type PastPayslipRow = { id: string; weekStart: string; weekEnd: string; paidOn: string | null; net: number; displayName?: string };
export type PastPayslip = PastPayslipRow & {
  fullName: string;
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
  caBalance: number | null;
  days: PastPayslipDay[];
};

export const usePastPayslips = () => useQuery({ queryKey: ['past-payslips'], queryFn: () => api<{ payslips: PastPayslipRow[] }>('/past-payslips') });
export const usePastPayslip = (id: string) => useQuery({ queryKey: ['past-payslips', id], queryFn: () => api<{ payslip: PastPayslip }>(`/past-payslips/${id}`) });

/** Reads every tab of an Excel file into plain rows of values; the heavy library loads only when needed. */
export async function readWorkbook(file: File): Promise<Workbook> {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await file.arrayBuffer());
  const sheets: Workbook = {};
  book.eachSheet((sheet) => {
    const grid: Cell[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, r) => {
      const cells: Cell[] = [];
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        cells[c - 1] = plain(cell.value);
      });
      grid[r - 1] = cells;
    });
    sheets[sheet.name] = grid;
  });
  return sheets;
}

/** A formula's stored result, rich text as text, errors as blank. */
function plain(value: unknown): Cell {
  if (value === null || value === undefined || value instanceof Date || typeof value !== 'object') return value as Cell;
  if ('result' in value) return plain(value.result);
  if ('richText' in value) return (value.richText as { text: string }[]).map((t) => t.text).join('');
  if ('text' in value) return value.text as string;
  return null;
}
