import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  dayWarnings,
  employerShares,
  moneyReceived,
  monthExpenses,
  parseReceptionistWorkbook,
  parseSalesWorkbook,
  royaltyForMonth,
  withheldByMonth,
  type DailySummaryDraft,
  type MonthDraft,
  type ReceptionistWorkbook,
  type SalesWorkbook,
} from '@spa/domain';
import { Alert, Badge, Button, Card, Field, FormPanel, Input, Select, td, th } from '../components/ui';
import { api } from '../lib/api';
import { readWorkbook, useBackfillStatus, usePastPayslips } from '../lib/backfill';
import { useStaff, type StaffMember } from '../lib/catalogue';
import { longDate, parsePesos, peso, pesosText } from '../lib/format';

/** "Gura, Evelyn" against a Staff record. */
function matchStaff(name: string, staff: StaffMember[]): string {
  const [last = '', first = ''] = name.split(',').map((s) => s.trim().toLowerCase());
  const hit = staff.find((s) => s.lastName.trim().toLowerCase() === last && (s.firstName.trim().toLowerCase().startsWith(first.split(' ')[0]!) || first.startsWith(s.firstName.trim().toLowerCase())));
  return hit?.id ?? '';
}

const WEEKS_PER_SAVE = 100;

function PesoInput({ value, onChange, label }: { value: number; onChange: (centavos: number) => void; label: string }) {
  const [text, setText] = useState(pesosText(value));
  return (
    <Input
      aria-label={label}
      inputMode="decimal"
      className="w-28 rounded-md border border-stone-300 px-2 py-1 text-right text-sm tabular-nums"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = parsePesos(e.target.value);
        if (v !== null) onChange(v);
      }}
    />
  );
}

/** The two workbooks read, checked and corrected on screen, then saved month by month. */
function Upload() {
  const qc = useQueryClient();
  const staff = useStaff();
  const [sales, setSales] = useState<SalesWorkbook | null>(null);
  const [desk, setDesk] = useState<ReceptionistWorkbook | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const everyone = useMemo(() => (staff.data?.staff ?? []).filter((s) => s.active), [staff.data]);

  async function pick(kind: 'sales' | 'desk', file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setSaved(null);
    setSaving(`Reading ${file.name}…`);
    try {
      const book = await readWorkbook(file);
      if (kind === 'sales') {
        const parsed = parseSalesWorkbook(book);
        setSales(parsed);
        setPeople((p) => ({ ...p, ...Object.fromEntries(parsed.names.map((n) => [n, p[n] || matchStaff(n, everyone)])) }));
      } else {
        const parsed = parseReceptionistWorkbook(book);
        setDesk(parsed);
        const receptionist = everyone.find((s) => s.kind === 'receptionist');
        setPeople((p) => ({ ...p, [parsed.name]: p[parsed.name] || receptionist?.id || '' }));
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That file could not be read.');
    }
    setSaving(null);
  }

  const setMonth = (month: string, change: Partial<MonthDraft>) => setSales((s) => s && { ...s, months: s.months.map((m) => (m.month === month ? { ...m, ...change } : m)) });
  const setDay = (date: string, change: Partial<DailySummaryDraft>) =>
    setSales((s) => s && { ...s, months: s.months.map((m) => (m.month === date.slice(0, 7) ? { ...m, days: m.days.map((d) => (d.date === date ? { ...d, ...change } : d)) } : m)) });

  const shares = useMemo(() => (sales ? employerShares(sales.months, withheldByMonth(sales.weeks, desk?.payslips ?? [])) : new Map<string, number>()), [sales, desk]);
  const flagged = sales?.months.flatMap((m) => m.days.filter((d) => dayWarnings(d).length)) ?? [];
  const names = [...(sales?.names ?? []), ...(desk ? [desk.name] : [])];
  const unmatched = names.filter((n) => !people[n]);
  const ready = !!sales && !!desk && !unmatched.length;

  async function save() {
    if (!sales || !desk) return;
    setProblem(null);
    setSaved(null);
    try {
      for (const m of sales.months) {
        setSaving(`Saving ${m.month}…`);
        await api(`/backfill/months/${m.month}`, {
          method: 'PUT',
          body: { days: m.days, receptionistPay: m.receptionistPay, expenses: monthExpenses(m, shares.get(m.month) ?? 0), royalty: royaltyForMonth(m.month, m.days) },
        });
      }
      setSaving('Saving 2551Q filings…');
      const filings = await api<{ skipped: string[] }>('/backfill/filings', { method: 'PUT', body: { filings: sales.filings } });
      const rows = sales.weeks.map(({ name, ...w }) => ({ ...w, staffId: people[name]! }));
      for (let i = 0; i < rows.length; i += WEEKS_PER_SAVE) {
        setSaving(`Saving therapist weeks ${i + 1} of ${rows.length}…`);
        await api('/backfill/therapist-weeks', { method: 'PUT', body: { rows: rows.slice(i, i + WEEKS_PER_SAVE) } });
      }
      setSaving('Saving payslips…');
      await api('/backfill/past-payslips', { method: 'PUT', body: { staffId: people[desk.name], payslips: desk.payslips } });
      setSaved(filings.skipped.length ? `Saved. ${filings.skipped.join(', ')} already filed in the system, so left as it is.` : 'Saved.');
      for (const key of ['backfill', 'past-payslips', 'go-live', 'attention']) qc.invalidateQueries({ queryKey: [key] });
    } catch (e) {
      setProblem(`${e instanceof Error ? e.message : 'Saving failed.'} Nothing after that point was saved; fix it and save again.`);
    }
    setSaving(null);
  }

  return (
    <Card title="Load the workbooks">
      <div className="space-y-4">
        <p className="text-sm text-stone-600">Choose both files to preview them. Nothing is saved until you press Save. Saving again later replaces the same months, weeks and payslips, so you can fill in gaps and load again.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="2026 Monthly Sales" hint={sales ? `${sales.months.length} months, ${sales.names.length} therapists` : 'The Excel file'}>
            <input type="file" accept=".xlsx" aria-label="Choose sales workbook" className="text-sm" onChange={(e) => pick('sales', e.target.files?.[0])} />
          </Field>
          <Field label="Receptionist Time Record" hint={desk ? `${desk.name}: ${desk.payslips.length} payslips` : 'The Excel file'}>
            <input type="file" accept=".xlsx" aria-label="Choose receptionist workbook" className="text-sm" onChange={(e) => pick('desk', e.target.files?.[0])} />
          </Field>
        </div>
        {saving && <Alert tone="info">{saving}</Alert>}
        {problem && <Alert>{problem}</Alert>}
        {saved && <Alert tone="success">{saved}</Alert>}
        {[...(sales?.warnings.filter((w) => /^\d{4}-\d{2}:/.test(w)) ?? []), ...(desk?.warnings ?? [])].map((w) => (
          <Alert key={w} tone="info">{w}</Alert>
        ))}

        {flagged.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Check these days</p>
            <table className="w-full">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className={th}>Day</th>
                  <th className={th}>Why</th>
                  <th className={`${th} text-right`}>Gross Sales</th>
                  <th className={`${th} text-right`}>Commission</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {flagged.map((d) => (
                  <tr key={d.date}>
                    <td className={`${td} whitespace-nowrap`}>{longDate(d.date)}</td>
                    <td className={td}>
                      <Badge tone="amber">{dayWarnings(d).join(' · ')}</Badge>
                    </td>
                    <td className={`${td} text-right`}>
                      <PesoInput label={`Gross Sales on ${d.date}`} value={d.cash} onChange={(cash) => setDay(d.date, { cash })} />
                    </td>
                    <td className={`${td} text-right`}>
                      <PesoInput label={`Commission on ${d.date}`} value={d.commission} onChange={(commission) => setDay(d.date, { commission })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {sales && (
          <div className="overflow-x-auto">
            <p className="mb-2 text-sm font-medium">Each month</p>
            <table className="w-full">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className={th}>Month</th>
                  <th className={`${th} text-right`}>Days</th>
                  <th className={`${th} text-right`}>Received</th>
                  <th className={`${th} text-right`}>Receptionist</th>
                  <th className={`${th} text-right`}>VECO</th>
                  <th className={`${th} text-right`}>Supplies</th>
                  <th className={`${th} text-right`}>Maintenance</th>
                  <th className={`${th} text-right`}>Royalty</th>
                  <th className={`${th} text-right`}>Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {sales.months.map((m) => {
                  const received = m.days.reduce((s, d) => s + moneyReceived(d), 0);
                  const commission = m.days.reduce((s, d) => s + d.commission, 0);
                  const royalty = royaltyForMonth(m.month, m.days);
                  const spent = monthExpenses(m, shares.get(m.month) ?? 0).reduce((s, e) => s + e.amount, 0);
                  return (
                    <tr key={m.month}>
                      <td className={td}>{m.month}</td>
                      <td className={`${td} text-right tabular-nums`}>{m.days.length}</td>
                      <td className={`${td} text-right tabular-nums`}>{peso(received)}</td>
                      <td className={`${td} text-right`}>
                        <PesoInput label={`Receptionist ${m.month}`} value={m.receptionistPay} onChange={(receptionistPay) => setMonth(m.month, { receptionistPay })} />
                      </td>
                      <td className={`${td} text-right`}>
                        <PesoInput label={`VECO ${m.month}`} value={m.electricity} onChange={(electricity) => setMonth(m.month, { electricity })} />
                      </td>
                      <td className={`${td} text-right`}>
                        <PesoInput label={`Supplies ${m.month}`} value={m.supplies} onChange={(supplies) => setMonth(m.month, { supplies })} />
                      </td>
                      <td className={`${td} text-right`}>
                        <PesoInput label={`Maintenance ${m.month}`} value={m.maintenance} onChange={(maintenance) => setMonth(m.month, { maintenance })} />
                      </td>
                      <td className={`${td} whitespace-nowrap text-right tabular-nums`}>
                        {peso(royalty.amount)} <Badge tone={royalty.paid ? 'stone' : 'amber'}>{royalty.paid ? 'Paid' : 'Payable'}</Badge>
                      </td>
                      <td className={`${td} text-right font-medium tabular-nums`}>{peso(received - commission - m.receptionistPay - royalty.amount - spent)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-stone-500">Profit is what was received less commission, the receptionist, Royalty and every expense. Contributions count only the shop&rsquo;s own share, once the Receptionist file is loaded.</p>
          </div>
        )}

        {names.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Match the names to Staff</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {names.map((n) => (
                <Field key={n} label={n}>
                  <Select value={people[n] ?? ''} onChange={(e) => setPeople((p) => ({ ...p, [n]: e.target.value }))}>
                    <option value="">Choose…</option>
                    {everyone.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </div>
        )}
        <Button disabled={!ready || !!saving} onClick={save}>
          Save
        </Button>
        {sales && !desk && <p className="text-xs text-stone-500">Choose the Receptionist file too.</p>}
        {unmatched.length > 0 && <p className="text-xs text-stone-500">{unmatched.length} name(s) still need matching. Add missing staff under Settings → Staff first.</p>}
      </div>
    </Card>
  );
}

const EMPTY = { cash: '', gcash: '', oil: '', voucher: '', foc: '', commission: '', laundry: '', expenses: '', guests: '', therapists: '', rejects: '' };
const MONEY_FIELDS = [
  ['cash', 'Gross Sales (cash)'],
  ['gcash', 'GCash'],
  ['oil', 'Oil (Owner’s Set-aside, not added to sales)'],
  ['voucher', 'Voucher sold'],
  ['foc', 'FOC'],
  ['commission', 'Commission'],
  ['laundry', 'Laundry'],
  ['expenses', 'Expenses'],
] as const;
const COUNT_FIELDS = [
  ['guests', '# of Guests'],
  ['therapists', '# Therapists'],
  ['rejects', 'Rejects'],
] as const;

/** One day added or fixed by hand, e.g. the days before go-live not yet in the file. */
function OneDay() {
  const qc = useQueryClient();
  const [date, setDate] = useState('');
  const [d, setD] = useState(EMPTY);
  const [note, setNote] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [exists, setExists] = useState(false);

  async function load(day: string) {
    setDate(day);
    setNote(null);
    if (!day) return;
    const { summary } = await api<{ summary: (Record<keyof typeof EMPTY, number> & { date: string }) | null }>(`/daily-summaries/${day}`);
    setExists(!!summary);
    setD(
      summary
        ? {
            ...(Object.fromEntries(MONEY_FIELDS.map(([k]) => [k, pesosText(summary[k])])) as Record<(typeof MONEY_FIELDS)[number][0], string>),
            guests: String(summary.guests),
            therapists: String(summary.therapists),
            rejects: String(summary.rejects),
          }
        : EMPTY,
    );
  }

  async function act(run: () => Promise<unknown>, done: string) {
    setNote(null);
    try {
      await run();
      setNote({ tone: 'success', text: done });
      qc.invalidateQueries({ queryKey: ['backfill'] });
    } catch (e) {
      setNote({ tone: 'error', text: e instanceof Error ? e.message : 'That did not save.' });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...Object.fromEntries(MONEY_FIELDS.map(([k]) => [k, parsePesos(d[k] || '0') ?? 0])),
      ...Object.fromEntries(COUNT_FIELDS.map(([k]) => [k, Number(d[k] || 0)])),
    };
    act(() => api(`/daily-summaries/${date}`, { method: 'PUT', body }), 'Day saved.').then(() => setExists(true));
  }

  return (
    <Card title="One day by hand">
      <FormPanel onSubmit={submit}>
        {note && <Alert tone={note.tone === 'success' ? 'success' : undefined}>{note.text}</Alert>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Day">
            <Input type="date" required value={date} onChange={(e) => load(e.target.value)} />
          </Field>
          {MONEY_FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <Input inputMode="decimal" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
            </Field>
          ))}
          {COUNT_FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <Input type="number" min={0} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={!date}>Save day</Button>
          {exists && (
            <Button
              type="button"
              variant="danger"
              onClick={() =>
                confirm(`Remove the Daily Summary for ${date}?`) &&
                act(() => api(`/daily-summaries/${date}`, { method: 'DELETE', body: {} }), 'Day removed.').then(() => {
                  setExists(false);
                  setD(EMPTY);
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </FormPanel>
    </Card>
  );
}

function Loaded() {
  const { data, error } = useBackfillStatus();
  const slips = usePastPayslips();
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  return (
    <Card title="Loaded so far">
      {data.months.length === 0 ? (
        <p className="text-sm text-stone-500">Nothing loaded yet.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            {data.months.map((m) => `${m.month} (${m.days} days, ${peso(m.received)})`).join(' · ')}
          </p>
          <p className="text-stone-600">
            {data.therapistWeeks} therapist weeks · {data.pastPayslips} past payslips · {data.filings} 2551Q filings
          </p>
          {(slips.data?.payslips.length ?? 0) > 0 && (
            <details>
              <summary className="cursor-pointer text-teal-800">Past Payslips</summary>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {slips.data!.payslips.map((p) => (
                  <li key={p.id}>
                    <Link to={`/past-payslip/${p.id}`} className="text-teal-800 hover:underline">
                      {longDate(p.weekStart)} – {longDate(p.weekEnd)}
                    </Link>{' '}
                    <span className="tabular-nums text-stone-500">{peso(p.net)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

/** Everything from before Go-live: Daily Summaries, Expenses, Royalty, 2551Q and Past Payslips. */
export function BackfillPage() {
  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">This year&rsquo;s records</h1>
      <Loaded />
      <Upload />
      <OneDay />
    </div>
  );
}
