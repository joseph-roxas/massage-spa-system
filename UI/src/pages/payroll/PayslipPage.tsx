import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Badge, Button, Field, Input, td, th } from '../../components/ui';
import { useCan } from '../../lib/auth';
import { longDate, parsePesos, peso, pesosText } from '../../lib/format';
import {
  DAY_KIND_LABELS,
  STATUS_LABELS,
  STATUS_TONE,
  usePayroll,
  usePayrollAction,
  type Payroll,
  type ReceptionistDay,
  type TherapistDay,
} from '../../lib/payroll';

function Line({ label, value, strong, minus }: { label: string; value: number; strong?: boolean; minus?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-stone-300 pt-2 text-base font-semibold' : 'text-sm'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{minus && value ? `−${peso(value)}` : peso(value)}</span>
    </div>
  );
}

const shortDay = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric' });

function TherapistDays({ days }: { days: TherapistDay[] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-stone-200">
          <th className={th}>Day</th>
          <th className={`${th} text-right`}>Guests</th>
          <th className={`${th} text-right`}>Commission</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {days.map((d) => (
          <tr key={d.date} className={d.services ? '' : 'text-stone-400'}>
            <td className={td}>{shortDay(d.date)}</td>
            <td className={`${td} text-right tabular-nums`}>{d.services || '—'}</td>
            <td className={`${td} text-right tabular-nums`}>{d.commission ? peso(d.commission) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const mins = (m: number) => (m ? `${m} min` : '—');

function ReceptionistDays({ days }: { days: ReceptionistDay[] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-stone-200">
          <th className={th}>Day</th>
          <th className={th}>Kind</th>
          <th className={`${th} text-right`}>Late / Undertime</th>
          <th className={`${th} text-right`}>Overtime</th>
          <th className={`${th} text-right`}>Pay</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {days.map((d) => (
          <tr key={d.date} className={d.total ? '' : 'text-stone-400'}>
            <td className={td}>{shortDay(d.date)}</td>
            <td className={td}>
              {[d.kind === 'ordinary' ? null : DAY_KIND_LABELS[d.kind], d.worked ? null : d.holidayPay ? 'not worked, paid' : 'off'].filter(Boolean).join(' · ')}
            </td>
            <td className={`${td} text-right tabular-nums`}>{d.worked ? `${mins(d.lateMin)} / ${mins(d.undertimeMin)}` : ''}</td>
            <td className={`${td} text-right tabular-nums`}>{d.overtimeMin ? `${d.overtimeMin} min · ${peso(d.overtimePay)}` : ''}</td>
            <td className={`${td} text-right tabular-nums`}>{d.total ? peso(d.total) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RepaymentEditor({ payroll, balance }: { payroll: Payroll; balance: number }) {
  const act = usePayrollAction();
  const [text, setText] = useState(pesosText(payroll.caDeduction));
  const value = parsePesos(text);
  return (
    <form
      className="flex items-end gap-2 print:hidden"
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== null) act.mutate({ path: `/payrolls/${payroll.id}/ca-repayment`, method: 'PUT', body: { amount: value } });
      }}
    >
      <Field label="CA repayment this week" hint={`Balance ${peso(balance)}${balance > payroll.gross ? ' · more than a week’s pay' : ''}`}>
        <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className="w-36" />
      </Field>
      <Button type="submit" variant="secondary" disabled={value === null || value === payroll.caDeduction || act.isPending}>
        Save
      </Button>
      {act.error && <span className="text-sm text-red-700">{act.error.message}</span>}
    </form>
  );
}

export function PayslipPage() {
  const { id = '' } = useParams();
  const { data, error } = usePayroll(id);
  const act = usePayrollAction();
  const kind = data?.payroll.kind ?? 'therapist';
  const canApprove = useCan(kind === 'therapist' ? 'payroll.therapist.approve' : 'payroll.receptionist.manage');

  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  const { payroll: p, week, advances, caBalance } = data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <Link to={`/payroll?week=${p.weekStart}`} className="text-sm text-teal-800 hover:underline">
          ← Back to payroll
        </Link>
        <div className="flex gap-2">
          {canApprove && p.status === 'draft' && (
            <Button disabled={act.isPending} onClick={() => act.mutate({ path: `/payrolls/${p.id}/approve` })}>
              Approve
            </Button>
          )}
          {canApprove && p.status === 'approved' && (
            <Button
              variant="secondary"
              disabled={act.isPending}
              onClick={() => {
                const reason = prompt('Why send this back to draft?');
                if (reason && reason.trim().length >= 3) act.mutate({ path: `/payrolls/${p.id}/unapprove`, body: { reason } });
              }}
            >
              Back to draft
            </Button>
          )}
          {p.status === 'approved' && (
            <Button disabled={act.isPending} onClick={() => act.mutate({ path: `/payrolls/${p.id}/release` })}>
              Mark paid
            </Button>
          )}
          <Button variant="secondary" onClick={() => window.print()}>
            Print payslip
          </Button>
        </div>
      </div>
      {act.error && <Alert>{act.error.message}</Alert>}

      <section className="space-y-5 rounded-lg border border-stone-200 bg-white p-6 print:border-0 print:p-0">
        <header className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">Payslip</p>
            <h1 className="text-xl font-semibold">{p.fullName}</h1>
            <p className="text-sm text-stone-600">
              {p.kind === 'receptionist' ? 'Receptionist' : p.therapistClass === 'lmt' ? 'Licensed Massage Therapist' : 'Therapist'} · Pay Week{' '}
              {longDate(week.start)} – {longDate(week.end)}
            </p>
          </div>
          <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
        </header>

        {p.kind === 'therapist' ? <TherapistDays days={p.days as TherapistDay[]} /> : <ReceptionistDays days={p.days as ReceptionistDay[]} />}

        <div className="ml-auto max-w-sm space-y-1">
          <Line label={p.kind === 'therapist' ? 'Commission' : 'Gross pay'} value={p.gross} />
          <Line label="SSS" value={p.govSss} minus />
          <Line label="PhilHealth" value={p.govPhic} minus />
          <Line label="Pag-IBIG" value={p.govPagibig} minus />
          <Line label="Cash Advance" value={p.caDeduction} minus />
          <Line label="Net pay" value={p.net} strong />
        </div>

        {advances.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">Cash Advances deducted</p>
            <ul className="text-stone-600">
              {advances.map((a) => (
                <li key={a.id}>
                  {longDate(a.businessDay)}: {peso(a.amount)}
                  {a.note ? ` · ${a.note}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.kind === 'receptionist' && (
          <p className="text-sm text-stone-600">CA balance {p.status === 'released' ? 'now' : 'before this payroll'}: {peso(caBalance)}</p>
        )}

        <div className="hidden grid-cols-2 gap-12 pt-10 text-sm print:grid">
          <p className="border-t border-stone-400 pt-1">Received by</p>
          <p className="border-t border-stone-400 pt-1">Date</p>
        </div>
      </section>

      {p.kind === 'receptionist' && p.status === 'draft' && canApprove && <RepaymentEditor key={p.caDeduction} payroll={p} balance={caBalance} />}
    </div>
  );
}
