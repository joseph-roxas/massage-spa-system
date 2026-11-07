import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { businessDayOf, payPeriodRange, shiftMonth, type PayPeriod } from '@spa/domain';
import { Alert, Button, Card, Checkbox, td, th } from '../../components/ui';
import { api } from '../../lib/api';
import { longDate, peso } from '../../lib/format';
import { monthName } from '../dashboard/Charts';

type Person = {
  staffId: string;
  displayName: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  civilStatus: string | null;
  notEnrolled: boolean;
  salaryBasis: number | null;
  kind: string;
  gross: number;
  gov: number;
  ca: number;
  net: number;
};
type Totals = {
  period: PayPeriod;
  from: string;
  to: string;
  drafts: number;
  business: { name: string | null; contactNumber: string | null; address: string | null };
  people: Person[];
  months: { month: string; therapists: number; receptionist: number; relievers: number; total: number }[];
  onCall: number;
  bonuses: { yearEnd: number; thirteenth: number };
};

const PERIODS: [PayPeriod, string][] = [['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Annual']];
const KIND = { therapist: 'Therapists', receptionist: 'Receptionist', reliever: 'Outside Relievers' } as Record<string, string>;
const title = (s: string | null) => (s ? s[0]!.toUpperCase() + s.slice(1) : '');

/** Moves a date by whole periods. */
function shift(period: PayPeriod, date: string, by: number) {
  if (period === 'year') return `${Number(date.slice(0, 4)) + by}-01-01`;
  if (period === 'month') return `${shiftMonth(date.slice(0, 7), by)}-01`;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by * 7);
  return d.toISOString().slice(0, 10);
}

const label = (period: PayPeriod, date: string) => {
  const { from, to } = payPeriodRange(period, date);
  return period === 'year' ? from.slice(0, 4) : period === 'month' ? monthName(from.slice(0, 7), 'long') : `${longDate(from)} – ${longDate(to)}`;
};

function ByPerson({ people }: { people: Person[] }) {
  const kinds = [...new Set(people.map((p) => p.kind))];
  const sum = (rows: Person[], k: 'gross' | 'gov' | 'ca' | 'net') => rows.reduce((s, r) => s + r[k], 0);
  const figures = (rows: Person[]) => (
    <>
      <td className={`${td} text-right tabular-nums`}>{peso(sum(rows, 'gross'))}</td>
      <td className={`${td} text-right tabular-nums text-stone-600`}>{peso(sum(rows, 'gov'))}</td>
      <td className={`${td} text-right tabular-nums text-stone-600`}>{peso(sum(rows, 'ca'))}</td>
      <td className={`${td} text-right tabular-nums`}>{peso(sum(rows, 'net'))}</td>
    </>
  );
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-stone-200">
          <th className={th}>Name</th>
          <th className={`${th} text-right`}>Gross pay</th>
          <th className={`${th} text-right`}>SSS · PHIC · Pag-IBIG taken</th>
          <th className={`${th} text-right`}>CA</th>
          <th className={`${th} text-right`}>Net pay</th>
        </tr>
      </thead>
      {kinds.map((k) => {
        const rows = people.filter((p) => p.kind === k);
        return (
          <tbody key={k} className="divide-y divide-stone-100">
            {rows.map((p) => (
              <tr key={p.staffId}>
                <td className={td}>{p.displayName}</td>
                {figures([p])}
              </tr>
            ))}
            <tr className="bg-stone-50 font-medium">
              <td className={td}>{KIND[k] ?? k}</td>
              {figures(rows)}
            </tr>
          </tbody>
        );
      })}
      <tfoot>
        <tr className="border-t-2 border-stone-300 font-semibold">
          <td className={td}>Total payroll</td>
          {figures(people)}
        </tr>
      </tfoot>
    </table>
  );
}

function ByMonth({ months }: { months: Totals['months'] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-stone-200">
          <th className={th}>Month</th>
          <th className={`${th} text-right`}>Therapists</th>
          <th className={`${th} text-right`}>Receptionist</th>
          <th className={`${th} text-right`}>Outside Relievers</th>
          <th className={`${th} text-right`}>Gross pay</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {months.map((m) => (
          <tr key={m.month}>
            <td className={td}>{monthName(m.month, 'long')}</td>
            <td className={`${td} text-right tabular-nums`}>{peso(m.therapists)}</td>
            <td className={`${td} text-right tabular-nums`}>{peso(m.receptionist)}</td>
            <td className={`${td} text-right tabular-nums`}>{peso(m.relievers)}</td>
            <td className={`${td} text-right font-semibold tabular-nums`}>{peso(m.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The printed list, in the layout of the owner's monthly payroll list. */
function PrintSheet({ data, heading, people }: { data: Totals; heading: string; people: Person[] }) {
  const total = people.reduce((s, p) => s + p.gross, 0);
  return (
    <section className="hidden text-sm text-black print:block">
      <h1 className="text-lg font-bold">{data.business.name ?? 'Payroll'}</h1>
      {data.business.contactNumber && <p>{data.business.contactNumber}</p>}
      {data.business.address && <p>{data.business.address}</p>}
      <p className="mb-4">{longDate(businessDayOf(new Date()))}</p>
      <h2 className="mb-2 font-bold">Payroll: {heading}</h2>
      <table className="w-full border-collapse [&_td]:border [&_td]:border-black [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-black [&_th]:px-2 [&_th]:py-1">
        <thead>
          <tr>
            <th className="text-left">No.</th>
            <th className="text-left">Last Name</th>
            <th className="text-left">First Name</th>
            <th className="text-left">Middle Name</th>
            <th className="text-left">Civil Status</th>
            <th className="text-right">Gross Salary</th>
            <th className="text-right">Salary Basis</th>
            <th className="text-left">Remarks</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p, i) => (
            <tr key={p.staffId}>
              <td>{i + 1}</td>
              <td>{p.lastName}</td>
              <td>{p.firstName}</td>
              <td>{p.middleName ?? ''}</td>
              <td>{title(p.civilStatus)}</td>
              <td className="text-right tabular-nums">{peso(p.gross)}</td>
              <td className="text-right tabular-nums">{p.salaryBasis ? peso(p.salaryBasis) : ''}</td>
              <td />
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={5}>Total</td>
            <td className="text-right tabular-nums">{peso(total)}</td>
            <td colSpan={2} />
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** Everyone's pay for a week, month or year, and the list printed for the BIR. */
export function PayrollTotals() {
  const [period, setPeriod] = useState<PayPeriod>('month');
  const [date, setDate] = useState(() => businessDayOf(new Date()));
  const [withNotEnrolled, setWithNotEnrolled] = useState(false);
  const { data, error } = useQuery({
    queryKey: ['payroll', 'totals', period, date],
    queryFn: () => api<Totals>(`/payroll/totals?period=${period}&date=${date}`),
    placeholderData: (prev) => prev,
  });
  const heading = label(period, date);
  const left = data?.people.filter((p) => p.notEnrolled) ?? [];
  const printed = data?.people.filter((p) => withNotEnrolled || !p.notEnrolled) ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <div className="flex rounded-md border border-stone-300 bg-white p-0.5 text-sm">
          {PERIODS.map(([key, name]) => (
            <button key={key} type="button" onClick={() => setPeriod(key)} className={`rounded px-3 py-1.5 ${period === key ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
              {name}
            </button>
          ))}
        </div>
        <Button variant="secondary" aria-label="Previous" onClick={() => setDate(shift(period, date, -1))}>
          ‹
        </Button>
        <p className="min-w-40 text-center font-medium">{heading}</p>
        <Button variant="secondary" aria-label="Next" onClick={() => setDate(shift(period, date, 1))}>
          ›
        </Button>
        <Button variant="secondary" disabled={!printed.length} onClick={() => window.print()}>
          Print payroll list
        </Button>
        {left.length > 0 && <Checkbox label={`Include ${left.map((p) => p.displayName).join(', ')} (Not Enrolled)`} checked={withNotEnrolled} onChange={(e) => setWithNotEnrolled(e.target.checked)} />}
      </div>
      {error && <Alert>{error.message}</Alert>}
      {data && (
        <div className="space-y-6 print:hidden">
          {data.drafts > 0 && <Alert tone="info">{data.drafts} Payroll{data.drafts === 1 ? ' is' : 's are'} still a draft, so these figures can change.</Alert>}
          <Card title={heading}>
            {data.people.length ? <ByPerson people={data.people} /> : <p className="text-sm text-stone-500">No payroll in this period.</p>}
            <p className="mt-3 text-sm text-stone-500">A week across two months counts in the month with most of its days. {data.onCall > 0 ? `On-call Therapists were paid ${peso(data.onCall)} on top of this, daily, from the cash drawer.` : 'On-call Therapists are paid daily and are not here.'}</p>
          </Card>
          {period === 'year' && data.months.length > 0 && (
            <Card title="By month">
              <ByMonth months={data.months} />
              {data.bonuses.yearEnd + data.bonuses.thirteenth > 0 && (
                <p className="mt-3 text-sm text-stone-600">
                  December pay on top of this: Year-end Bonus {peso(data.bonuses.yearEnd)}, 13th Month Pay {peso(data.bonuses.thirteenth)}.
                </p>
              )}
            </Card>
          )}
        </div>
      )}
      {data && <PrintSheet data={data} heading={heading} people={printed} />}
    </div>
  );
}
