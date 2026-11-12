import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RefundStepKey } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Input, Select, td, th } from '../../components/ui';
import { api } from '../../lib/api';
import { longDate, parsePesos, peso, pesosText } from '../../lib/format';
import { STATUS_LABELS, STATUS_TONE, usePayrollAction, type PayrollStatus, type Refund } from '../../lib/payroll';

type Week = { weekStart: string; number: number; amount: number };
type Person = { staffId: string; displayName: string; notEnrolled: boolean; balance: number; opening: number | null; openingWeeks: Week[] | null; suggested: number; suggestedWeeks: Week[]; owedWeeks: Week[] };

const total = (weeks: readonly Week[]) => weeks.reduce((s, w) => s + w.amount, 0);

function OpeningRow({ person }: { person: Person }) {
  // Weeks from the record; any that were already set stay on the list.
  const choices = [...person.suggestedWeeks, ...(person.openingWeeks ?? []).filter((o) => !person.suggestedWeeks.some((w) => w.weekStart === o.weekStart))].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const [picked, setPicked] = useState(() => new Set((person.opening === null ? person.suggestedWeeks : (person.openingWeeks ?? [])).map((w) => w.weekStart)));
  const [text, setText] = useState(pesosText(person.opening ?? person.suggested));
  const act = usePayrollAction();
  const amount = parsePesos(text);
  const toggle = (start: string) => {
    const next = new Set(picked);
    if (!next.delete(start)) next.add(start);
    setPicked(next);
    setText(pesosText(total(choices.filter((w) => next.has(w.weekStart)))));
  };
  return (
    <tr className="align-top">
      <td className={td}>
        {person.displayName} {person.notEnrolled && <Badge>Not Enrolled</Badge>}
        {person.owedWeeks.length > 0 && <p className="mt-1 text-xs text-stone-500">Owed now: week{person.owedWeeks.length === 1 ? '' : 's'} {person.owedWeeks.map((w) => w.number).join(', ')}</p>}
        {choices.length > 0 && (
          <div className="mt-2 flex max-w-md flex-wrap gap-1" role="group" aria-label={`Weeks owed at go-live by ${person.displayName}`}>
            {choices.map((w) => (
              <button
                key={w.weekStart}
                type="button"
                aria-pressed={picked.has(w.weekStart)}
                title={`Week of ${longDate(w.weekStart)}: ${peso(w.amount)}`}
                className={`h-7 min-w-7 rounded border px-1.5 text-xs tabular-nums ${picked.has(w.weekStart) ? 'border-teal-700 bg-teal-700 text-white' : 'border-stone-300 bg-white text-stone-500 line-through'}`}
                onClick={() => toggle(w.weekStart)}
              >
                {w.number}
              </button>
            ))}
          </div>
        )}
      </td>
      <td className={`${td} text-right font-semibold tabular-nums`}>{peso(person.balance)}</td>
      <td className={`${td} text-right tabular-nums text-stone-500`}>{peso(person.suggested)}</td>
      <td className={`${td} text-right`}>
        <div className="flex items-center justify-end gap-2">
          <Input aria-label={`Opening balance for ${person.displayName}`} inputMode="decimal" className="w-28 rounded-md border border-stone-300 px-2 py-1 text-right text-sm tabular-nums" value={text} onChange={(e) => setText(e.target.value)} />
          <Button
            variant="secondary"
            className="h-8 px-3"
            disabled={amount === null || act.isPending}
            onClick={() => amount !== null && act.mutate({ path: '/deferred-deductions/opening', method: 'PUT', body: { staffId: person.staffId, amount, weeks: choices.filter((w) => picked.has(w.weekStart)).map(({ weekStart, amount: a }) => ({ weekStart, amount: a })) } })}
          >
            {person.opening === null ? 'Set' : 'Update'}
          </Button>
        </div>
        {act.error && <p className="mt-1 text-xs text-red-700">{act.error.message}</p>}
      </td>
    </tr>
  );
}

/** What each Therapist owes in Government Deductions, and what they owed at go-live. */
export function DeferredDeductions() {
  const { data, error } = useQuery({
    queryKey: ['payroll', 'deferred'],
    queryFn: () => api<{ takeHomeFloor: number; people: Person[] }>('/deferred-deductions'),
  });
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  return (
    <div className="space-y-6">
      <Card title="Deferred Deductions">
        <p className="mb-4 text-sm text-stone-600">
          Each Payroll takes only that week&rsquo;s Government Deductions, as long as the therapist keeps at least {peso(data.takeHomeFloor)}. What can&rsquo;t be taken stays here, and so does a week away with no work. Nothing is collected
          automatically after that: it comes off their last working week or the Year-end Bonus, or sooner if they ask. Every Payslip shows the weeks and the total. Before setting an opening balance, click off any week the shop did not remit.
        </p>
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Therapist</th>
              <th className={`${th} text-right`}>Owed now</th>
              <th className={`${th} text-right`}>From your records</th>
              <th className={`${th} text-right`}>Opening balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {data.people.map((p) => (
              <OpeningRow key={p.staffId} person={p} />
            ))}
          </tbody>
        </table>
      </Card>
      <RefundCard />
    </div>
  );
}

type RefundPerson = {
  staffId: string;
  displayName: string;
  kind: 'therapist' | 'receptionist';
  owed: number;
  owedWeeks: Week[];
  weeks: { weekStart: string; number: number; status: PayrollStatus | null }[];
  refund: (Refund & { status: PayrollStatus | null }) | null;
};

/** Pesos that may be below zero, for an agency taken short: "-32" → -3200 centavos. */
function parseSigned(text: string): number | null {
  const t = text.trim();
  const minus = t.startsWith('-');
  const n = parsePesos(minus ? t.slice(1) : t);
  return n === null ? null : minus ? -n : n;
}

const AGENCIES = [
  ['sss', 'SSS'],
  ['phic', 'PhilHealth'],
  ['pagibig', 'Pag-IBIG'],
] as const;

function SetRefund({ person }: { person: RefundPerson }) {
  const act = usePayrollAction();
  const open = person.weeks.find((w) => !w.status || w.status === 'draft');
  const [text, setText] = useState({ sss: '', phic: '', pagibig: '' });
  const [weekStart, setWeekStart] = useState(open?.weekStart ?? '');
  const shares = { sss: parseSigned(text.sss), phic: parseSigned(text.phic), pagibig: parseSigned(text.pagibig) };
  const total = shares.sss !== null && shares.phic !== null && shares.pagibig !== null ? shares.sss + shares.phic + shares.pagibig : null;
  const valid = total !== null && total > 0;
  const applied = valid ? Math.min(total, person.owed) : 0;
  return (
    <>
      <td className={`${td} text-right`}>
        <div className="flex flex-col items-end gap-1">
          {AGENCIES.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-xs text-stone-500">
              {label}
              <Input
                aria-label={`${label} refund for ${person.displayName}`}
                inputMode="decimal"
                placeholder="0.00"
                className="w-24 rounded-md border border-stone-300 px-2 py-1 text-right text-sm tabular-nums"
                value={text[k]}
                onChange={(e) => setText({ ...text, [k]: e.target.value })}
              />
            </label>
          ))}
          <span className="text-xs font-semibold tabular-nums">Refund {total === null ? '—' : peso(total)}</span>
        </div>
      </td>
      <td className={`${td} text-right tabular-nums`}>{valid ? peso(applied) : '—'}</td>
      <td className={`${td} text-right font-semibold tabular-nums`}>{valid ? peso(total - applied) : '—'}</td>
      <td className={`${td} text-right tabular-nums`}>{person.kind === 'therapist' && valid ? peso(person.owed - applied) : '—'}</td>
      <td className={td}>
        <Select aria-label={`Pay Week for ${person.displayName}`} value={weekStart} onChange={(e) => setWeekStart(e.target.value)}>
          {person.weeks.map((w) => (
            <option key={w.weekStart} value={w.weekStart} disabled={!!w.status && w.status !== 'draft'}>
              Week {w.number} · {longDate(w.weekStart)}
              {w.status ? ` · ${STATUS_LABELS[w.status]}` : ''}
            </option>
          ))}
        </Select>
        <div className="mt-1">
          <Button
            className="h-7 px-2 text-xs"
            disabled={!valid || !weekStart || act.isPending}
            onClick={() => valid && act.mutate({ path: '/deduction-refunds', body: { staffId: person.staffId, weekStart, ...shares } })}
          >
            Save refund
          </Button>
        </div>
        {total !== null && total <= 0 && <p className="mt-1 text-xs text-stone-500">Not over-deducted: no refund.</p>}
        {act.error && <p className="mt-1 text-xs text-red-700">{act.error.message}</p>}
      </td>
    </>
  );
}

function RefundRow({ person }: { person: RefundPerson }) {
  const act = usePayrollAction();
  const r = person.refund;
  const locked = !!r?.status && r.status !== 'draft';
  return (
    <tr className="align-top">
      <td className={td}>
        {person.displayName} <span className="text-xs text-stone-500">{person.kind === 'receptionist' ? 'Receptionist' : 'Therapist'}</span>
        {person.owedWeeks.length > 0 && (
          <p className="mt-1 text-xs text-stone-500">
            Owes week{person.owedWeeks.length === 1 ? '' : 's'} {person.owedWeeks.map((w) => w.number).join(', ')}
          </p>
        )}
      </td>
      <td className={`${td} text-right tabular-nums`}>{person.kind === 'therapist' ? peso(person.owed + (r?.applied ?? 0)) : '—'}</td>
      {r ? (
        <>
          <td className={`${td} text-right tabular-nums`}>
            {peso(r.total)}
            <p className="text-xs text-stone-500">
              SSS {peso(r.sss)} · PhilHealth {peso(r.phic)} · Pag-IBIG {peso(r.pagibig)}
            </p>
          </td>
          <td className={`${td} text-right tabular-nums`}>{peso(r.applied)}</td>
          <td className={`${td} text-right font-semibold tabular-nums`}>{peso(r.cash)}</td>
          <td className={`${td} text-right tabular-nums`}>{person.kind === 'therapist' ? peso(person.owed) : '—'}</td>
          <td className={td}>
            <p>
              Week of {longDate(r.weekStart)} {r.status && <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</Badge>}
            </p>
            <Button
              variant="secondary"
              className="mt-1 h-7 px-2 text-xs"
              disabled={act.isPending || locked}
              title={locked ? 'Send that Payroll back to draft first' : undefined}
              onClick={() => act.mutate({ path: `/deduction-refunds/${person.staffId}`, method: 'DELETE' })}
            >
              Remove
            </Button>
            {act.error && <p className="mt-1 text-xs text-red-700">{act.error.message}</p>}
          </td>
        </>
      ) : (
        <SetRefund person={person} />
      )}
    </tr>
  );
}

type RefundPlan = {
  payoutDate: string;
  ticked: RefundStepKey[];
  steps: { key: RefundStepKey; manual: boolean; title: string; detail: string; done: boolean; progress?: string }[];
  done: number;
  finished: boolean;
  remindFrom: string;
  daysLeft: number;
};

/** The to-do list for working out and paying the refund, with the payout date the reminder counts down to. */
function RefundChecklist({ plan }: { plan: RefundPlan }) {
  const act = usePayrollAction();
  const save = (patch: Partial<Pick<RefundPlan, 'payoutDate' | 'ticked'>>) => act.mutate({ path: '/deduction-refunds/plan', method: 'PUT', body: { payoutDate: plan.payoutDate, ticked: plan.ticked, ...patch } });
  const toggle = (key: RefundStepKey, on: boolean) => save({ ticked: on ? [...plan.ticked, key] : plan.ticked.filter((k) => k !== key) });
  return (
    <section className="mb-5 rounded-md border border-stone-200 bg-stone-50 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            To do · {plan.done} of {plan.steps.length} done
          </h3>
          <p className="text-xs text-stone-500">
            {plan.finished
              ? 'Every Payroll carrying a refund is released. Done.'
              : `Shown in Needs Attention from ${longDate(plan.remindFrom)} until every Payroll carrying a refund is released.`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          Payout date
          <Input type="date" className="w-40" value={plan.payoutDate} onChange={(e) => e.target.value && save({ payoutDate: e.target.value })} />
        </label>
      </div>
      {act.error && <Alert>{act.error.message}</Alert>}
      <ol className="mt-3 space-y-2">
        {plan.steps.map((step, i) => (
          <li key={step.key} className="flex gap-3 text-sm">
            <span
              aria-hidden
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${step.done ? 'bg-teal-700 text-white' : 'border border-stone-300 bg-white text-stone-500'}`}
            >
              {step.done ? '✓' : i + 1}
            </span>
            <div className="flex-1">
              <p className={step.done ? 'text-stone-500 line-through' : 'font-medium'}>
                {step.title}
                {step.progress && <span className="font-normal text-stone-500"> · {step.progress}</span>}
              </p>
              <p className="text-xs text-stone-500">{step.detail}</p>
              {step.manual && (
                <div className="mt-1">
                  <Checkbox label="Done" checked={plan.ticked.includes(step.key)} disabled={act.isPending} onChange={(e) => toggle(step.key, e.target.checked)} />
                </div>
              )}
              {!step.manual && !step.done && <p className="text-xs text-stone-400">Ticks itself from the Payrolls.</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The one-time Government Deduction Refund for January–November 2026 (ADR 0010). */
function RefundCard() {
  const { data, error } = useQuery({
    queryKey: ['payroll', 'refunds'],
    queryFn: () => api<{ plan: RefundPlan; people: RefundPerson[] }>('/deduction-refunds'),
  });
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  return (
    <Card title="Government Deduction Refund">
      <p className="mb-4 text-sm text-stone-600">
        For January to November 2026: what each person was charged, deducted or deferred, less their true monthly share for the months you remitted. Enter it by agency, with
        a minus sign for an agency taken short. It first comes off what they still owe in Deferred Deductions; the rest is added to the Payroll you pick as its own line, and
        the Payslip shows the agencies. One refund per person.
      </p>
      <RefundChecklist plan={data.plan} />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Staff</th>
              <th className={`${th} text-right`}>Owed before</th>
              <th className={`${th} text-right`}>Refund</th>
              <th className={`${th} text-right`}>Off what they owe</th>
              <th className={`${th} text-right`}>Cash on Payroll</th>
              <th className={`${th} text-right`}>Still owes after</th>
              <th className={th}>Pay Week</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {data.people.map((p) => (
              <RefundRow key={p.staffId} person={p} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
