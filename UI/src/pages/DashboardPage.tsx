import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, Card } from '../components/ui';
import { useDashboard, type Dashboard } from '../lib/dashboard';
import { longDate, percent, peso, todayManila } from '../lib/format';
import { Columns, monthName, Ranking, SalesExpensesChart } from './dashboard/Charts';
import { NeedsAttention } from './front-desk/CashDialogs';
import { LateEntries } from './dashboard/LateEntries';

function previousMonth(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: ReactNode; tone?: 'bad' }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs font-medium text-stone-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone === 'bad' ? 'text-red-700' : 'text-stone-900'}`}>{value}</p>
      {note && <p className="mt-1 text-xs text-stone-500">{note}</p>}
    </div>
  );
}

const royaltyLabel = { paid: 'Paid', not_paid: 'Not paid', forecast: 'Forecast' } as const;

function MustPay({ d }: { d: Dashboard }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Stat
        label="Government remittance this month"
        value={peso(d.government.total)}
        note={
          <>
            {peso(d.government.employee)} from staff, {peso(d.government.employer)} from the shop.
            {d.government.noBasis > 0 && ` ${d.government.noBasis} without a salary basis not counted.`}
          </>
        }
      />
      <Stat
        label={`2551Q ${d.tax.quarter} forecast`}
        value={d.tax.filed ? 'Filed' : peso(d.tax.forecast)}
        note={d.tax.filed ? `Quarter due ${longDate(d.tax.dueOn)}` : `${peso(d.tax.soFar)} so far. Due ${longDate(d.tax.dueOn)}.`}
      />
      <Stat
        label={`Royalty ${monthName(d.month)}: ${royaltyLabel[d.royalty.status]}`}
        value={peso(d.royalty.amount)}
        note={d.royalty.owing.months ? `${peso(d.royalty.owing.total)} unpaid across ${d.royalty.owing.months} month${d.royalty.owing.months === 1 ? '' : 's'}.` : 'Nothing unpaid.'}
      />
    </div>
  );
}

function ConsumablesCard({ c }: { c: Dashboard['consumables'] }) {
  return (
    <Card title="Consumables used">
      <p className="text-xl font-semibold tabular-nums">{peso(c.cost)}</p>
      <p className="mt-1 text-sm text-stone-600">{peso(c.perGuest)} per Guest</p>
      {c.status === 'building' && <p className="mt-2 text-sm text-stone-500">Building a baseline. It compares from the first full month on the system.</p>}
      {c.status !== 'building' && (
        <p className={`mt-2 text-sm ${c.status === 'high' ? 'font-medium text-red-700' : 'text-stone-600'}`}>
          {c.status === 'high' ? 'Using too much: ' : 'Normal: '}
          {c.changeBp >= 0 ? '+' : '−'}{percent(Math.abs(c.changeBp))} against the {peso(c.average)} average of the last few months.
        </p>
      )}
    </Card>
  );
}

function MissedGuests({ g }: { g: Dashboard['guests'] }) {
  return (
    <section aria-label="Guests not served">
      <h2 className="mb-2 text-sm font-semibold text-stone-700">Guests not served</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="No-shows" value={String(g.noShows)} note="Booked and never came" />
        <Stat label="Cancelled" value={String(g.cancelled)} note="Booking called off before the Service" />
        <Stat label="Rejects" value={String(g.turnedAway)} note="Turned away at the door" />
      </div>
      {(g.noShowGuests.length > 0 || g.cancelReasons.length > 0) && (
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          {g.noShowGuests.length > 0 && (
            <Card title="Who didn’t show">
              <ul className="space-y-1 text-sm">
                {g.noShowGuests.map((x) => (
                  <li key={x.name} className="flex justify-between gap-3">
                    <span className="truncate text-stone-700">{x.name}</span>
                    <span className="tabular-nums text-stone-600">{x.count} {x.count === 1 ? 'no-show' : 'no-shows'} to date</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {g.cancelReasons.length > 0 && (
            <Card title="Latest cancellations">
              <ul className="space-y-2 text-sm">
                {g.cancelReasons.map((x, i) => (
                  <li key={i}>
                    <p className="text-stone-700">{x.reason || 'No reason given'}</p>
                    <p className="text-xs text-stone-500">{longDate(x.date)}{x.guest ? ` · ${x.guest}` : ''}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}

function Body({ d }: { d: Dashboard }) {
  const { top } = d;
  const net = top.cashIn - top.cashOut;
  return (
    <div className="space-y-6">
      <section aria-label="This month" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Sales" value={peso(top.sales)} note={`${peso(top.averageSale)} average per Guest`} />
        <Stat label="Expenses" value={peso(top.expenses)} note={top.pendingExpenses ? `${peso(top.pendingExpenses)} more to confirm` : undefined} />
        <Stat
          label="Profit"
          value={peso(top.profit)}
          tone={top.profit < 0 ? 'bad' : undefined}
          note={top.profitForecast !== null ? `${peso(top.profitForecast)} by month end at this pace, before bills not yet entered` : undefined}
        />
        <Stat label="Cash in vs out" value={peso(net)} tone={net < 0 ? 'bad' : undefined} note={`${peso(top.cashIn)} in, ${peso(top.cashOut)} out`} />
      </section>

      <Card title="Sales and expenses by day">
        <SalesExpensesChart days={d.days} />
        <p className="mt-2 text-xs text-stone-500">Expenses here are Commission, Cash-outs and bills on the day they are dated. Monthly records from before Go-live are left out of the bars but counted above.</p>
      </Card>

      <section aria-label="Must pay">
        <h2 className="mb-2 text-sm font-semibold text-stone-700">Must pay</h2>
        <MustPay d={d} />
      </section>

      <section aria-label="Costs" className="grid gap-6 lg:grid-cols-3">
        <Card title="Electricity">
          <Columns label="Electricity per month, bar chart" format={peso} rows={d.electricity.map((e) => ({ key: e.month, label: monthName(e.month), value: e.amount }))} />
        </Card>
        <Card title="Payroll">
          <p className="text-xl font-semibold tabular-nums">{peso(d.payroll.total)}</p>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-stone-600">Therapists</dt><dd className="tabular-nums">{peso(d.payroll.therapists)}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-600">Receptionist</dt><dd className="tabular-nums">{peso(d.payroll.receptionist)}</dd></div>
          </dl>
        </Card>
        <Card title="Discounts">
          <Ranking rows={d.discounts.map((x) => ({ name: x.label, amount: x.amount }))} empty="No discounts this month." />
        </Card>
      </section>

      <section aria-label="Guests" className="grid gap-6 lg:grid-cols-3">
        <Card title="Average Guests by weekday">
          <Columns label="Average Guests by weekday, bar chart" format={(v) => String(v)} rows={d.guests.byWeekday.map((w) => ({ key: w.day, label: w.day, value: w.average }))} />
          <p className="mt-2 text-sm text-stone-600">
            {d.guests.total} Guests served.
          </p>
        </Card>
        <Card title="Top Therapists">
          <Ranking rows={d.topTherapists} empty="Counts from Go-live." />
        </Card>
        <Card title="Top Services">
          <Ranking rows={d.topServices} empty="Counts from Go-live." />
        </Card>
      </section>

      <MissedGuests g={d.guests} />

      <section aria-label="Stock and cash" className="grid gap-6 lg:grid-cols-3">
        <ConsumablesCard c={d.consumables} />
        <Card title="Unused Vouchers">
          <p className="text-xl font-semibold tabular-nums">{peso(d.vouchers.value)}</p>
          <p className="mt-1 text-sm text-stone-600">{d.vouchers.count} services still owed, at today’s Regular Price.</p>
        </Card>
        <Card title="Day Close cash">
          <p className={`text-xl font-semibold tabular-nums ${d.variance.total < 0 ? 'text-red-700' : ''}`}>{peso(d.variance.total)}</p>
          <p className="mt-1 text-sm text-stone-600">
            {d.variance.days ? `${d.variance.days} day${d.variance.days === 1 ? '' : 's'} off. Largest ${peso(d.variance.worst?.variance ?? 0)} on ${longDate(d.variance.worst!.date)}.` : 'No days off.'}
          </p>
        </Card>
      </section>

      {d.birthdays.length > 0 && (
        <Card title="Birthdays this month">
          <p className="text-sm text-stone-700">{d.birthdays.map((b) => `${b.name}, ${monthName(d.month)} ${b.day}`).join(' · ')}</p>
        </Card>
      )}

      <p className="text-sm text-stone-500">
        Details are in <Link to="/reports" className="underline">Reports</Link> and <Link to="/finance" className="underline">Finance</Link>.
      </p>
    </div>
  );
}

/** The Super Admin's landing page: insights only; detail stays in Reports. */
export function DashboardPage() {
  const thisMonth = todayManila().slice(0, 7);
  const lastMonth = previousMonth(thisMonth);
  const [month, setMonth] = useState(thisMonth);
  const { data, error, isPending } = useDashboard(month);
  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex gap-1 rounded-md border border-stone-200 bg-white p-1 text-sm">
          {[thisMonth, lastMonth].map((m) => (
            <button key={m} type="button" className={`rounded px-3 py-1 font-medium ${m === month ? 'bg-teal-700 text-white' : 'text-stone-600 hover:bg-stone-100'}`} onClick={() => setMonth(m)}>
              {monthName(m, 'long')}
            </button>
          ))}
        </div>
      </div>
      <NeedsAttention enabled />
      <LateEntries />
      {error && <Alert>{error.message}</Alert>}
      {isPending && <p className="text-sm text-stone-500">Loading…</p>}
      {data && <Body d={data} />}
    </div>
  );
}
