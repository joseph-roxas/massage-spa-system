import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { businessDayOf, lastCompletedPayWeek, weekdayOf } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Input, td, th } from '../components/ui';
import { useCan } from '../lib/auth';
import { longDate, parsePesos, peso, pesosText } from '../lib/format';
import { nextWeek, prevWeek, STATUS_LABELS, STATUS_TONE, usePayrollAction, usePayWeek, type BeforeGoLive, type Payroll, type PayrollKind, type RecordWeek } from '../lib/payroll';
import { CashAdvances } from './payroll/CashAdvances';
import { PayBreakdown } from './payroll/PayBreakdown';
import { DecemberPay } from './payroll/DecemberPay';
import { DeferredDeductions } from './payroll/DeferredDeductions';
import { PayrollTotals } from './payroll/PayrollTotals';

const KIND_TITLE: Record<PayrollKind, string> = { therapist: 'Therapists', receptionist: 'Receptionist', reliever: 'Outside Relievers (long cover)' };

function WeekTable({ kind, start, rows, ready }: { kind: PayrollKind; start: string; rows: Payroll[]; ready: boolean }) {
  const canApprove = useCan(kind === 'therapist' ? 'payroll.therapist.approve' : 'payroll.receptionist.manage');
  const act = usePayrollAction();
  const drafts = rows.filter((r) => r.status === 'draft');
  const approved = rows.filter((r) => r.status === 'approved');
  const allFixed = rows.length > 0 && drafts.length === 0;
  const total = (k: 'gross' | 'net' | 'caDeduction') => rows.reduce((s, r) => s + r[k], 0);
  const gov = (r: Payroll) => r.govSss + r.govPhic + r.govPagibig - r.govDeferred + r.govCollected;

  const [fromShopCash, setFromShopCash] = useState(true);
  const left = (r: Payroll) => (r.status === 'approved' ? Math.max(0, r.net - r.paid) : 0);
  const released = rows.filter((r) => r.status === 'released').length;
  const toRelease = rows.reduce((s, r) => s + left(r), 0);

  /** Part of the pay handed over now; the rest stays to be released. */
  function handOverPart(r: Payroll) {
    const text = prompt(`How much did you hand to ${r.displayName} now? ${peso(left(r))} is still to be released.`);
    if (text === null) return;
    const amount = parsePesos(text);
    if (!amount) return alert('Enter an amount, e.g. 1000.');
    act.mutate({ path: `/payrolls/${r.id}/releases`, body: { amount, fromShopCash } });
  }

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
            <Button disabled={act.isPending} onClick={() => confirm(`Hand over everything still owed to ${approved.length === 1 ? approved[0]!.displayName : `all ${approved.length}`}?`) && each(approved, 'release')}>
              {approved.length === 1 ? 'Paid in full' : `All ${approved.length} paid in full`}
            </Button>
          )}
        </div>
      }
    >
      {act.error && <Alert>{act.error.message}</Alert>}
      {allFixed && (
        <p className="mb-3 text-sm text-stone-600">
          {released} of {rows.length} fully released{toRelease > 0 && <> · <span className="font-semibold text-amber-800">{peso(toRelease)} still to be released</span></>}
        </p>
      )}
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
              <th className={`${th} text-right`}>Released</th>
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
                <td className={`${td} text-right tabular-nums`}>
                  {r.status === 'draft' ? '—' : peso(r.paid)}
                  {left(r) > 0 && <span className="block text-xs text-amber-800">{peso(left(r))} to go</span>}
                </td>
                <td className={td}>
                  {r.status === 'released' ? (
                    <Badge tone="stone">Fully released</Badge>
                  ) : r.status === 'approved' && r.paid > 0 ? (
                    <Badge tone="amber">Part released</Badge>
                  ) : (
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</Badge>
                  )}
                  {r.status === 'approved' && (
                    <div className="mt-1 flex flex-wrap gap-1 print:hidden">
                      {left(r) > 0 && (
                        <button type="button" className="text-xs text-teal-800 underline" disabled={act.isPending} onClick={() => handOverPart(r)}>
                          Hand over part
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-xs font-semibold text-teal-800 underline"
                        disabled={act.isPending}
                        onClick={() => (left(r) === 0 || confirm(`Hand over the rest, ${peso(left(r))}, to ${r.displayName}?`)) && act.mutate({ path: `/payrolls/${r.id}/release`, body: { fromShopCash } })}
                      >
                        Paid in full
                      </button>
                    </div>
                  )}
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
                <td className={`${td} text-right tabular-nums`}>{peso(rows.reduce((s, r) => s + r.paid, 0))}</td>
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

/** A week from before go-live: read only, from the owner's records. */
function RecordWeekTable({ rows }: { rows: RecordWeek[] }) {
  const total = (pick: (r: RecordWeek) => number) => rows.reduce((s, r) => s + pick(r), 0);
  return (
    <Card title="Therapists, from the records before go-live">
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Name</th>
            <th className={`${th} text-right`}>Days</th>
            <th className={`${th} text-right`}>Commission</th>
            <th className={`${th} text-right`}>SSS · PHIC · Pag-IBIG</th>
            <th className={`${th} text-right`}>Net pay</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((r) => (
            <tr key={r.staffId}>
              <td className={td}>{r.displayName}</td>
              <td className={`${td} text-right tabular-nums`}>{r.daysWorked}</td>
              <td className={`${td} text-right tabular-nums`}>{peso(r.gross)}</td>
              <td className={`${td} text-right tabular-nums text-stone-600`}>{r.gross - r.net ? `−${peso(r.gross - r.net)}` : '—'}</td>
              <td className={`${td} text-right font-semibold tabular-nums`}>{peso(r.net)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-stone-200 font-semibold">
            <td className={td}>Total</td>
            <td className={td} />
            <td className={`${td} text-right tabular-nums`}>{peso(total((r) => r.gross))}</td>
            <td className={td} />
            <td className={`${td} text-right tabular-nums`}>{peso(total((r) => r.net))}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}

function BeforeGoLiveRow({ person, start }: { person: BeforeGoLive; start: string }) {
  const [text, setText] = useState(person.amount === null ? '' : pesosText(person.amount));
  const act = usePayrollAction();
  const amount = parsePesos(text);
  return (
    <li className="flex items-center gap-3 py-1.5 text-sm">
      <span className="flex-1">{person.displayName}</span>
      <Input aria-label={`Commission before go-live for ${person.displayName}`} inputMode="decimal" className="w-28 rounded-md border border-stone-300 px-2 py-1 text-right text-sm tabular-nums" value={text} onChange={(e) => setText(e.target.value)} />
      <Button
        variant="secondary"
        className="h-8 px-3"
        disabled={amount === null || act.isPending}
        onClick={() => amount !== null && act.mutate({ path: `/payroll/weeks/${start}/before-go-live`, method: 'PUT', body: { staffId: person.staffId, amount } })}
      >
        Save
      </Button>
      {person.amount === null ? <Badge tone="amber">Needed</Badge> : <Badge>Saved</Badge>}
      {act.error && <span className="text-xs text-red-700">{act.error.message}</span>}
    </li>
  );
}

/** The first Pay Week began before go-live: its earlier days come from the written reports. */
function BeforeGoLiveCard({ people, start }: { people: BeforeGoLive[]; start: string }) {
  return (
    <Card title="Commission before go-live">
      <p className="mb-2 text-sm text-stone-600">This week began before the system did. Enter each therapist&rsquo;s Commission for the days before go-live, then press Recompute drafts. Enter 0 for anyone who didn&rsquo;t work those days. Payroll can&rsquo;t be approved until this is done.</p>
      <ul className="divide-y divide-stone-100">
        {people.map((p) => (
          <BeforeGoLiveRow key={p.staffId} person={p} start={start} />
        ))}
      </ul>
    </Card>
  );
}

export function PayrollPage() {
  const [params, setParams] = useSearchParams();
  const today = businessDayOf(new Date());
  const start = params.get('week') ?? lastCompletedPayWeek(today, 'therapist').start;
  // A Monday is a Therapist's Pay Week, a Sunday the Receptionist's.
  const forDesk = weekdayOf(start) === 0;
  const canDesk = useCan('payroll.receptionist.manage');
  const { data, error } = usePayWeek(start);
  const canDecember = useCan('payroll.therapist.approve');
  // `?tab=deferred` opens on a tab, e.g. from Needs Attention.
  const [tab, setTab] = useState<'payroll' | 'breakdown' | 'totals' | 'ca' | 'deferred' | 'december'>(() => {
    const asked = params.get('tab');
    return asked === 'deferred' || asked === 'december' || asked === 'totals' || asked === 'ca' || asked === 'breakdown' ? asked : 'payroll';
  });
  const go = (week: string) => setParams({ week });

  const ready = !!data && data.ended && data.unclosedDays.length === 0;
  const tabs = [
    ['payroll', 'Weekly payroll'],
    ['breakdown', 'Pay Breakdown'],
    ...(canDecember ? [['totals', 'Totals']] : []),
    ['ca', 'Cash Advances'],
    ...(canDecember ? [['deferred', 'Deferred Deductions'], ['december', 'December pay']] : []),
  ] as [typeof tab, string][];

  return (
    <div className="space-y-6">
      <div className={`flex flex-wrap items-center justify-between gap-3 ${tab === 'totals' ? 'print:hidden' : ''}`}>
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
        <div className="flex flex-wrap items-center gap-3 print:hidden">
            {canDesk && (
              <div className="flex rounded-md border border-stone-300 bg-white p-0.5 text-sm">
                <button type="button" onClick={() => go(lastCompletedPayWeek(today, 'therapist').start)} className={`rounded px-3 py-1.5 ${!forDesk ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
                  Therapists (Mon–Sun)
                </button>
                <button type="button" onClick={() => go(lastCompletedPayWeek(today).start)} className={`rounded px-3 py-1.5 ${forDesk ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
                  Receptionist (Sun–Sat)
                </button>
              </div>
            )}
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
          {data?.beforeGoLive && <BeforeGoLiveCard key={data.week.start} people={data.beforeGoLive} start={data.week.start} />}
          {data && data.fromRecords.length > 0 ? (
            <RecordWeekTable rows={data.fromRecords} />
          ) : (
            data?.kinds.map((k) => <WeekTable key={k} kind={k} start={data.week.start} rows={data.payrolls.filter((p) => p.kind === k)} ready={ready} />)
          )}
        </>
      )}
      {tab === 'totals' && <PayrollTotals />}
      {tab === 'ca' && <CashAdvances />}
      {tab === 'deferred' && <DeferredDeductions />}
      {tab === 'december' && <DecemberPay />}
    </div>
  );
}
