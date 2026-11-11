import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Badge, Button, Card, Field, Input, Select, td, th } from '../components/ui';
import { useCan } from '../lib/auth';
import { manilaTime } from '../lib/attendance';
import { longDate, peso } from '../lib/format';
import { STATUTORY_LABEL, useGuest, useGuestAction, useGuests, visitsLabel, type GuestDetail, type RegularRule, type StatutoryType } from '../lib/guests';

/** The Super Admin's setting for who counts as a Regular. */
function RegularRuleCard({ rule }: { rule: RegularRule }) {
  const act = useGuestAction();
  const [visits, setVisits] = useState(String(rule.visits));
  const [days, setDays] = useState(String(rule.days));
  const [saved, setSaved] = useState(false);
  return (
    <Card title="Who is a Regular">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          act.mutate({ path: '/settings/pay-rules/regular_guest_rule', method: 'PUT', body: { value: { visits: Number(visits), days: Number(days) } } }, { onSuccess: () => setSaved(true) });
        }}
      >
        <Field label="Visits">
          <Input type="number" min={1} max={50} required value={visits} onChange={(e) => (setVisits(e.target.value), setSaved(false))} className="w-24" />
        </Field>
        <Field label="Within the last (days)">
          <Input type="number" min={7} max={730} required value={days} onChange={(e) => (setDays(e.target.value), setSaved(false))} className="w-28" />
        </Field>
        <Button type="submit" variant="secondary" disabled={act.isPending}>
          Save
        </Button>
        {act.error && <span className="text-sm text-red-700">{act.error.message}</span>}
        {saved && !act.error && <span className="text-sm text-teal-700">Saved.</span>}
      </form>
    </Card>
  );
}

export function GuestsPage() {
  const [q, setQ] = useState('');
  const [regularsOnly, setRegularsOnly] = useState(false);
  const { data, error } = useGuests(q.trim());
  const isOwner = useCan('settings.manage');
  const rows = (data?.guests ?? []).filter((g) => !regularsOnly || g.isRegular);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Guests</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={regularsOnly} onChange={(e) => setRegularsOnly(e.target.checked)} /> Regulars only
          </label>
          <Input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        </div>
      </div>
      {error && <Alert>{error.message}</Alert>}
      {data && (
        <p className="text-sm text-stone-500">
          A Regular has {data.rule.visits} or more visits in the last {data.rule.days} days. A visit is a day with at least one service checked out.
        </p>
      )}
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-stone-500">{q ? 'No guest matches.' : 'No Guest Records yet. They are saved when booking a guest or selling vouchers.'}</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Name</th>
                <th className={th}>Phone</th>
                <th className={`${th} text-right`}>Visits</th>
                <th className={th}>Last visit</th>
                <th className={th}>Every</th>
                <th className={th}>SC / PWD ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((g) => (
                <tr key={g.id}>
                  <td className={td}>
                    <Link to={`/guests/${g.id}`} className="font-medium text-teal-800 hover:underline">
                      {g.name}
                    </Link>{' '}
                    {g.isRegular && <Badge tone="teal">Regular</Badge>}
                  </td>
                  <td className={td}>{g.phone ?? '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>{g.visits}</td>
                  <td className={td}>{g.lastVisit ? longDate(g.lastVisit) : '—'}</td>
                  <td className={td}>{g.avgDaysBetween !== null ? `${g.avgDaysBetween} days` : '—'}</td>
                  <td className={td}>{g.statutoryType ? `${STATUTORY_LABEL[g.statutoryType]} ${g.statutoryIdMasked}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {isOwner && data && <RegularRuleCard key={`${data.rule.visits}-${data.rule.days}`} rule={data.rule} />}
    </div>
  );
}

function EditGuest({ guest }: { guest: GuestDetail['guest'] }) {
  const act = useGuestAction();
  const [d, setD] = useState({ name: guest.name, phone: guest.phone ?? '', statutoryType: (guest.statutoryType ?? '') as StatutoryType | '', statutoryIdNo: guest.statutoryIdNo ?? '' });
  const [saved, setSaved] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    act.mutate(
      { path: `/guests/${guest.id}`, method: 'PATCH', body: { ...d, statutoryType: d.statutoryType || null, statutoryIdNo: d.statutoryType ? d.statutoryIdNo : null } },
      { onSuccess: () => setSaved(true) },
    );
  }
  return (
    <Card title="Guest Record">
      <form onSubmit={submit} className="space-y-3">
        {act.error && <Alert>{act.error.message}</Alert>}
        {saved && !act.error && <Alert tone="success">Saved.</Alert>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Name">
            <Input required minLength={2} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Phone (optional)">
            <Input inputMode="tel" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} />
          </Field>
          <Field label="SC / PWD">
            <Select value={d.statutoryType} onChange={(e) => setD({ ...d, statutoryType: e.target.value as StatutoryType | '' })}>
              <option value="">None</option>
              <option value="senior">Senior Citizen</option>
              <option value="pwd">PWD</option>
            </Select>
          </Field>
          {d.statutoryType && (
            <Field label="ID number" hint="Filled in at checkout">
              <Input required minLength={3} value={d.statutoryIdNo} onChange={(e) => setD({ ...d, statutoryIdNo: e.target.value })} />
            </Field>
          )}
        </div>
        <Button type="submit" variant="secondary" disabled={act.isPending}>
          Save
        </Button>
      </form>
    </Card>
  );
}

/** The Super Admin folds a duplicate record into this one. */
function MergeCard({ guest }: { guest: GuestDetail['guest'] }) {
  const act = useGuestAction();
  const [q, setQ] = useState('');
  const others = useGuests(q.trim(), q.trim().length >= 2).data?.guests.filter((g) => g.id !== guest.id) ?? [];
  return (
    <Card title="Merge a duplicate into this record">
      {act.error && <Alert>{act.error.message}</Alert>}
      <p className="mb-3 text-sm text-stone-600">Its visits and voucher purchases move here, and it disappears from the list. This can’t be undone.</p>
      <Input placeholder="Search the duplicate’s name or phone" value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
      {q.trim().length >= 2 && (
        <ul className="mt-2 divide-y divide-stone-100 text-sm">
          {others.length === 0 && <li className="py-2 text-stone-500">No other record matches.</li>}
          {others.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                <span className="font-medium">{g.name}</span>
                <span className="text-stone-500"> · {[g.phone, visitsLabel(g)].filter(Boolean).join(' · ')}</span>
              </span>
              <Button
                variant="secondary"
                className="h-8"
                disabled={act.isPending}
                onClick={() => confirm(`Merge “${g.name}” into “${guest.name}”?`) && act.mutate({ path: `/guests/${g.id}/merge`, body: { intoId: guest.id } }, { onSuccess: () => setQ('') })}
              >
                Merge into {guest.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function GuestPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error } = useGuest(id);
  const isOwner = useCan('settings.manage');
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  const { guest: g, visits, vouchers } = data;
  if (g.mergedInto) {
    return (
      <Alert tone="info">
        This record was merged.{' '}
        <button type="button" className="underline" onClick={() => navigate(`/guests/${g.mergedInto}`)}>
          Open the record it was merged into
        </button>
      </Alert>
    );
  }
  return (
    <div className="space-y-6">
      <Link to="/guests" className="text-sm text-teal-800 hover:underline">
        ← All guests
      </Link>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{g.name}</h1>
        {g.isRegular && <Badge tone="teal">Regular</Badge>}
        <p className="text-sm text-stone-600">
          {g.visits} {g.visits === 1 ? 'visit' : 'visits'}
          {g.lastVisit && ` · last ${longDate(g.lastVisit)}`}
          {g.avgDaysBetween !== null && ` · comes every ${g.avgDaysBetween} days on average`}
        </p>
      </div>
      <EditGuest key={`${g.name}-${g.statutoryIdNo}`} guest={g} />
      <Card title="Visits">
        {visits.length === 0 ? (
          <p className="text-sm text-stone-500">No services checked out yet.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Day</th>
                <th className={th}>Service</th>
                <th className={th}>Therapist</th>
                <th className={th}>Room</th>
                <th className={`${th} text-right`}>Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {visits.map((v, i) => (
                <tr key={i}>
                  <td className={td}>
                    {longDate(v.day)}
                    {v.startedAt && <span className="text-stone-500"> · {manilaTime(v.startedAt)}</span>}
                  </td>
                  <td className={td}>{v.serviceName}</td>
                  <td className={td}>{v.therapistName}</td>
                  <td className={td}>{v.roomName ?? '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>{peso(v.amountDue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {vouchers.length > 0 && (
        <Card title="Vouchers bought">
          <ul className="divide-y divide-stone-100 text-sm">
            {vouchers.map((v) => (
              <li key={v.id} className="flex justify-between py-2">
                <span>
                  {longDate(v.day)} · {v.qtyPaid + v.qtyFree} × {v.serviceName}
                  {v.qtyFree > 0 && ` (${v.qtyFree} free)`}
                  {v.status === 'voided' && <Badge tone="red">Cancelled</Badge>}
                </span>
                <span className="tabular-nums">{peso(v.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {isOwner && <MergeCard guest={g} />}
    </div>
  );
}
