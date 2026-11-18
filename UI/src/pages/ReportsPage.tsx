import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { businessDayOf, choosesReportDates, monthRange, payWeekOf, previousMonth, reportsFor, type Column, type Report, type ReportName, type Row } from '@spa/domain';
import { Alert, Button, Card, Field, Input, Select, td, th } from '../components/ui';
import { useClockStaff } from '../lib/attendance';
import { useCan, useCurrentUser } from '../lib/auth';
import { longDate, peso } from '../lib/format';
import { download, REPORT_LABELS, useReport } from '../lib/reports';
import { DailyBars, Heatmap, RankedBars } from './reports/Charts';

function presets(today: string): [string, string, string][] {
  const month = today.slice(0, 7);
  const last = monthRange(previousMonth(month));
  return [
    ['Today', today, today],
    ['This week', payWeekOf(today).start, today],
    ['This month', `${month}-01`, today],
    ['Last month', last.start, last.end],
    ['This year', `${today.slice(0, 4)}-01-01`, today],
  ];
}

function cell(c: Column, v: Row[string] | undefined) {
  if (v === null || v === undefined || v === '') return '—';
  if (c.type === 'money') return peso(Number(v));
  // The totals row puts "Total" in the first column, which may be a date column.
  if (c.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? longDate(String(v)) : String(v);
  return String(v);
}

// Reports can run to a dozen columns; tighter cells keep them on a laptop screen.
const tightTh = th.replace('px-3', 'px-2');
const tightTd = td.replace('px-3', 'px-2');

function ReportTable({ report }: { report: Report }) {
  const num = (c: Column) => c.type === 'int' || c.type === 'money';
  if (!report.rows.length) return <p className="text-sm text-stone-500">Nothing in this range.</p>;
  // A dozen money columns only fit a laptop in smaller type.
  const wide = report.columns.length >= 10;
  const headClass = wide ? tightTh.replace('px-2', 'px-1').replace('tracking-wide', 'tracking-normal') : tightTh;
  const cellClass = wide ? tightTd.replace('text-sm', 'text-xs').replace('px-2', 'px-1') : tightTd;
  return (
    <div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            {report.columns.map((c) => (
              <th key={c.key} className={`${headClass} ${num(c) ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {report.rows.map((r, i) => (
            <tr key={i} className={r.rowKind === 'subtotal' ? 'bg-stone-50 font-semibold' : ''}>
              {report.columns.map((c) => (
                <td key={c.key} className={`${cellClass} ${num(c) ? 'whitespace-nowrap text-right tabular-nums' : ''}`}>
                  {cell(c, r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {report.totals && report.rows.length > 1 && (
          <tfoot>
            <tr className="border-t-2 border-stone-200 font-semibold">
              {report.columns.map((c) => (
                <td key={c.key} className={`${cellClass} ${num(c) ? 'whitespace-nowrap text-right tabular-nums' : ''}`}>
                  {report.totals![c.key] === null ? '' : cell(c, report.totals![c.key])}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Chart({ name, report }: { name: ReportName; report: Report }) {
  switch (name) {
    case 'daily-sales':
      return <DailyBars report={report} valueKey="services" label="Services paid" />;
    case 'therapist-sales':
      return <RankedBars report={report} labelKey="name" valueKey="regular" label="Sales per therapist (Regular Price)" />;
    case 'service-times':
      return <Heatmap report={report} />;
    case 'expenses':
      return <RankedBars report={report} labelKey="category" valueKey="amount" label="Spending by category" />;
    default:
      return null;
  }
}

export function ReportsPage() {
  const all = useCan('reports.all');
  const today = businessDayOf(new Date());
  const { data: me } = useCurrentUser();
  const allowed = me ? reportsFor(me.role) : [];
  const canPickDates = !!me && choosesReportDates(me.role);
  const [params, setParams] = useSearchParams();
  const name = (allowed.includes(params.get('r') as ReportName) ? params.get('r') : (allowed[0] ?? 'daily-sales')) as ReportName;
  // The owner starts on the month, the desk on today; Therapist Commission always starts on today.
  const from = canPickDates ? (params.get('from') ?? (all && name !== 'therapist-detail' ? `${today.slice(0, 7)}-01` : today)) : today;
  const to = canPickDates ? (params.get('to') ?? today) : today;
  const therapist = params.get('therapist') ?? '';
  const guest = params.get('guest') ?? '';
  const method = params.get('method') ?? '';
  const set = (patch: Record<string, string>) => setParams(Object.fromEntries(Object.entries({ r: name, from, to, therapist, guest, method, ...patch }).filter(([, v]) => v)));
  // The Guest box waits for a pause in typing before asking again.
  const [guestTyped, setGuestTyped] = useState(guest);
  useEffect(() => {
    const t = setTimeout(() => guestTyped !== guest && set({ guest: guestTyped }), 400);
    return () => clearTimeout(t);
  });
  const filters = name === 'therapist-detail' ? { therapist } : name === 'payments' ? { guest, method } : {};
  const { data, error, isFetching } = useReport(name, from, to, filters);
  const staff = useClockStaff();
  const report = data?.report;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <div className="grid gap-6 2xl:grid-cols-[14rem_1fr]">
        {/* A row of buttons above the report until the screen is wide enough for a side list. */}
        <nav className="flex flex-wrap gap-2 2xl:block 2xl:space-y-1">
          {allowed.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => set(r === 'therapist-detail' ? { r, from: today, to: today } : { r })}
              title={REPORT_LABELS[r].blurb}
              className={`block rounded-md border px-3 py-2 text-left text-sm 2xl:w-full 2xl:border-0 ${
                r === name ? 'border-teal-700 bg-teal-700 text-white' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100 2xl:bg-transparent'
              }`}
            >
              <span className="block font-medium">{REPORT_LABELS[r].title}</span>
              <span className={`hidden text-xs 2xl:block ${r === name ? 'text-teal-50' : 'text-stone-500'}`}>{REPORT_LABELS[r].blurb}</span>
            </button>
          ))}
          {!canPickDates && <p className="basis-full px-3 pt-2 text-xs text-stone-500">Today’s figures. The owner sees all reports.</p>}
        </nav>

        <div className="space-y-4">
          {canPickDates && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="From">
                <Input type="date" value={from} max={to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} min={from} onChange={(e) => e.target.value && set({ to: e.target.value })} />
              </Field>
              {name === 'payments' && (
                <>
                  <Field label="Guest">
                    <Input value={guestTyped} placeholder="Any guest" onChange={(e) => setGuestTyped(e.target.value)} />
                  </Field>
                  <Field label="Payment">
                    <Select value={method} onChange={(e) => set({ method: e.target.value })}>
                      <option value="">Cash and GCash</option>
                      <option value="cash">Cash</option>
                      <option value="gcash">GCash</option>
                    </Select>
                  </Field>
                </>
              )}
              {name === 'therapist-detail' && (
                <Field label="Therapist">
                  <Select value={therapist} onChange={(e) => set({ therapist: e.target.value })}>
                    <option value="">All therapists</option>
                    {staff.data?.staff
                      .filter((s) => s.kind === 'therapist')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.displayName}
                        </option>
                      ))}
                  </Select>
                </Field>
              )}
              <div className="flex flex-wrap gap-1 pb-0.5">
                {presets(today).map(([label, f, t]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => set({ from: f, to: t })}
                    className={`rounded-md border px-2.5 py-1.5 text-xs ${from === f && to === t ? 'border-teal-700 bg-teal-50 text-teal-800' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <Card
            title={`${REPORT_LABELS[name].title} · ${from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`}`}
            actions={
              report && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" className="h-8" onClick={() => download(report, 'xlsx', from, to)}>
                    Excel
                  </Button>
                  <Button variant="secondary" className="h-8" onClick={() => download(report, 'csv', from, to)}>
                    CSV
                  </Button>
                </div>
              )
            }
          >
            {error && <Alert>{error.message}</Alert>}
            {report && (
              <div className={isFetching ? 'opacity-60' : ''}>
                <Chart name={name} report={report} />
                <ReportTable report={report} />
                {report.note && <p className="mt-3 text-xs text-stone-500">{report.note}</p>}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
