import { useState, type FormEvent } from 'react';
import { monthOf, monthRange, previousQuarter, quarterOf, quarterRange } from '@spa/domain';
import { Alert, Badge, Button, Card, Field, FormPanel, Input, Select, td } from '../components/ui';
import { useCan } from '../lib/auth';
import { dueText, useFinanceAction, useIncomeStatement, usePercentageTax, type QuarterStatus, type Statement } from '../lib/finance';
import { longDate, parsePesos, peso, pesosText, todayManila } from '../lib/format';

type Period = 'month' | 'quarter' | 'year';

function rangeOf(period: Period, value: string): { from: string; to: string } {
  if (period === 'month') {
    const r = monthRange(value);
    return { from: r.start, to: r.end };
  }
  if (period === 'quarter') {
    const r = quarterRange(value);
    return { from: r.start, to: r.end };
  }
  return { from: `${value}-01-01`, to: `${value}-12-31` };
}

const defaultValue = (period: Period, today: string) => (period === 'month' ? monthOf(today) : period === 'quarter' ? quarterOf(today) : today.slice(0, 4));

/** The last 12 months, 8 quarters or 4 years to choose from, newest first. */
function choices(period: Period, today: string): string[] {
  const out: string[] = [];
  if (period === 'year') for (let y = Number(today.slice(0, 4)); out.length < 4; y--) out.push(String(y));
  if (period === 'quarter') for (let q = quarterOf(today); out.length < 8; q = previousQuarter(q)) out.push(q);
  if (period === 'month') {
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    while (out.length < 12) {
      out.push(d.toISOString().slice(0, 7));
      d.setUTCMonth(d.getUTCMonth() - 1);
    }
  }
  return out;
}

function Lines({ title, lines, prev, total, prevTotal }: { title: string; lines: Statement['revenue']; prev: Statement['revenue']; total: number; prevTotal: number }) {
  const labels = [...new Set([...lines.map((l) => l.label), ...prev.map((l) => l.label)])];
  const amount = (xs: Statement['revenue'], label: string) => xs.find((x) => x.label === label)?.amount ?? 0;
  return (
    <>
      <tr>
        <td colSpan={3} className="px-3 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
          {title}
        </td>
      </tr>
      {labels.map((label) => (
        <tr key={label}>
          <td className={td}>{label}</td>
          <td className={`${td} text-right tabular-nums`}>{peso(amount(lines, label))}</td>
          <td className={`${td} text-right tabular-nums text-stone-500`}>{peso(amount(prev, label))}</td>
        </tr>
      ))}
      <tr className="border-t border-stone-200 font-semibold">
        <td className={td}>Total {title.toLowerCase()}</td>
        <td className={`${td} text-right tabular-nums`}>{peso(total)}</td>
        <td className={`${td} text-right tabular-nums text-stone-500`}>{peso(prevTotal)}</td>
      </tr>
    </>
  );
}

function IncomeStatementCard() {
  const today = todayManila();
  const [period, setPeriod] = useState<Period>('month');
  const [value, setValue] = useState(defaultValue('month', today));
  const { from, to } = rangeOf(period, value);
  const { data, error } = useIncomeStatement(from, to);
  const recompute = useFinanceAction();
  const c = data?.current;
  const p = data?.lastYear;

  return (
    <Card title="Income Statement">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Period">
          <Select
            value={period}
            onChange={(e) => {
              const next = e.target.value as Period;
              setPeriod(next);
              setValue(defaultValue(next, today));
            }}
          >
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="year">Year</option>
          </Select>
        </Field>
        <Field label={period === 'month' ? 'Month' : period === 'quarter' ? 'Quarter' : 'Year'}>
          <Select value={value} onChange={(e) => setValue(e.target.value)}>
            {choices(period, today).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <span className="flex-1" />
        <Button variant="secondary" disabled={recompute.isPending} onClick={() => recompute.mutate({ path: '/expenses/contributions/draft', body: { month: monthOf(today) } })}>
          Recompute this month’s employer contributions
        </Button>
      </div>
      {(error || recompute.error) && <Alert>{(error ?? recompute.error)!.message}</Alert>}
      {recompute.data && <Alert tone="success">Employer contributions for {monthOf(today)}: {peso(recompute.data.amount ?? 0)}, waiting for you to confirm under Expenses.</Alert>}
      {c && p && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                <th className="px-3 py-2 text-left font-semibold">
                  {longDate(from)} – {longDate(to)}
                </th>
                <th className="px-3 py-2 text-right font-semibold">This period</th>
                <th className="px-3 py-2 text-right font-semibold">A year earlier</th>
              </tr>
            </thead>
            <tbody>
              <Lines title="Revenue" lines={c.revenue} prev={p.revenue} total={c.revenueTotal} prevTotal={p.revenueTotal} />
              <tr>
                <td className={`${td} text-xs text-stone-500`}>Discounts given (already taken off Services)</td>
                <td className={`${td} text-right text-xs tabular-nums text-stone-500`}>{peso(c.discounts)}</td>
                <td className={`${td} text-right text-xs tabular-nums text-stone-500`}>{peso(p.discounts)}</td>
              </tr>
              <Lines title="Costs" lines={c.costs} prev={p.costs} total={c.costTotal} prevTotal={p.costTotal} />
              <tr className="border-t-2 border-stone-300 text-base font-semibold">
                <td className={td}>{c.net >= 0 ? 'Net profit' : 'Net loss'}</td>
                <td className={`${td} text-right tabular-nums ${c.net < 0 ? 'text-red-700' : 'text-teal-800'}`}>{peso(c.net)}</td>
                <td className={`${td} text-right tabular-nums text-stone-500`}>{peso(p.net)}</td>
              </tr>
            </tbody>
          </table>
          {c.pending.length > 0 && (
            <Alert tone="info">
              Not counted yet, waiting for you to confirm under Expenses: {c.pending.map((x) => `${x.label} ${peso(x.amount)}`).join(', ')}.
            </Alert>
          )}
          <p className="mt-2 text-xs text-stone-500">
            Commission counts on the day of the Service, receptionist pay on the day worked, purchases and expenses on the day paid.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Records the 2551Q as filed and paid. */
function FileForm({ status, onDone }: { status: QuarterStatus; onDone: () => void }) {
  const act = useFinanceAction();
  const [filedOn, setFiledOn] = useState(todayManila());
  const [amount, setAmount] = useState(pesosText(status.tax));
  const paid = parsePesos(amount);
  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: `/finance/percentage-tax/${status.quarter}/file`, body: { filedOn, amountPaid: paid } }, { onSuccess: onDone });
  }
  return (
    <FormPanel onSubmit={submit}>
      {act.error && <Alert>{act.error.message}</Alert>}
      <div className="grid grid-cols-2 gap-3 sm:w-96">
        <Field label="Filed and paid on">
          <Input type="date" required max={todayManila()} value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
        </Field>
        <Field label="Amount paid (₱)">
          <Input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-stone-500">This records the payment as a BIR Expense.</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={paid === null || act.isPending}>Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

function PercentageTaxCard() {
  const canFile = useCan('expenses.manage');
  const today = todayManila();
  const [quarter, setQuarter] = useState(previousQuarter(quarterOf(today)));
  const { data: s, error } = usePercentageTax(quarter);
  const [filing, setFiling] = useState(false);
  const over = s ? quarterRange(s.quarter).end < today : false;

  return (
    <Card title="Percentage Tax (BIR 2551Q)">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Quarter">
          <Select
            value={quarter}
            onChange={(e) => {
              setQuarter(e.target.value);
              setFiling(false);
            }}
          >
            {choices('quarter', today).map((q) => (
              <option key={q} value={q}>
                {q}
                {q === quarterOf(today) ? ' (so far)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error && <Alert>{error.message}</Alert>}
      {s && (
        <div className="space-y-3 text-sm">
          <table className="w-full sm:w-96">
            <tbody>
              <tr>
                <td className={td}>Services received</td>
                <td className={`${td} text-right tabular-nums`}>{peso(s.grossSales.services)}</td>
              </tr>
              <tr>
                <td className={td}>Vouchers sold</td>
                <td className={`${td} text-right tabular-nums`}>{peso(s.grossSales.vouchers)}</td>
              </tr>
              <tr className="border-t border-stone-200">
                <td className={td}>Gross sales</td>
                <td className={`${td} text-right tabular-nums`}>{peso(s.grossSales.total)}</td>
              </tr>
              <tr className="text-base font-semibold">
                <td className={td}>3% Percentage Tax</td>
                <td className={`${td} text-right tabular-nums`}>{peso(s.tax)}</td>
              </tr>
            </tbody>
          </table>
          {s.filing ? (
            <p>
              <Badge tone="teal">Filed</Badge> {longDate(s.filing.filedOn)}, paid {peso(s.filing.amountPaid)}.
            </p>
          ) : over ? (
            <>
              <p className={s.daysLeft <= 7 ? 'font-medium text-red-700' : ''}>
                2551Q for {s.quarter} {dueText(s)}.
              </p>
              {canFile && !filing && <Button onClick={() => setFiling(true)}>Mark as filed</Button>}
              {filing && <FileForm status={s} onDone={() => setFiling(false)} />}
            </>
          ) : (
            <p className="text-stone-500">The quarter is still running; this is the tax so far. It will be due {longDate(s.dueOn)}.</p>
          )}
          <p className="text-xs text-stone-500">
            3% of gross sales for a non-VAT business. Expenses do not reduce it. Due the 25th day after the quarter ends, or the next working day.
          </p>
        </div>
      )}
    </Card>
  );
}

export function FinancePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Finance</h1>
      <PercentageTaxCard />
      <IncomeStatementCard />
    </div>
  );
}
