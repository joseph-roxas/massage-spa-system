import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { CATCH_UP_DAYS } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select, td, th } from '../components/ui';
import { api } from '../lib/api';
import { clock, longDate, parsePesos, peso } from '../lib/format';
import { TimeInput } from '../components/TimeInput';

type Person = { id: string; displayName: string; kind: 'therapist' | 'receptionist' | 'reliever'; therapistClass: 'regular' | 'lmt' | null };
type SaleLine = {
  id: string;
  time: string | null;
  endTime: string | null;
  guestName: string | null;
  serviceId: string;
  therapistId: string;
  service: string;
  code: string;
  therapist: string;
  discountType: string;
  discountRef: string | null;
  reason: string | null;
  regularPrice: number;
  discountAmount: number;
  amountDue: number;
  commissionAmount: number;
  method: 'cash' | 'gcash' | null;
  gcashRef: string | null;
  catchUp: boolean;
};
type Day = {
  date: string;
  people: Person[];
  services: { id: string; code: string; name: string; durationMin: number; kind: 'single' | 'combo' }[];
  categories: { id: string; name: string }[];
  promos: { id: string; name: string }[];
  times: { id: string; staff: string; clockIn: string; clockOut: string | null; isRelief: boolean }[];
  sales: SaleLine[];
  expenses: { id: string; category: string; description: string; amount: number }[];
  cashAdvances: { id: string; staff: string; amount: number; note: string | null }[];
  week: { day: string; guests: number; total: number }[];
  totals: { guests: number; sales: number; commission: number; expenses: number };
};

const DISCOUNT_LABEL: Record<string, string> = { none: '—', senior: 'Senior', pwd: 'PWD', promo: 'Promo', voucher: 'Voucher', complimentary: 'Complimentary' };

function useEntry(date: string) {
  const qc = useQueryClient();
  const day = useQuery({ queryKey: ['catch-up', date], queryFn: () => api<Day>(`/catch-up/${date}`) });
  const act = useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) => api<{ id?: string }>(`/catch-up/${date}/${req.path}`, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['catch-up'] }),
  });
  return { day, act };
}

type Act = ReturnType<typeof useEntry>['act'];

function Remove({ act, path }: { act: Act; path: string }) {
  return (
    <button type="button" className="text-xs text-stone-500 underline" onClick={() => act.mutate({ path, method: 'DELETE' })}>
      Remove
    </button>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            {head.map((h, i) => (
              <th key={i} className={`${th} whitespace-nowrap`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">{children}</tbody>
      </table>
    </div>
  );
}

function TimeRecords({ data, act }: { data: Day; act: Act }) {
  const [f, setF] = useState({ staffId: '', clockIn: '', clockOut: '', isRelief: false });
  const [round, setRound] = useState(0);
  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate(
      { path: 'time-records', body: f },
      {
        onSuccess: () => {
          setF({ staffId: '', clockIn: '', clockOut: '', isRelief: false });
          setRound((r) => r + 1);
        },
      },
    );
  }
  return (
    <Card title={`Time records (${data.times.length})`}>
      <form key={round} onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Field label="Staff">
            <Select required autoFocus value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}>
              <option value="">Choose…</option>
              {data.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.kind === 'therapist' ? (p.therapistClass === 'lmt' ? 'LMT' : 'Therapist') : p.kind === 'receptionist' ? 'Receptionist' : 'Reliever'})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Clock in">
          <TimeInput required value={f.clockIn} onChange={(v) => setF({ ...f, clockIn: v })} />
        </Field>
        <Field label="Clock out">
          <TimeInput required value={f.clockOut} onChange={(v) => setF({ ...f, clockOut: v })} />
        </Field>
        <div className="pb-2">
          <Checkbox label="Relief Shift" checked={f.isRelief} onChange={(e) => setF({ ...f, isRelief: e.target.checked })} />
        </div>
        <Button type="submit" disabled={act.isPending}>Add</Button>
      </form>
      {data.times.length > 0 && (
        <Table head={['Staff', 'In', 'Out', '', '']}>
          {data.times.map((t) => (
            <tr key={t.id}>
              <td className={td}>{t.staff}</td>
              <td className={`${td} tabular-nums`}>{clock(t.clockIn)}</td>
              <td className={`${td} tabular-nums`}>{t.clockOut ? clock(t.clockOut) : '—'}</td>
              <td className={td}>{t.isRelief && <Badge tone="teal">Relief Shift</Badge>}</td>
              <td className={`${td} text-right`}>
                <Remove act={act} path={`time-records/${t.id}`} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

const NEW_SALE = { time: '', guestName: '', serviceId: '', therapistId: '', discount: 'none', serial: '', idNumber: '', reason: '', method: 'cash', gcashRef: '' };
type SaleForm = typeof NEW_SALE;

/** A line as the form shows it, to correct it. */
function formOf(l: SaleLine): SaleForm {
  const discount = l.discountType === 'promo' ? `promo:${l.discountRef}` : l.discountType;
  return {
    time: l.time ?? '',
    guestName: l.guestName ?? '',
    serviceId: l.serviceId,
    therapistId: l.therapistId,
    discount,
    serial: l.discountType === 'voucher' ? (l.discountRef ?? '') : '',
    idNumber: (l.discountType === 'senior' || l.discountType === 'pwd') && l.discountRef !== 'Not recorded' ? (l.discountRef ?? '') : '',
    reason: l.discountType === 'complimentary' ? (l.reason ?? '') : '',
    method: l.method ?? 'cash',
    gcashRef: l.gcashRef ?? '',
  };
}

/** The same Guest's next Service: it starts when this one ended; Senior/PWD covers the whole bill, so it carries over. */
function nextServiceOf(l: SaleLine): SaleForm {
  const f = formOf(l);
  const statutory = f.discount === 'senior' || f.discount === 'pwd';
  return { ...NEW_SALE, time: l.endTime ?? '', guestName: f.guestName, therapistId: f.therapistId, method: f.method, gcashRef: f.gcashRef, discount: statutory ? f.discount : 'none', idNumber: statutory ? f.idNumber : '' };
}

type Mode = { kind: 'add' } | { kind: 'edit'; line: SaleLine } | { kind: 'next'; line: SaleLine };

function Sales({ data, act }: { data: Day; act: Act }) {
  const [f, setF] = useState(NEW_SALE);
  const [mode, setMode] = useState<Mode>({ kind: 'add' });
  const [round, setRound] = useState(0);
  const set = (patch: Partial<SaleForm>) => setF((x) => ({ ...x, ...patch }));
  const therapists = data.people.filter((p) => p.kind === 'therapist');

  function start(next: Mode, form: SaleForm) {
    setMode(next);
    setF(form);
    setRound((r) => r + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const reset = () => start({ kind: 'add' }, NEW_SALE);

  function submit(e: FormEvent) {
    e.preventDefault();
    const statutory = f.discount === 'senior' || f.discount === 'pwd' ? f.discount : null;
    const body = {
      time: f.time,
      guestName: f.guestName || null,
      serviceId: f.serviceId,
      therapistId: f.therapistId,
      promoId: f.discount.startsWith('promo:') ? f.discount.slice('promo:'.length) : null,
      statutory,
      idNumber: f.idNumber || undefined,
      voucherSerial: f.discount === 'voucher' ? f.serial : null,
      complimentaryReason: f.discount === 'complimentary' ? f.reason : null,
      method: f.method,
      gcashRef: f.gcashRef || undefined,
    };
    const req = mode.kind === 'edit' ? { path: `sales/${mode.line.id}`, method: 'PUT', body } : { path: 'sales', body };
    act.mutate(req, { onSuccess: reset });
  }

  const heading =
    mode.kind === 'edit'
      ? `Correcting ${mode.line.time ? clock(mode.line.time) : ''} ${mode.line.service}, ${mode.line.therapist}`
      : mode.kind === 'next'
        ? `Another service for ${mode.line.guestName || 'the same guest'}`
        : null;

  return (
    <Card title={`Sales (${data.totals.guests}) · ${peso(data.totals.sales)} · Commission ${peso(data.totals.commission)}`}>
      <form key={round} onSubmit={submit} className={`mb-4 space-y-3 ${heading ? 'rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200' : ''}`}>
        {heading && <p className="text-sm font-semibold text-amber-900">{heading}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Time">
              <TimeInput required autoFocus value={f.time} onChange={(v) => set({ time: v })} />
            </Field>
          </div>
          <div className="w-52">
            <Field label="Guest (optional)">
              <Input value={f.guestName} maxLength={80} onChange={(e) => set({ guestName: e.target.value })} placeholder="As on the paper" />
            </Field>
          </div>
          <div className="w-64">
            <Field label="Service">
              <Select required value={f.serviceId} onChange={(e) => set({ serviceId: e.target.value })}>
                <option value="">Choose…</option>
                {data.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-44">
            <Field label="Therapist">
              <Select required value={f.therapistId} onChange={(e) => set({ therapistId: e.target.value })}>
                <option value="">Choose…</option>
                {therapists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-44">
            <Field label="Discount">
              <Select value={f.discount} onChange={(e) => set({ discount: e.target.value })}>
                <option value="none">None</option>
                {data.promos.map((p) => (
                  <option key={p.id} value={`promo:${p.id}`}>
                    {p.name}
                  </option>
                ))}
                <option value="senior">Senior Citizen</option>
                <option value="pwd">PWD</option>
                <option value="voucher">Voucher</option>
                <option value="complimentary">Complimentary</option>
              </Select>
            </Field>
          </div>
          <div className="w-32">
            <Field label="Payment">
              <Select value={f.method} onChange={(e) => set({ method: e.target.value })}>
                <option value="cash">Cash</option>
                <option value="gcash">GCash</option>
              </Select>
            </Field>
          </div>
          {f.method === 'gcash' && (
            <div className="w-40">
              <Field label="GCash ref (optional)">
                <Input value={f.gcashRef} onChange={(e) => set({ gcashRef: e.target.value })} />
              </Field>
            </div>
          )}
          {(f.discount === 'senior' || f.discount === 'pwd') && (
            <div className="w-40">
              <Field label="ID number (optional)">
                <Input value={f.idNumber} onChange={(e) => set({ idNumber: e.target.value })} />
              </Field>
            </div>
          )}
          {f.discount === 'voucher' && (
            <div className="w-44">
              <Field label="Voucher serial">
                <Input required value={f.serial} onChange={(e) => set({ serial: e.target.value })} placeholder="NTL-SM-0271" />
              </Field>
            </div>
          )}
          {f.discount === 'complimentary' && (
            <div className="w-56">
              <Field label="Why complimentary?">
                <Input required minLength={3} value={f.reason} onChange={(e) => set({ reason: e.target.value })} />
              </Field>
            </div>
          )}
          <Button type="submit" disabled={act.isPending}>
            {mode.kind === 'edit' ? 'Save changes' : 'Add sale'}
          </Button>
          {mode.kind !== 'add' && (
            <Button type="button" variant="secondary" onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
        {mode.kind === 'edit' && <p className="text-xs text-stone-600">Saving prices it again by the checkout rules, so the amount paid and the Commission follow the changes.</p>}
      </form>
      {data.sales.length > 0 && (
        <Table head={['Time', 'Guest', 'Service', 'Therapist', 'Regular', 'Discount', 'Paid', 'Commission', 'Payment', '']}>
          {data.sales.map((s) => (
            <tr key={s.id} className={mode.kind !== 'add' && mode.line.id === s.id ? 'bg-amber-50' : ''}>
              <td className={`${td} whitespace-nowrap tabular-nums`}>{s.time ? clock(s.time) : '—'}</td>
              <td className={td}>{s.guestName || '—'}</td>
              <td className={td}>{s.service}</td>
              <td className={td}>{s.therapist}</td>
              <td className={`${td} text-right tabular-nums`}>{peso(s.regularPrice)}</td>
              <td className={td}>
                {DISCOUNT_LABEL[s.discountType]}
                {s.discountAmount > 0 && ` −${peso(s.discountAmount)}`}
              </td>
              <td className={`${td} text-right tabular-nums`}>{peso(s.amountDue)}</td>
              <td className={`${td} text-right tabular-nums`}>{peso(s.commissionAmount)}</td>
              <td className={td}>{s.method === 'gcash' ? 'GCash' : s.method === 'cash' ? 'Cash' : '—'}</td>
              <td className={`${td} whitespace-nowrap text-right`}>
                {s.catchUp && (
                  <span className="inline-flex gap-3">
                    <button type="button" className="text-xs text-teal-700 underline" onClick={() => start({ kind: 'edit', line: s }, formOf(s))}>
                      Edit
                    </button>
                    <button type="button" className="text-xs text-teal-700 underline" onClick={() => start({ kind: 'next', line: s }, nextServiceOf(s))}>
                      Add service for this guest
                    </button>
                    <Remove act={act} path={`sales/${s.id}`} />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Expenses({ data, act }: { data: Day; act: Act }) {
  const [f, setF] = useState({ categoryId: '', description: '', amount: '' });
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const amount = parsePesos(f.amount);
    if (amount === null) return setError('Enter a peso amount.');
    setError(null);
    act.mutate({ path: 'expenses', body: { categoryId: f.categoryId, description: f.description, amount } }, { onSuccess: () => setF({ categoryId: '', description: '', amount: '' }) });
  }
  return (
    <Card title={`Expenses · ${peso(data.totals.expenses)}`}>
      {error && <Alert>{error}</Alert>}
      <form onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-52">
          <Field label="Category">
            <Select required value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
              <option value="">Choose…</option>
              {data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-64">
          <Field label="Description">
            <Input required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
        </div>
        <div className="w-32">
          <Field label="Amount (₱)">
            <Input inputMode="decimal" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
        </div>
        <Button type="submit" disabled={act.isPending}>Add</Button>
      </form>
      {data.expenses.length > 0 && (
        <Table head={['Category', 'Description', 'Amount', '']}>
          {data.expenses.map((x) => (
            <tr key={x.id}>
              <td className={td}>{x.category}</td>
              <td className={td}>{x.description}</td>
              <td className={`${td} text-right tabular-nums`}>{peso(x.amount)}</td>
              <td className={`${td} text-right`}>
                <Remove act={act} path={`expenses/${x.id}`} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function CashAdvances({ data, act }: { data: Day; act: Act }) {
  const [f, setF] = useState({ staffId: '', amount: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const amount = parsePesos(f.amount);
    if (amount === null) return setError('Enter a peso amount.');
    setError(null);
    act.mutate({ path: 'cash-advances', body: { staffId: f.staffId, amount, note: f.note || undefined } }, { onSuccess: () => setF({ staffId: '', amount: '', note: '' }) });
  }
  return (
    <Card title={`Cash Advances (${data.cashAdvances.length})`}>
      {error && <Alert>{error}</Alert>}
      <form onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-52">
          <Field label="Staff">
            <Select required value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}>
              <option value="">Choose…</option>
              {data.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-32">
          <Field label="Amount (₱)">
            <Input inputMode="decimal" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
        </div>
        <div className="w-64">
          <Field label="Note (optional)">
            <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
        </div>
        <Button type="submit" disabled={act.isPending}>Add</Button>
      </form>
      {data.cashAdvances.length > 0 && (
        <Table head={['Staff', 'Amount', 'Note', '']}>
          {data.cashAdvances.map((a) => (
            <tr key={a.id}>
              <td className={td}>{a.staff}</td>
              <td className={`${td} text-right tabular-nums`}>{peso(a.amount)}</td>
              <td className={td}>{a.note}</td>
              <td className={`${td} text-right`}>
                <Remove act={act} path={`cash-advances/${a.id}`} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

export function CatchUpPage() {
  const [params, setParams] = useSearchParams();
  const date = (CATCH_UP_DAYS as readonly string[]).includes(params.get('day') ?? '') ? params.get('day')! : CATCH_UP_DAYS[0];
  const { day, act } = useEntry(date);
  const data = day.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Nov 2–8 entry</h1>
        <p className="text-sm text-stone-500">
          Enter each day from the paper records. Commission and totals are worked out as you go. When all seven days are in, generate the week under{' '}
          <Link to="/payroll" className="text-teal-800 underline">
            Payroll
          </Link>
          .
        </p>
      </div>
      <nav aria-label="Days" className="flex flex-wrap gap-2">
        {CATCH_UP_DAYS.map((d) => {
          const w = data?.week.find((x) => x.day === d);
          return (
            <button
              key={d}
              type="button"
              onClick={() => setParams({ day: d })}
              className={`rounded-md border px-3 py-1.5 text-left text-sm ${d === date ? 'border-teal-700 bg-teal-700 text-white' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'}`}
            >
              <span className="block font-medium">{longDate(d)}</span>
              <span className={`block text-xs ${d === date ? 'text-teal-50' : 'text-stone-500'}`}>{w ? `${w.guests} ${w.guests === 1 ? 'guest' : 'guests'} · ${peso(w.total)}` : 'Nothing yet'}</span>
            </button>
          );
        })}
      </nav>
      {day.error && <Alert>{day.error.message}</Alert>}
      {act.error && <Alert>{act.error.message}</Alert>}
      {data && (
        <>
          <TimeRecords data={data} act={act} />
          <Sales data={data} act={act} />
          <Expenses data={data} act={act} />
          <CashAdvances data={data} act={act} />
        </>
      )}
    </div>
  );
}
