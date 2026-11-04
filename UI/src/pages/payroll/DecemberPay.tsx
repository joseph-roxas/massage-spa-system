import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input, td, th } from '../../components/ui';
import { longDate, peso, percent, todayManila } from '../../lib/format';
import { useBonuses, usePayrollAction, type Bonus } from '../../lib/payroll';

function BonusTable({ rows, basisLabel }: { rows: Bonus[]; basisLabel: string }) {
  const act = usePayrollAction();
  if (!rows.length) return <p className="text-sm text-stone-500">Not computed yet.</p>;
  return (
    <>
      {act.error && <Alert>{act.error.message}</Alert>}
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Name</th>
            <th className={`${th} text-right`}>{basisLabel}</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((b) => (
            <tr key={b.id}>
              <td className={td}>{b.displayName}</td>
              <td className={`${td} text-right tabular-nums`}>{peso(b.basis)}</td>
              <td className={`${td} text-right font-semibold tabular-nums`}>{peso(b.amount)}</td>
              <td className={`${td} text-right`}>
                {b.paidAt ? (
                  <Badge>Paid {longDate(b.paidAt.slice(0, 10))}</Badge>
                ) : (
                  <Button variant="secondary" className="h-8" disabled={act.isPending} onClick={() => act.mutate({ path: `/bonuses/${b.id}/paid` })}>
                    Mark paid
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-stone-200 font-semibold">
            <td className={td}>Total</td>
            <td className={td} />
            <td className={`${td} text-right tabular-nums`}>{peso(rows.reduce((s, b) => s + b.amount, 0))}</td>
            <td className={td} />
          </tr>
        </tfoot>
      </table>
    </>
  );
}

/** Year-end Bonus for Therapists and 13th Month Pay for the Receptionist. */
export function DecemberPay() {
  const [year, setYear] = useState(Number(todayManila().slice(0, 4)));
  const { data } = useBonuses(year);
  const act = usePayrollAction();
  const rows = data?.bonuses ?? [];
  const yeb = rows.filter((b) => b.kind === 'year_end_bonus');
  const thirteenth = rows.filter((b) => b.kind === 'thirteenth_month');
  const [pct, setPct] = useState(yeb[0]?.bp ? String(yeb[0].bp / 100) : '');

  function computeYeb(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: '/bonuses/year-end', body: { year, bp: Math.round(Number(pct) * 100) } });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3">
        <Field label="Year">
          <Input type="number" min={2020} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" />
        </Field>
      </div>
      {act.error && <Alert>{act.error.message}</Alert>}

      <Card title="Year-end Bonus · Therapists">
        <p className="mb-3 text-sm text-stone-500">
          Each Therapist’s Commission for {year} times the percentage you choose. On-call Therapists are not included. Recomputing keeps bonuses already paid.
          {yeb[0]?.bp ? ` Last computed at ${percent(yeb[0].bp)}.` : ''}
        </p>
        <form onSubmit={computeYeb} className="mb-4 flex items-end gap-3">
          <Field label="Percentage (%)">
            <Input type="number" min={0.01} max={100} step={0.01} required value={pct} onChange={(e) => setPct(e.target.value)} placeholder="E.g. 8.13" className="w-32" />
          </Field>
          <Button type="submit" disabled={act.isPending || !pct}>
            Compute
          </Button>
        </form>
        <BonusTable rows={yeb} basisLabel="Commission" />
      </Card>

      <Card
        title="13th Month Pay · Receptionist"
        actions={
          <Button variant={thirteenth.length ? 'secondary' : 'primary'} disabled={act.isPending} onClick={() => act.mutate({ path: '/bonuses/thirteenth-month', body: { year } })}>
            {thirteenth.length ? 'Recompute' : 'Compute'}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-stone-500">
          The basic pay in {year}’s approved payrolls divided by 12. Basic pay leaves out overtime, premiums and unworked holiday pay.
        </p>
        <BonusTable rows={thirteenth} basisLabel="Basic pay" />
      </Card>
    </div>
  );
}
