import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, Input, td, th } from '../../components/ui';
import { longDate, parsePesos, peso, percent, pesosText, todayManila } from '../../lib/format';
import { useBonuses, useBonusSuggestion, useOpeningBasic, usePayrollAction, type Bonus, type OpeningBasic } from '../../lib/payroll';

function BonusTable({ rows, basisLabel, deductions = false }: { rows: Bonus[]; basisLabel: string; deductions?: boolean }) {
  const act = usePayrollAction();
  if (!rows.length) return <p className="text-sm text-stone-500">Not computed yet.</p>;
  return (
    <>
      {act.error && <Alert>{act.error.message}</Alert>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Name</th>
              <th className={`${th} text-right`}>{basisLabel}</th>
              <th className={`${th} text-right`}>Amount</th>
              {deductions && <th className={`${th} text-right`}>Deferred Deductions</th>}
              {deductions && <th className={`${th} text-right`}>Takes home</th>}
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((b) => (
              <tr key={b.id}>
                <td className={td}>{b.displayName}</td>
                <td className={`${td} text-right tabular-nums`}>{peso(b.basis)}</td>
                <td className={`${td} text-right tabular-nums ${deductions ? '' : 'font-semibold'}`}>{peso(b.amount)}</td>
                {deductions && <td className={`${td} text-right tabular-nums`}>{b.deduction ? `−${peso(b.deduction)}` : '—'}</td>}
                {deductions && <td className={`${td} text-right font-semibold tabular-nums`}>{peso(b.amount - b.deduction)}</td>}
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
              {deductions && <td className={`${td} text-right tabular-nums`}>{peso(rows.reduce((s, b) => s + b.deduction, 0))}</td>}
              {deductions && <td className={`${td} text-right tabular-nums`}>{peso(rows.reduce((s, b) => s + b.amount - b.deduction, 0))}</td>}
              <td className={td} />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

/** What percentage the year can carry. The owner still chooses. */
function Suggestion({ year, onUse }: { year: number; onUse: (percentage: string) => void }) {
  const [share, setShare] = useState('30');
  const shareBp = Math.round(Number(share) * 100);
  const valid = share !== '' && shareBp >= 0 && shareBp <= 10_000;
  const { data, error } = useBonusSuggestion(year, valid ? shareBp : 3000);
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  return (
    <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 p-3">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Share of profit to give (%)">
          <Input type="number" min={0} max={100} step={1} value={share} onChange={(e) => setShare(e.target.value)} className="w-24" />
        </Field>
        <div className="text-sm">
          <p className="text-stone-500">Profit, {longDate(data.period.start)} to {longDate(data.period.end)}</p>
          <p className="font-semibold tabular-nums">{peso(data.profit)}</p>
        </div>
        <div className="text-sm">
          <p className="text-stone-500">Commission</p>
          <p className="font-semibold tabular-nums">{peso(data.commission)}</p>
        </div>
        <div className="text-sm">
          <p className="text-stone-500">Suggested</p>
          <p className="font-semibold tabular-nums">{data.bp ? percent(data.bp) : 'None'}</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-stone-500">
        Profit is after {peso(data.thirteenthMonth)} 13th Month Pay. Bills for the last month that aren’t entered yet would lower it. Your usual range is 5% to 7%.
      </p>
      {!data.bp && <p className="mt-2 text-sm text-stone-700">There is no profit to share in this period. The choice is still yours.</p>}
      <table className="mt-3 w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Percentage</th>
            <th className={`${th} text-right`}>Bonus cost</th>
            <th className={`${th} text-right`}>Profit left</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {data.scenarios.map((s) => (
            <tr key={s.bp}>
              <td className={td}>
                {percent(s.bp)}
                {s.bp === data.bp && <span className="ml-2 text-xs text-stone-500">Suggested</span>}
              </td>
              <td className={`${td} text-right tabular-nums`}>{peso(s.cost)}</td>
              <td className={`${td} text-right tabular-nums ${s.left < 0 ? 'text-red-700' : ''}`}>{peso(s.left)}</td>
              <td className={`${td} text-right`}>
                <button type="button" className="text-xs text-stone-500 underline" onClick={() => onUse(String(s.bp / 100))}>
                  Use
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpeningBasicRow({ year, person }: { year: number; person: OpeningBasic }) {
  const act = usePayrollAction();
  const [text, setText] = useState(pesosText(person.amount ?? person.suggested));
  const amount = parsePesos(text);
  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount !== null) act.mutate({ path: '/bonuses/opening-basic', method: 'PUT', body: { year, staffId: person.staffId, amount } });
      }}
    >
      <Field label={`${person.displayName}: basic pay before Go-live`}>
        <Input inputMode="decimal" required value={text} onChange={(e) => setText(e.target.value)} className="w-40" />
      </Field>
      <Button type="submit" variant="secondary" disabled={amount === null || act.isPending}>
        {person.amount === null ? 'Set' : 'Save'}
      </Button>
      <p className="basis-full text-xs text-stone-500">
        {person.amount === null ? 'Not set yet. ' : ''}
        The Past Payslips add up to {peso(person.suggested)}, less late and undertime. Add any days they don’t cover.
      </p>
      {act.error && <Alert>{act.error.message}</Alert>}
    </form>
  );
}

/** Year-end Bonus for Therapists and 13th Month Pay for the Receptionist. */
export function DecemberPay() {
  const [year, setYear] = useState(Number(todayManila().slice(0, 4)));
  const { data } = useBonuses(year);
  const opening = useOpeningBasic(year);
  const act = usePayrollAction();
  const rows = data?.bonuses ?? [];
  const yeb = rows.filter((b) => b.kind === 'year_end_bonus');
  const thirteenth = rows.filter((b) => b.kind === 'thirteenth_month');
  const [pct, setPct] = useState('');
  const shown = pct || (yeb[0]?.bp ? String(yeb[0].bp / 100) : '');

  function computeYeb(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: '/bonuses/year-end', body: { year, bp: Math.round(Number(shown) * 100) } });
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
          Each Therapist’s Commission since last year’s cut-off, through the last finished Pay Week, times the percentage you choose. Any Deferred Deductions they still owe come off when you mark it paid.
          On-call Therapists are not included. Computing again keeps bonuses already paid.
          {yeb[0]?.bp ? ` Last computed at ${percent(yeb[0].bp)}.` : ''}
        </p>
        <Suggestion key={year} year={year} onUse={setPct} />
        <form onSubmit={computeYeb} className="mb-4 flex items-end gap-3">
          <Field label="Percentage (%)">
            <Input type="number" min={0.01} max={100} step={0.01} required value={shown} onChange={(e) => setPct(e.target.value)} placeholder="E.g. 6" className="w-32" />
          </Field>
          <Button type="submit" disabled={act.isPending || !shown}>
            Compute
          </Button>
        </form>
        <BonusTable rows={yeb} basisLabel="Commission" deductions />
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
          The basic pay before Go-live plus the basic pay in {year}’s approved payrolls, divided by 12. Basic pay leaves out overtime, premiums and unworked holiday pay.
        </p>
        {opening.data?.people.map((p) => <OpeningBasicRow key={`${year}-${p.staffId}-${p.amount}-${p.suggested}`} year={year} person={p} />)}
        <BonusTable rows={thirteenth} basisLabel="Basic pay" />
      </Card>
    </div>
  );
}
