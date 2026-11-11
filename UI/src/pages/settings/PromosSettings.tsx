import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select } from '../../components/ui';
import { usePromos, useSave, useServices, type Promo } from '../../lib/catalogue';
import { clock, longDate, percent, todayManila } from '../../lib/format';

type Draft = Omit<Promo, 'id' | 'percentBp'> & { percent: string };

function PromoForm({ promo, onDone }: { promo?: Promo; onDone: () => void }) {
  const services = useServices();
  const [d, setD] = useState<Draft>({
    name: promo?.name ?? '',
    serviceId: promo?.serviceId ?? '',
    percent: promo ? String(promo.percentBp / 100) : '10',
    startTime: promo?.startTime ?? '14:00',
    endTime: promo?.endTime ?? '18:00',
    validFrom: promo?.validFrom ?? todayManila(),
    validTo: promo?.validTo ?? todayManila(),
    active: promo?.active ?? true,
  });
  const save = useSave(
    (body: Omit<Promo, 'id'>) => (promo ? { path: `/catalogue/promos/${promo.id}`, method: 'PUT', body } : { path: '/catalogue/promos', body }),
    'catalogue',
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const { percent: pct, ...rest } = d;
    save.mutate({ ...rest, percentBp: Math.round(Number(pct) * 100) }, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="grid grid-cols-4 gap-3">
        <Field label="Promo name">
          <Input required value={d.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Service">
            <Select required value={d.serviceId} onChange={(e) => set('serviceId', e.target.value)}>
              <option value="">Choose…</option>
              {services.data?.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Discount (%)">
          <Input type="number" min={0.01} max={100} step={0.01} required value={d.percent} onChange={(e) => set('percent', e.target.value)} />
        </Field>
        <Field label="Service starts from" hint="Inclusive">
          <Input type="time" required value={d.startTime} onChange={(e) => set('startTime', e.target.value)} />
        </Field>
        <Field label="…up to" hint="Inclusive: a 6:00 PM end means a 6:00 PM start still counts">
          <Input type="time" required value={d.endTime} onChange={(e) => set('endTime', e.target.value)} />
        </Field>
        <Field label="First day">
          <Input type="date" required value={d.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
        </Field>
        <Field label="Last day">
          <Input type="date" required value={d.validTo} onChange={(e) => set('validTo', e.target.value)} />
        </Field>
      </div>
      <Checkbox label="Active" checked={d.active} onChange={(e) => set('active', e.target.checked)} />
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>{promo ? 'Save promo' : 'Add promo'}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

export function PromosSettings() {
  const promos = usePromos();
  const services = useServices();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const today = todayManila();
  const name = (id: string) => services.data?.services.find((s) => s.id === id)?.name ?? id;

  return (
    <Card title="Promos" actions={editing !== 'new' && <Button onClick={() => setEditing('new')}>Add promo</Button>}>
      <p className="mb-4 text-sm text-stone-500">
        A promo is one Discount option. The guest always gets the single largest Discount they qualify for; Discounts never stack.
      </p>
      {editing === 'new' && (
        <div className="mb-4">
          <PromoForm onDone={() => setEditing(null)} />
        </div>
      )}
      <ul className="divide-y divide-stone-100">
        {promos.data?.promos.map((p) => {
          const status = !p.active ? 'Off' : p.validTo < today ? 'Ended' : p.validFrom > today ? 'Upcoming' : 'Running';
          return (
            <li key={p.id} className="py-3">
              {editing === p.id ? (
                <PromoForm promo={p} onDone={() => setEditing(null)} />
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">
                      {p.name} <Badge tone={status === 'Running' ? 'teal' : status === 'Upcoming' ? 'amber' : 'stone'}>{status}</Badge>
                    </p>
                    <p className="text-sm text-stone-600">
                      {percent(p.percentBp)} off {name(p.serviceId)} · starts {clock(p.startTime)} to {clock(p.endTime)} ·{' '}
                      {longDate(p.validFrom)} – {longDate(p.validTo)}
                    </p>
                  </div>
                  <Button variant="secondary" className="h-8 px-3" onClick={() => setEditing(p.id)}>Edit</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
