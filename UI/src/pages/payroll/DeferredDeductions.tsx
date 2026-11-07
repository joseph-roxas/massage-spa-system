import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Input, td, th } from '../../components/ui';
import { api } from '../../lib/api';
import { longDate, parsePesos, peso, pesosText } from '../../lib/format';
import { usePayrollAction } from '../../lib/payroll';

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
  );
}
