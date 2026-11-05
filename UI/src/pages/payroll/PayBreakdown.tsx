import { Link } from 'react-router';
import { Alert, Badge, Card, td, th } from '../../components/ui';
import { peso } from '../../lib/format';
import { DEDUCTION_LINES, EARNING_LINES, STATUS_LABELS, STATUS_TONE, usePayWeek, type Payroll, type PayrollKind } from '../../lib/payroll';

const KIND_TITLE: Record<PayrollKind, string> = { therapist: 'Therapists', receptionist: 'Receptionist', reliever: 'Outside Relievers' };

const cell = (v: number, minus = false) => (v ? (minus ? `−${peso(v)}` : peso(v)) : '—');

/** Every earning and deduction of one kind of Payroll, one row per person, with the same lines as the Payslips. */
function BreakdownTable({ kind, rows }: { kind: PayrollKind; rows: Payroll[] }) {
  const earnings = EARNING_LINES[kind];
  const deductions = DEDUCTION_LINES[kind];
  const total = (pick: (p: Payroll) => number) => rows.reduce((s, r) => s + pick(r), 0);
  return (
    <Card title={KIND_TITLE[kind]}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm [&_td]:whitespace-nowrap">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Name</th>
              {kind !== 'therapist' && <th className={`${th} text-right`}>Days</th>}
              {earnings.map(([key, label]) => (
                <th key={key} className={`${th} text-right`}>
                  {label}
                </th>
              ))}
              <th className={`${th} border-l border-stone-200 text-right`}>Earned</th>
              {deductions.map(([key, label]) => (
                <th key={key} className={`${th} text-right`}>
                  {label}
                </th>
              ))}
              <th className={`${th} border-l border-stone-200 text-right`}>Deducted</th>
              <th className={`${th} text-right`}>Net pay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={td}>
                  <Link to={`/payroll/${r.id}`} className="font-medium text-teal-800 hover:underline">
                    {r.displayName}
                  </Link>{' '}
                  {r.status !== 'released' && <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status]}</Badge>}
                </td>
                {kind !== 'therapist' && <td className={`${td} text-right tabular-nums`}>{r.lines.daysPresent}</td>}
                {earnings.map(([key]) => (
                  <td key={key} className={`${td} text-right tabular-nums`}>
                    {cell(r.lines.earnings[key])}
                  </td>
                ))}
                <td className={`${td} border-l border-stone-200 text-right font-medium tabular-nums`}>{peso(r.lines.totalEarned)}</td>
                {deductions.map(([key]) => (
                  <td key={key} className={`${td} text-right tabular-nums text-stone-600`}>
                    {cell(r.lines.deductions[key], true)}
                  </td>
                ))}
                <td className={`${td} border-l border-stone-200 text-right font-medium tabular-nums`}>{cell(r.lines.totalDeductions, true)}</td>
                <td className={`${td} text-right font-semibold tabular-nums ${r.net < 0 ? 'text-red-700' : ''}`}>{peso(r.net)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-stone-300 font-semibold">
                <td className={td}>Total</td>
                {kind !== 'therapist' && <td className={td} />}
                {earnings.map(([key]) => (
                  <td key={key} className={`${td} text-right tabular-nums`}>
                    {cell(total((r) => r.lines.earnings[key]))}
                  </td>
                ))}
                <td className={`${td} border-l border-stone-200 text-right tabular-nums`}>{peso(total((r) => r.lines.totalEarned))}</td>
                {deductions.map(([key]) => (
                  <td key={key} className={`${td} text-right tabular-nums`}>
                    {cell(total((r) => r.lines.deductions[key]), true)}
                  </td>
                ))}
                <td className={`${td} border-l border-stone-200 text-right tabular-nums`}>{cell(total((r) => r.lines.totalDeductions), true)}</td>
                <td className={`${td} text-right tabular-nums`}>{peso(total((r) => r.net))}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}

export function PayBreakdown({ start }: { start: string }) {
  const { data, error } = usePayWeek(start);
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  if (!data.payrolls.length) return <p className="text-sm text-stone-500">No payroll generated for this week yet.</p>;
  return (
    <>
      {data.kinds.map((k) => {
        const rows = data.payrolls.filter((p) => p.kind === k);
        return rows.length ? <BreakdownTable key={k} kind={k} rows={rows} /> : null;
      })}
    </>
  );
}
