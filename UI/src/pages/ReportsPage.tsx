import { useSearchParams } from 'react-router';
import { businessDayOf, DAILY_REPORTS, monthRange, payWeekOf, previousMonth, REPORTS, type Column, type Report, type ReportName, type Row } from '@spa/domain';
import { Alert, Button, Card, Field, Input, td, th } from '../components/ui';
import { useCan } from '../lib/auth';
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
  if (c.type === 'date') return longDate(String(v));
  return String(v);
}

function ReportTable({ report }: { report: Report }) {
  const num = (c: Column) => c.type === 'int' || c.type === 'money';
  if (!report.rows.length) return <p className="text-sm text-stone-500">Nothing in this range.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            {report.columns.map((c) => (
              <th key={c.key} className={`${th} whitespace-nowrap ${num(c) ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {report.rows.map((r, i) => (
            <tr key={i}>
              {report.columns.map((c) => (
                <td key={c.key} className={`${td} whitespace-nowrap ${num(c) ? 'text-right tabular-nums' : ''}`}>
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
                <td key={c.key} className={`${td} whitespace-nowrap ${num(c) ? 'text-right tabular-nums' : ''}`}>
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
      return <RankedBars report={report} labelKey="name" valueKey="commission" label="Commission per therapist" />;
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
  const allowed = all ? REPORTS : DAILY_REPORTS;
  const [params, setParams] = useSearchParams();
  const name = (allowed.includes(params.get('r') as ReportName) ? params.get('r') : allowed[0]) as ReportName;
  const from = all ? (params.get('from') ?? `${today.slice(0, 7)}-01`) : today;
  const to = all ? (params.get('to') ?? today) : today;
  const set = (patch: Record<string, string>) => setParams({ r: name, from, to, ...patch });
  const { data, error, isFetching } = useReport(name, from, to);
  const report = data?.report;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <div className="grid grid-cols-[14rem_1fr] gap-6">
        <nav className="space-y-1">
          {allowed.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => set({ r })}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm ${r === name ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}
            >
              <span className="block font-medium">{REPORT_LABELS[r].title}</span>
              <span className={`block text-xs ${r === name ? 'text-teal-50' : 'text-stone-500'}`}>{REPORT_LABELS[r].blurb}</span>
            </button>
          ))}
          {!all && <p className="px-3 pt-2 text-xs text-stone-500">Today’s figures. The owner sees all reports.</p>}
        </nav>

        <div className="min-w-0 space-y-4">
          {all && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="From">
                <Input type="date" value={from} max={to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} min={from} onChange={(e) => e.target.value && set({ to: e.target.value })} />
              </Field>
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
                <div className="flex gap-2">
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
