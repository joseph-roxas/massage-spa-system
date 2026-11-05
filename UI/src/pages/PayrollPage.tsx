import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { businessDayOf, lastCompletedPayWeek } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, td, th } from '../components/ui';
import { useCan } from '../lib/auth';
import { longDate, peso } from '../lib/format';
import { nextWeek, prevWeek, STATUS_LABELS, STATUS_TONE, usePayrollAction, usePayWeek, type Payroll, type PayrollKind } from '../lib/payroll';
import { CashAdvances } from './payroll/CashAdvances';
import { PayBreakdown } from './payroll/PayBreakdown';
import { DecemberPay } from './payroll/DecemberPay';

const KIND_TITLE: Record<PayrollKind, string> = { therapist: 'Therapists', receptionist: 'Receptionist', reliever: 'Outside Relievers (long cover)' };

function WeekTable({ kind, start, rows, ready }: { kind: PayrollKind; start: string; rows: Payroll[]; ready: boolean }) {
  const canApprove = useCan(kind === 'therapist' ? 'payroll.therapist.approve' : 'payroll.receptionist.manage');
  const act = usePayrollAction();
  const drafts = rows.filter((r) => r.status === 'draft');
  const approved = rows.filter((r) => r.status === 'approved');
  const allFixed = rows.length > 0 && drafts.length === 0;
  const total = (k: 'gross' | 'net' | 'caDeduction') => rows.reduce((s, r) => s + r[k], 0);
  const gov = (r: Payroll) => r.govSss + r.govPhic + r.govPagibig;

  const [fromShopCash, setFromShopCash] = useState(true);

  async function each(list: Payroll[], step: 'approve' | 'release') {
    const body = step === 'release' ? { fromShopCash } : {};
    for (const r of list) await act.mutateAsync({ path: `/payrolls/${r.id}/${step}`, body }).catch(() => null);
  }

  return (
    <Card
      title={KIND_TITLE[kind]}
      actions={
        <div className="flex gap-2">
          {ready && !allFixed && (
            <Button variant={rows.length ? 'secondary' : 'primary'} disabled={act.isPending} onClick={() => act.mutate({ path: `/payroll/weeks/${start}/generate`, body: { kind } })}>
              {rows.length ? 'Recompute drafts' : 'Generate payroll'}
            </Button>
          )}
          {canApprove && drafts.length > 0 && (
            <Button disabled={act.isPending} onClick={() => each(drafts, 'approve')}>
              Approve {drafts.length === rows.length ? 'all' : drafts.length}
            </Button>
          )}
          {approved.length > 0 && (
            <Checkbox label="Paid from shop cash" checked={fromShopCash} onChange={(e) => setFromShopCash(e.target.checked)} />
          )}
          {approved.length > 0 && (
            <Button disabled={act.isPending} onClick={() => each(approved, 'release')}>
              Mark {approved.length === 1 ? '1' : approved.length} paid
            </Button>
          )}
        </div>
      }
    >
      {act.error && <Alert>{act.error.message}</Alert>}
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">{ready ? 'Not generated yet.' : 'Generate once the week has ended and every day is closed.'}</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Name</th>
              <th className={`${th} text-right`}>{kind === 'therapist' ? 'Commission' : 'Gross pay'}</th>
              <th className={`${th} text-right`}>SSS · PHIC · Pag-IBIG</th>
              <th className={`${th} text-right`}>CA</th>
              <th className={`${th} text-right`}>Net pay</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={td}>
                  <Link to={`/payroll/${r.id}`} className="font-medium text-teal-800 hover:underline">
                    {r.displayName}
                  </Link>
                </td>
                <td className={`${td} text-right tabular-nums`}>{peso(r.gross)}</td>
                <td className={`${td} text-right tabular-nums text-stone-600`}>−{peso(gov(r))}</td>
                <td className={`${td} text-right tabular-nums text-stone-600`}>{r.caDeduction ? `−${peso(r.caDeduction)}` : '—'}</td>
                <td className={`${td} text-right font-semibold tabular-nums ${r.net < 0 ? 'text-red-700' : ''}`}>{peso(r.net)}</td>
                <td className={td}>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-stone-200 font-semibold">
                <td className={td}>Total</td>
                <td className={`${td} text-right tabular-nums`}>{peso(total('gross'))}</td>
                <td className={td} />
                <td className={`${td} text-right tabular-nums`}>{total('caDeduction') ? `−${peso(total('caDeduction'))}` : '—'}</td>
                <td className={`${td} text-right tabular-nums`}>{peso(total('net'))}</td>
                <td className={td} />
              </tr>
            </tfoot>
          )}
        </table>
      )}
      {rows.some((r) => r.net < 0) && (
        <p className="mt-3 text-sm text-red-700">A negative net pay means the deductions are more than what was earned this week.</p>
      )}
    </Card>
  );
}

export function PayrollPage() {
  const [params, setParams] = useSearchParams();
  const start = params.get('week') ?? lastCompletedPayWeek(businessDayOf(new Date())).start;
  const { data, error } = usePayWeek(start);
  const canDecember = useCan('payroll.therapist.approve');
  const [tab, setTab] = useState<'payroll' | 'breakdown' | 'ca' | 'december'>('payroll');
  const go = (week: string) => setParams({ week });

  const ready = !!data && data.ended && data.unclosedDays.length === 0;
  const tabs = [
    ['payroll', 'Weekly payroll'],
    ...(canDecember ? [['breakdown', 'Pay Breakdown']] : []),
    ['ca', 'Cash Advances'],
    ...(canDecember ? [['december', 'December pay']] : []),
  ] as [typeof tab, string][];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <div className="flex rounded-md border border-stone-300 bg-white p-0.5 text-sm">
          {tabs.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)} className={`rounded px-3 py-1.5 ${tab === key ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {(tab === 'payroll' || tab === 'breakdown') && (
        <div className="flex items-center gap-3 print:hidden">
            <Button variant="secondary" onClick={() => go(prevWeek(start))} aria-label="Previous week">
              ‹
            </Button>
            <p className="min-w-64 text-center font-medium">
              {data ? `${longDate(data.week.start)} – ${longDate(data.week.end)}` : '…'}
            </p>
            <Button variant="secondary" onClick={() => go(nextWeek(start))} aria-label="Next week">
              ›
            </Button>
            {tab === 'breakdown' && (
              <Button variant="secondary" onClick={() => window.print()}>
                Print
              </Button>
            )}
        </div>
      )}
      {tab === 'breakdown' && <PayBreakdown start={start} />}
      {tab === 'payroll' && (
        <>
          {error && <Alert>{error.message}</Alert>}
          {data && !data.ended && <Alert tone="info">This Pay Week is not over yet. Its payroll can be generated from {longDate(nextWeek(data.week.start))}.</Alert>}
          {data && data.ended && data.unclosedDays.length > 0 && (
            <Alert>Close {data.unclosedDays.map(longDate).join(', ')} before generating this week’s payroll.</Alert>
          )}
          {data?.kinds.map((k) => (
            <WeekTable key={k} kind={k} start={data.week.start} rows={data.payrolls.filter((p) => p.kind === k)} ready={ready} />
          ))}
        </>
      )}
      {tab === 'ca' && <CashAdvances />}
      {tab === 'december' && <DecemberPay />}
    </div>
  );
}
