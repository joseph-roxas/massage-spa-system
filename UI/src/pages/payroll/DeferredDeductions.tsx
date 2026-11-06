import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Input, td, th } from '../../components/ui';
import { api } from '../../lib/api';
import { parsePesos, peso, pesosText } from '../../lib/format';
import { usePayrollAction } from '../../lib/payroll';

type Person = { staffId: string; displayName: string; notEnrolled: boolean; balance: number; opening: number | null; suggested: number };

function OpeningRow({ person }: { person: Person }) {
  const [text, setText] = useState(pesosText(person.opening ?? person.suggested));
  const act = usePayrollAction();
  const amount = parsePesos(text);
  return (
    <tr>
      <td className={td}>
        {person.displayName} {person.notEnrolled && <Badge>Not Enrolled</Badge>}
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
            onClick={() => amount !== null && act.mutate({ path: '/deferred-deductions/opening', method: 'PUT', body: { staffId: person.staffId, amount } })}
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
        Each Payroll takes the week&rsquo;s Government Deductions and anything still owed, as long as the therapist keeps at least {peso(data.takeHomeFloor)}. What can&rsquo;t be taken stays here and is collected
        from later weeks by itself. Whatever is left in December comes off the Year-end Bonus. &ldquo;From your records&rdquo; adds up the skipped weeks in the workbook you loaded; set it once as the opening balance.
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
