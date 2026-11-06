import { Link, useParams } from 'react-router';
import { BrandMark } from '../components/Brand';
import { Alert, Badge, Button, td, th } from '../components/ui';
import { usePastPayslip } from '../lib/backfill';
import { useCan } from '../lib/auth';
import { longDate, peso } from '../lib/format';

function Line({ label, amount, minus = false }: { label: string; amount: number; minus?: boolean }) {
  if (!amount) return null;
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="tabular-nums">
        {minus ? '−' : ''}
        {peso(amount)}
      </span>
    </div>
  );
}

/** A Payslip from before Go-live, exactly as it was paid. */
export function PastPayslipPage() {
  const { id = '' } = useParams();
  const { data, error } = usePastPayslip(id);
  const isOwner = useCan('settings.manage');
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  const p = data.payslip;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <Link to={isOwner ? '/admin/backfill' : '/my-pay'} className="text-sm text-teal-800 hover:underline">
          ← Back
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          Print payslip
        </Button>
      </div>
      <section className="space-y-5 rounded-lg border border-stone-200 bg-white p-6 print:border-0 print:p-0">
        <header className="flex items-start justify-between">
          <div>
            <div className="mb-3">
              <BrandMark />
            </div>
            <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">Payslip</p>
            <h1 className="text-xl font-semibold">{p.fullName}</h1>
            <p className="text-sm text-stone-600">
              Receptionist · Pay Week {longDate(p.weekStart)} – {longDate(p.weekEnd)}
            </p>
            <p className="text-sm text-stone-600">
              Daily rate {peso(p.dailyRate)} · {p.daysWorked} {p.daysWorked === 1 ? 'day' : 'days'} worked
              {p.paidOn && ` · Paid ${longDate(p.paidOn)}`}
            </p>
          </div>
          <Badge>Before go-live</Badge>
        </header>
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Day</th>
              <th className={th}>In</th>
              <th className={th}>Out</th>
              <th className={`${th} text-right`}>Hours</th>
              <th className={`${th} text-right`}>Late</th>
              <th className={`${th} text-right`}>OT</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {p.days.map((d) => (
              <tr key={d.date}>
                <td className={`${td} whitespace-nowrap`}>{longDate(d.date)}</td>
                {d.worked ? (
                  <>
                    <td className={`${td} tabular-nums`}>{d.timeIn}</td>
                    <td className={`${td} tabular-nums`}>{d.timeOut}</td>
                    <td className={`${td} text-right tabular-nums`}>{d.hours.toFixed(2)}</td>
                    <td className={`${td} text-right tabular-nums`}>{d.lateHours ? d.lateHours.toFixed(2) : ''}</td>
                    <td className={`${td} text-right tabular-nums`}>{d.overtimeHours ? d.overtimeHours.toFixed(2) : ''}</td>
                  </>
                ) : (
                  <td colSpan={5} className={`${td} text-stone-500`}>
                    Did not work
                  </td>
                )}
                <td className={`${td} text-xs text-stone-500`}>{d.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid gap-6 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <p className="font-semibold">Earnings</p>
            <Line label="Basic pay" amount={p.basic} />
            <Line label={`Overtime (${(p.overtimeHours / 100).toFixed(2)} hours)`} amount={p.overtimePay} />
            <Line label="Holiday and Rest Day pay" amount={p.premiumPay} />
            <Line label="Late and undertime" amount={p.lateUndertime} minus />
            <div className="flex justify-between border-t border-stone-200 pt-1 font-medium">
              <span>Gross pay</span>
              <span className="tabular-nums">{peso(p.gross)}</span>
            </div>
          </div>
          <div className="space-y-1">
            <p className="font-semibold">Deductions</p>
            <Line label="SSS" amount={p.sss} />
            <Line label="PhilHealth" amount={p.phic} />
            <Line label="Pag-IBIG" amount={p.hdmf} />
            <Line label="Cash Advance" amount={p.caRepayment} />
            {p.caBalance !== null && <p className="text-xs text-stone-500">Cash Advance balance after this week: {peso(p.caBalance)}</p>}
          </div>
        </div>
        <div className="flex items-baseline justify-between border-t-2 border-stone-300 pt-3">
          <span className="font-semibold">Net pay</span>
          <span className="text-2xl font-bold tabular-nums">{peso(p.net)}</span>
        </div>
      </section>
    </div>
  );
}
