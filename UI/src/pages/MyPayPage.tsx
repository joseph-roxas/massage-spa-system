import { Link, useParams } from 'react-router';
import { Alert, Button, Card, td, th } from '../components/ui';
import { longDate, peso } from '../lib/format';
import { payWeekEnd, useMyPay, useMyPayslip, type MyPay } from '../lib/payroll';
import { PayslipSheet } from './payroll/PayslipPage';

const ENTRY_LABEL = { opening: 'Owed before the system', advance: 'Cash Advance', repayment: 'Repaid from payroll' } as const;

function CashAdvanceHistory({ ca, repayment }: { ca: NonNullable<MyPay['ca']>; repayment: number }) {
  return (
    <Card title="Cash Advances">
      <div className="mb-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-md bg-stone-50 p-3">
          <p className="text-xs text-stone-500">Total taken</p>
          <p className="text-lg font-semibold tabular-nums">{peso(ca.totalTaken)}</p>
        </div>
        <div className="rounded-md bg-stone-50 p-3">
          <p className="text-xs text-stone-500">Paid off</p>
          <p className="text-lg font-semibold tabular-nums">{peso(ca.totalRepaid)}</p>
        </div>
        <div className="rounded-md bg-amber-50 p-3">
          <p className="text-xs text-stone-500">Still owed</p>
          <p className="text-lg font-semibold tabular-nums">{peso(ca.balance)}</p>
        </div>
      </div>
      {ca.balance > 0 && <p className="mb-3 text-sm text-stone-600">{peso(Math.min(repayment, ca.balance))} comes off each payroll until it is paid off.</p>}
      {ca.entries.length === 0 ? (
        <p className="text-sm text-stone-500">No Cash Advances.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Date</th>
              <th className={th}>What</th>
              <th className={`${th} text-right`}>Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {ca.entries.map((e) => (
              <tr key={e.id}>
                <td className={td}>{longDate(e.date)}</td>
                <td className={td}>
                  {ENTRY_LABEL[e.entry]}
                  {e.weekStart && <span className="text-stone-500"> · week of {longDate(e.weekStart)}</span>}
                </td>
                <td className={`${td} text-right tabular-nums`}>{e.entry === 'repayment' ? `−${peso(e.amount)}` : peso(e.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** The Receptionist's own released Payslips and Cash Advances. */
export function MyPayPage() {
  const { data, error } = useMyPay();
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  if (!data.staff) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">My Pay</h1>
        <Alert tone="info">Your login is not linked to a staff record yet. Ask the owner to link it under Settings → Staff.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">My Pay</h1>
      <Card title="Payslips">
        {data.payslips.length === 0 ? (
          <p className="text-sm text-stone-500">No payslips yet. Each one shows here once that week’s pay is released.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Pay Week</th>
                <th className={th}>Paid on</th>
                <th className={`${th} text-right`}>Net pay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.payslips.map((p) => (
                <tr key={p.id}>
                  <td className={td}>
                    <Link to={`/my-pay/${p.id}`} className="font-medium text-teal-800 hover:underline">
                      {longDate(p.weekStart)} – {longDate(payWeekEnd(p.weekStart))}
                    </Link>
                  </td>
                  <td className={td}>{p.releasedAt ? longDate(p.releasedAt.slice(0, 10)) : '—'}</td>
                  <td className={`${td} text-right font-semibold tabular-nums`}>{peso(p.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {data.ca && <CashAdvanceHistory ca={data.ca} repayment={data.staff.caRepayment} />}
    </div>
  );
}

export function MyPayslipPage() {
  const { id = '' } = useParams();
  const { data, error } = useMyPayslip(id);
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <Link to="/my-pay" className="text-sm text-teal-800 hover:underline">
          ← Back to My Pay
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          Print payslip
        </Button>
      </div>
      <PayslipSheet payroll={data.payroll} week={data.week} />
    </div>
  );
}
