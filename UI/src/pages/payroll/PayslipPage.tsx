import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { BrandMark } from '../../components/Brand';
import { Alert, Badge, Button, Checkbox, Field, Input, td, th } from '../../components/ui';
import { useCan } from '../../lib/auth';
import { longDate, parsePesos, peso, pesosText } from '../../lib/format';
import {
  DAY_KIND_LABELS,
  DEDUCTION_LINES,
  EARNING_LINES,
  STATUS_LABELS,
  STATUS_TONE,
  usePayroll,
  usePayrollAction,
  type Payroll,
  type PayWeek,
  type ReceptionistDay,
  type TherapistDay,
} from '../../lib/payroll';

function Line({ label, value, strong, minus, muted }: { label: string; value: number; strong?: boolean; minus?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-stone-300 pt-2 text-base font-semibold' : 'text-sm'} ${muted ? 'pl-3 text-stone-500' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{minus && value ? `−${peso(value)}` : peso(value)}</span>
    </div>
  );
}

/** What was earned and what was deducted, line by line; lines that are zero are left out. */
export function PayslipLines({ payroll: p }: { payroll: Payroll }) {
  const earnings = EARNING_LINES[p.kind].filter(([key]) => p.lines.earnings[key] !== 0 || key === EARNING_LINES[p.kind][0]![0]);
  const deductions = DEDUCTION_LINES[p.kind].filter(([key]) => p.lines.deductions[key] !== 0);
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Earned</p>
        {earnings.map(([key, label]) =>
          key === 'adjustments' ? (
            p.adjustments.map((a) => <Line key={a.id} label={a.label} value={a.amount} />)
          ) : (
            <Line key={key} label={label} value={p.lines.earnings[key]} />
          ),
        )}
        <Line label="Total earned" value={p.lines.totalEarned} strong />
      </div>
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Deducted</p>
        {deductions.length === 0 && <p className="text-sm text-stone-500">Nothing</p>}
        {deductions.map(([key, label]) =>
          key === 'deferred' && p.lines.deductions[key] < 0 ? (
            <Line key={key} label="Held over to a later week" value={-p.lines.deductions[key]} />
          ) : (
            <Line key={key} label={key === 'deferred' ? 'Deferred Deductions from earlier weeks' : label} value={p.lines.deductions[key]} minus />
          ),
        )}
        <Line label="Total deducted" value={p.lines.totalDeductions} strong minus />
      </div>
    </div>
  );
}

/** How much Government Deductions this Payroll takes; the Super Admin can set their own figure for one week. */
function DeductionOverride({ payroll: p, balance }: { payroll: Payroll; balance: number }) {
  const act = usePayrollAction();
  const week = p.govSss + p.govPhic + p.govPagibig;
  const taken = week - p.govDeferred + p.govCollected;
  const [text, setText] = useState(pesosText(taken));
  const amount = parsePesos(text);
  const pay = Math.max(0, p.gross - p.caDeduction);
  // The Therapist may choose to have the week taken, under the Take-home Floor.
  const agreed = Math.min(week, pay);
  // Their last pay is the last chance to collect, so the Take-home Floor doesn't apply; never more than the pay itself.
  const lastPay = Math.min(week + balance, pay);
  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4 print:hidden">
      <h2 className="font-semibold">Government Deductions this week</h2>
      {act.error && <Alert>{act.error.message}</Alert>}
      <p className="text-sm text-stone-600">
        This week {peso(week)} · owed from earlier weeks {peso(balance)} · taking {peso(taken)}
        {p.govOverride !== null && (p.govAgreed ? ' (the Therapist agreed)' : ' (your own figure)')}.
      </p>
      <p className="text-sm text-stone-600">Each week takes only that week&rsquo;s deduction. To collect from what is owed, type a higher figure when the Therapist asks, or use Last working week.</p>
      <div className="flex items-end gap-2">
        <Field label="Take this much (₱)">
          <Input inputMode="decimal" className="w-32" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Button disabled={amount === null || act.isPending} onClick={() => amount !== null && act.mutate({ path: `/payrolls/${p.id}/deductions`, method: 'PUT', body: { amount } })}>
          Use this
        </Button>
        {p.govDeferred > 0 && agreed > taken && (
          <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: `/payrolls/${p.id}/deductions`, method: 'PUT', body: { amount: agreed, agreed: true } })}>
            Therapist agreed: take {peso(agreed)}
          </Button>
        )}
        {balance > 0 && lastPay !== taken && (
          <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: `/payrolls/${p.id}/deductions`, method: 'PUT', body: { amount: lastPay } })}>
            Last working week: take {peso(lastPay)}
          </Button>
        )}
        {p.govOverride !== null && (
          <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: `/payrolls/${p.id}/deductions`, method: 'PUT', body: { amount: null } })}>
            Back to the Take-home Floor
          </Button>
        )}
      </div>
    </section>
  );
}

function Adjustments({ payroll: p }: { payroll: Payroll }) {
  const act = usePayrollAction();
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [takeOff, setTakeOff] = useState(false);
  const [reason, setReason] = useState('');
  const value = parsePesos(amount);
  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4 print:hidden">
      <h2 className="font-semibold">Adjustments</h2>
      {act.error && <Alert>{act.error.message}</Alert>}
      {p.adjustments.length > 0 && (
        <ul className="divide-y divide-stone-100 text-sm">
          {p.adjustments.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-1.5">
              <span className="flex-1">
                {a.label}
                {a.reason && <span className="text-stone-500"> · {a.reason}</span>}
              </span>
              <span className="tabular-nums">{peso(a.amount)}</span>
              {a.id === p.refund?.adjustmentId ? (
                <span className="text-xs text-stone-500">Remove under Deferred Deductions</span>
              ) : (
                <button
                  type="button"
                  className="text-xs text-stone-500 underline"
                  onClick={() => act.mutate({ path: `/payrolls/${p.id}/adjustments/${a.id}`, method: 'DELETE' })}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value) return;
          act.mutate(
            { path: `/payrolls/${p.id}/adjustments`, body: { label, amount: takeOff ? -value : value, reason } },
            { onSuccess: () => (setLabel(''), setAmount(''), setReason(''), setTakeOff(false)) },
          );
        }}
      >
        <Field label="Label on the payslip">
          <Input required minLength={2} maxLength={60} placeholder="Underpaid Oct 26" value={label} onChange={(e) => setLabel(e.target.value)} className="w-52" />
        </Field>
        <Field label="Amount">
          <Input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" />
        </Field>
        <Checkbox label="Take off" checked={takeOff} onChange={(e) => setTakeOff(e.target.checked)} />
        <Field label="Reason (only you see this)">
          <Input required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="w-64" />
        </Field>
        <Button type="submit" variant="secondary" disabled={!value || act.isPending}>
          Add
        </Button>
      </form>
    </section>
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
      <Field label="CA Repayment this week" hint={`Balance ${peso(balance)}${balance > payroll.gross ? ' · more than a week’s pay' : ''} · the standing amount is set under Cash Advances`}>
        <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className="w-36" />
      </Field>
      <Button type="submit" variant="secondary" disabled={value === null || value === payroll.caDeduction || act.isPending}>
        Save
      </Button>
      {act.error && <span className="text-sm text-red-700">{act.error.message}</span>}
    </form>
  );
}

/** The printable payslip: coverage, each day, every line and net pay. `children` go under net pay. */
export function PayslipSheet({ payroll: p, week, children }: { payroll: Payroll & { days: (TherapistDay | ReceptionistDay)[] }; week: PayWeek; children?: ReactNode }) {
  const dailyRate = p.kind === 'receptionist' ? (p.days as ReceptionistDay[]).find((d) => d.dailyRate !== undefined)?.dailyRate : undefined;
  return (
    <section className="space-y-5 rounded-lg border border-stone-200 bg-white p-6 print:border-0 print:p-0">
      <header className="flex items-start justify-between">
        <div>
          <div className="mb-3">
            <BrandMark />
          </div>
          <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">Payslip</p>
          <h1 className="text-xl font-semibold">{p.fullName}</h1>
          <p className="text-sm text-stone-600">
            {p.kind === 'receptionist' ? 'Receptionist' : p.kind === 'reliever' ? 'Outside Reliever' : p.therapistClass === 'lmt' ? 'Licensed Massage Therapist' : 'Therapist'} · Pay Week{' '}
            {longDate(week.start)} – {longDate(week.end)}
          </p>
          {p.kind === 'receptionist' && (
            <p className="text-sm text-stone-600">
              {dailyRate !== undefined && <>Daily rate {peso(dailyRate)} · </>}
              {p.lines.daysPresent} {p.lines.daysPresent === 1 ? 'day' : 'days'} present
            </p>
          )}
        </div>
        <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
      </header>

      {p.kind === 'therapist' ? <TherapistDays days={p.days as TherapistDay[]} /> : <ReceptionistDays days={p.days as ReceptionistDay[]} />}

      <PayslipLines payroll={p} />
      <div className="ml-auto max-w-sm">
        <Line label="Net pay" value={p.net} strong />
      </div>

      {p.refund && (
        <div className="rounded-md border border-teal-300 bg-teal-50 p-3 text-sm text-teal-950">
          <p className="font-semibold">Government Deduction Refund, January–November 2026: {peso(p.refund.total)}</p>
          <p>
            SSS {peso(p.refund.sss)} · PhilHealth {peso(p.refund.phic)} · Pag-IBIG {peso(p.refund.pagibig)}
          </p>
          <p className="text-xs">
            Deductions taken over a month&rsquo;s share, less any month taken under it.
            {p.refund.applied > 0 && <> {peso(p.refund.applied)} came off your Deferred Deductions.</>}
            {p.refund.cash > 0 && <> {peso(p.refund.cash)} is paid on this payslip.</>}
          </p>
        </div>
      )}
      {p.govAgreed && <p className="text-sm text-stone-600">The Therapist agreed to have this week&rsquo;s Government Deductions taken.</p>}
      {p.deferredOwed && p.deferredOwed.total > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-semibold">Deferred Deductions owed to the shop: {peso(p.deferredOwed.total)}</p>
          {p.deferredOwed.weeks.length > 0 && <p>Week{p.deferredOwed.weeks.length === 1 ? '' : 's'} {p.deferredOwed.weeks.map((w) => w.number).join(', ')}</p>}
          <p className="text-xs">Taken from your last working week&rsquo;s pay or your Year-end Bonus, unless you ask to pay sooner.</p>
        </div>
      )}

      {children}

      <div className="hidden grid-cols-2 gap-12 pt-10 text-sm print:grid">
        <p className="border-t border-stone-400 pt-1">Received by</p>
        <p className="border-t border-stone-400 pt-1">Date</p>
      </div>
    </section>
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
  const { payroll: p, week, advances, caBalance, deductionBalance } = data;

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
          {canApprove && p.status === 'approved' && p.paid === 0 && (
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
            <Button
              variant="secondary"
              disabled={act.isPending}
              onClick={() => {
                const text = prompt(`How much did you hand over now? ${peso(p.net - p.paid)} is still to be released.`);
                const amount = text === null ? null : parsePesos(text);
                if (text !== null && !amount) return alert('Enter an amount, e.g. 1000.');
                if (amount) act.mutate({ path: `/payrolls/${p.id}/releases`, body: { amount } });
              }}
            >
              Hand over part
            </Button>
          )}
          {p.status === 'approved' && (
            <Button disabled={act.isPending} onClick={() => confirm(`Hand over the rest, ${peso(p.net - p.paid)}?`) && act.mutate({ path: `/payrolls/${p.id}/release` })}>
              Paid in full
            </Button>
          )}
          <Button variant="secondary" onClick={() => window.print()}>
            Print payslip
          </Button>
        </div>
      </div>
      {act.error && <Alert>{act.error.message}</Alert>}
      {p.status !== 'draft' && p.releases.length > 0 && (
        <section className="rounded-lg border border-stone-200 bg-white p-4 text-sm print:hidden">
          <p className="font-semibold">
            Released {peso(p.paid)} of {peso(p.net)}
            {p.status === 'released' ? ' · fully released' : ` · ${peso(p.net - p.paid)} still to be released`}
          </p>
          <ul className="mt-1 text-stone-600">
            {p.releases.map((r) => (
              <li key={r.createdAt}>
                {longDate(r.businessDay)}: {peso(r.amount)}
                {r.fromShopCash ? '' : ' · not from the shop’s cash'}
              </li>
            ))}
          </ul>
        </section>
      )}

      <PayslipSheet payroll={p} week={week}>
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
      </PayslipSheet>

      {p.status === 'draft' && canApprove && <Adjustments payroll={p} />}
      {p.kind === 'therapist' && p.status === 'draft' && canApprove && <DeductionOverride key={`${p.net}-${p.govOverride}`} payroll={p} balance={deductionBalance} />}
      {p.kind === 'receptionist' && p.status === 'draft' && canApprove && <RepaymentEditor key={p.caDeduction} payroll={p} balance={caBalance} />}
    </div>
  );
}
