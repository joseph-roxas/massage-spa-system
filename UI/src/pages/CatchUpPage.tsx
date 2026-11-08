import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { CATCH_UP_DAYS } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select, td, th } from '../components/ui';
import { api } from '../lib/api';
import { longDate, parsePesos, peso } from '../lib/format';

type Person = { id: string; displayName: string; kind: 'therapist' | 'receptionist' | 'reliever'; therapistClass: 'regular' | 'lmt' | null };
type Day = {
  date: string;
  people: Person[];
  services: { id: string; code: string; name: string; durationMin: number; kind: 'single' | 'combo' }[];
  categories: { id: string; name: string }[];
  promos: { id: string; name: string }[];
  times: { id: string; staff: string; clockIn: string; clockOut: string | null; isRelief: boolean }[];
  sales: { id: string; time: string | null; service: string; code: string; therapist: string; discountType: string; regularPrice: number; discountAmount: number; amountDue: number; commissionAmount: number; method: 'cash' | 'gcash' | null; catchUp: boolean }[];
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
          <Input type="time" required value={f.clockIn} onChange={(e) => setF({ ...f, clockIn: e.target.value })} />
        </Field>
        <Field label="Clock out">
          <Input type="time" required value={f.clockOut} onChange={(e) => setF({ ...f, clockOut: e.target.value })} />
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
              <td className={`${td} tabular-nums`}>{t.clockIn}</td>
              <td className={`${td} tabular-nums`}>{t.clockOut}</td>
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

const NEW_SALE = { time: '', serviceId: '', therapistId: '', discount: 'none', serial: '', idNumber: '', reason: '', method: 'cash', gcashRef: '' };

function Sales({ data, act }: { data: Day; act: Act }) {
  const [f, setF] = useState(NEW_SALE);
  const [round, setRound] = useState(0);
  const set = (patch: Partial<typeof NEW_SALE>) => setF((x) => ({ ...x, ...patch }));
  const therapists = data.people.filter((p) => p.kind === 'therapist');

  function submit(e: FormEvent) {
    e.preventDefault();
    const statutory = f.discount === 'senior' || f.discount === 'pwd' ? f.discount : null;
    const body = {
      time: f.time,
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
    act.mutate(
      { path: 'sales', body },
      {
        onSuccess: () => {
          setF(NEW_SALE);
          setRound((r) => r + 1);
        },
      },
    );
  }

  return (
    <Card title={`Sales (${data.totals.guests}) · ${peso(data.totals.sales)} · Commission ${peso(data.totals.commission)}`}>
      <form key={round} onSubmit={submit} className="mb-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Time">
            <Input type="time" required autoFocus value={f.time} onChange={(e) => set({ time: e.target.value })} />
          </Field>
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
          <Button type="submit" disabled={act.isPending}>Add sale</Button>
        </div>
      </form>
      {data.sales.length > 0 && (
        <Table head={['Time', 'Service', 'Therapist', 'Regular', 'Discount', 'Paid', 'Commission', 'Payment', '']}>
          {data.sales.map((s) => (
            <tr key={s.id}>
              <td className={`${td} tabular-nums`}>{s.time}</td>
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
              <td className={`${td} text-right`}>{s.catchUp && <Remove act={act} path={`sales/${s.id}`} />}</td>
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
