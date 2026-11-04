import { useState } from 'react';
import { Alert, Badge, Button, Card, Input, td, th } from '../../components/ui';
import { longDate, peso, percent } from '../../lib/format';
import { monthLabel, shiftMonth, useExpenseAction, useRoyalty, type RoyaltyStatement } from '../../lib/expenses';

function StatementRow({ s }: { s: RoyaltyStatement }) {
  const act = useExpenseAction();
  const [rate, setRate] = useState(String(s.bp / 100));
  const bp = Math.round(Number(rate) * 100);
  return (
    <tr>
      <td className={td}>
        <span className="font-medium">{monthLabel(s.month)}</span>
        <span className="block text-xs text-stone-500">
          {longDate(s.monthStart)} – {longDate(s.monthEnd)}
        </span>
        {act.error && <span className="block text-xs text-red-700">{act.error.message}</span>}
      </td>
      <td className={`${td} text-right tabular-nums`}>{peso(s.serviceSales)}</td>
      <td className={`${td} text-right tabular-nums`}>{peso(s.voucherSales)}</td>
      <td className={`${td} text-right font-medium tabular-nums`}>{peso(s.grossSales)}</td>
      <td className={`${td} text-right`}>
        {s.status === 'draft' ? (
          <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="h-8 w-16 text-right" aria-label="Rate (%)" />
        ) : (
          percent(s.bp)
        )}
      </td>
      <td className={`${td} text-right font-semibold tabular-nums`}>{peso(s.amount)}</td>
      <td className={`${td} text-right`}>
        {s.status === 'confirmed' ? (
          <Badge>Paid {s.confirmedAt ? longDate(s.confirmedAt.slice(0, 10)) : ''}</Badge>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" className="h-8" disabled={act.isPending || !(bp > 0)} onClick={() => act.mutate({ path: `/royalty/${s.month}/compute`, body: { bp } })}>
              Recompute
            </Button>
            <Button className="h-8" disabled={act.isPending} onClick={() => confirm(`Mark the ${monthLabel(s.month)} Royalty of ${peso(s.amount)} as paid?`) && act.mutate({ path: `/royalty/${s.month}/confirm` })}>
              Paid
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function RoyaltyTab() {
  const { data, error } = useRoyalty();
  const act = useExpenseAction();
  const last = data ? shiftMonth(data.current.month, -1) : null;
  const missing = data && last && !data.statements.some((s) => s.month === last);

  return (
    <div className="space-y-6">
      {error && <Alert>{error.message}</Alert>}
      {data && (
        <Card title={`${monthLabel(data.current.month)} so far`}>
          <p className="text-sm text-stone-600">
            Gross Sales {peso(data.current.grossSales)} ({peso(data.current.serviceSales)} Services + {peso(data.current.voucherSales)} Vouchers sold) →{' '}
            <strong>{peso(data.current.amount)}</strong> at {percent(data.current.bp)}. The statement is drafted automatically after the month ends.
          </p>
        </Card>
      )}
      <Card
        title="Royalty statements"
        actions={
          missing && (
            <Button disabled={act.isPending} onClick={() => act.mutate({ path: `/royalty/${last}/compute` })}>
              Compute {monthLabel(last!)}
            </Button>
          )
        }
      >
        {act.error && <Alert>{act.error.message}</Alert>}
        <p className="mb-3 text-sm text-stone-500">
          Gross Sales = what guests paid for Services after discounts (not Add-ons, Voucher redemptions or Real FOCs) plus Vouchers sold that month. Each statement is a
          pending Expense until you mark it paid; recompute it if sales were corrected.
        </p>
        {data?.statements.length === 0 ? (
          <p className="text-sm text-stone-500">No statements yet.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Month</th>
                <th className={`${th} text-right`}>Services</th>
                <th className={`${th} text-right`}>Vouchers sold</th>
                <th className={`${th} text-right`}>Gross Sales</th>
                <th className={`${th} text-right`}>Rate (%)</th>
                <th className={`${th} text-right`}>Royalty</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data?.statements.map((s) => (
                <StatementRow key={`${s.month}-${s.computedAt}`} s={s} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
