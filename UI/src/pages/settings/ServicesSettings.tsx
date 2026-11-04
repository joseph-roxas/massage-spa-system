import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { useSave, useServices, type Service } from '../../lib/catalogue';
import { duration, longDate, parsePesos, peso, todayManila } from '../../lib/format';

function PriceForm({ service, onDone }: { service: Service; onDone: () => void }) {
  const [price, setPrice] = useState('');
  const [from, setFrom] = useState(todayManila());
  const [error, setError] = useState<string | null>(null);
  const save = useSave((body: { regularPrice: number; effectiveFrom: string }) => ({ path: `/catalogue/services/${service.id}/prices`, body }), 'catalogue');

  function submit(e: FormEvent) {
    e.preventDefault();
    const regularPrice = parsePesos(price);
    if (regularPrice === null) return setError('Enter a peso amount, e.g. 550 or 550.00.');
    setError(null);
    save.mutate({ regularPrice, effectiveFrom: from }, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      <p className="text-sm text-stone-600">
        New Regular Price for <strong>{service.name}</strong> ({duration(service.durationMin)}). Sales already made keep
        their old price.
      </p>
      {(error || save.error) && <Alert>{error ?? save.error?.message}</Alert>}
      <div className="grid grid-cols-3 items-end gap-3">
        <Field label="New price (₱)">
          <Input inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} placeholder={peso(service.currentPrice)} />
        </Field>
        <Field label="Takes effect on">
          <Input type="date" required min={todayManila()} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>Save price</Button>
          <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        </div>
      </div>
    </FormPanel>
  );
}

type ServiceDraft = {
  code: string;
  name: string;
  durationMin: string;
  kind: 'single' | 'combo';
  isFootType: boolean;
  voucherEligible: boolean;
  voucherPrefix: string;
  active: boolean;
  sortOrder: string;
  price: string;
};

function ServiceForm({ service, onDone }: { service?: Service; onDone: () => void }) {
  const [d, setD] = useState<ServiceDraft>({
    code: service?.code ?? '',
    name: service?.name ?? '',
    durationMin: String(service?.durationMin ?? 60),
    kind: service?.kind ?? 'single',
    isFootType: service?.isFootType ?? false,
    voucherEligible: service?.voucherEligible ?? false,
    voucherPrefix: service?.voucherPrefix ?? '',
    active: service?.active ?? true,
    sortOrder: String(service?.sortOrder ?? 1000),
    price: '',
  });
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (body: Record<string, unknown>) =>
      service ? { path: `/catalogue/services/${service.id}`, method: 'PATCH', body } : { path: '/catalogue/services', body },
    'catalogue',
  );
  const set = <K extends keyof ServiceDraft>(k: K, v: ServiceDraft[K]) => setD((x) => ({ ...x, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const base = {
      code: d.code,
      name: d.name,
      durationMin: Number(d.durationMin),
      isFootType: d.isFootType,
      voucherEligible: d.voucherEligible,
      voucherPrefix: d.voucherEligible ? d.voucherPrefix : (service?.voucherPrefix ?? null),
      active: d.active,
      sortOrder: Number(d.sortOrder),
    };
    if (service) return save.mutate(base, { onSuccess: onDone });
    const regularPrice = parsePesos(d.price);
    if (regularPrice === null) return setError('Enter the starting price in pesos.');
    setError(null);
    save.mutate({ ...base, kind: d.kind, regularPrice, effectiveFrom: todayManila() }, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {(error || save.error) && <Alert>{error ?? save.error?.message}</Alert>}
      <div className="grid grid-cols-6 gap-3">
        <Field label="Code">
          <Input required maxLength={12} value={d.code} onChange={(e) => set('code', e.target.value)} />
        </Field>
        <div className="col-span-3">
          <Field label="Name">
            <Input required value={d.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
        </div>
        <Field label="Minutes">
          <Input type="number" min={5} step={5} required value={d.durationMin} onChange={(e) => set('durationMin', e.target.value)} />
        </Field>
        <Field label="Order" hint="Lower shows first">
          <Input type="number" value={d.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
        </Field>
      </div>
      {!service && (
        <div className="grid grid-cols-6 gap-3">
          <Field label="Type">
            <Select value={d.kind} onChange={(e) => set('kind', e.target.value as ServiceDraft['kind'])}>
              <option value="single">Service</option>
              <option value="combo">Combo</option>
            </Select>
          </Field>
          <Field label="Price (₱)">
            <Input inputMode="decimal" required value={d.price} onChange={(e) => set('price', e.target.value)} />
          </Field>
        </div>
      )}
      <div className="flex gap-6">
        <Checkbox label="Allowed on the foot recliner" checked={d.isFootType} onChange={(e) => set('isFootType', e.target.checked)} />
        <Checkbox label="Sold as a voucher" checked={d.voucherEligible} onChange={(e) => set('voucherEligible', e.target.checked)} />
        <Checkbox label="Offered" checked={d.active} onChange={(e) => set('active', e.target.checked)} />
      </div>
      {d.voucherEligible && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Voucher code" hint="Printed before each card number: NTL-SM gives NTL-SM-0271">
            <Input maxLength={20} value={d.voucherPrefix} onChange={(e) => set('voucherPrefix', e.target.value.toUpperCase())} placeholder="E.g. NTL-SM" />
          </Field>
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>{service ? 'Save changes' : 'Add service'}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

function ServiceRow({ service }: { service: Service }) {
  const [mode, setMode] = useState<'view' | 'price' | 'edit'>('view');
  const removePrice = useSave((priceId: string) => ({ path: `/catalogue/services/${service.id}/prices/${priceId}`, method: 'DELETE' }), 'catalogue');
  return (
    <>
      <tr className={service.active ? '' : 'opacity-50'}>
        <td className={`${td} font-mono text-stone-500`}>{service.code}</td>
        <td className={td}>
          {service.name}
          <div className="mt-1 flex gap-1">
            {service.kind === 'combo' && <Badge>Combo</Badge>}
            {service.voucherEligible && <Badge tone="teal">Voucher{service.voucherPrefix ? ` ${service.voucherPrefix}` : ''}</Badge>}
            {service.isFootType && <Badge>Recliner OK</Badge>}
            {!service.active && <Badge tone="red">Not offered</Badge>}
          </div>
        </td>
        <td className={td}>{duration(service.durationMin)}</td>
        <td className={`${td} text-right font-semibold tabular-nums`}>{peso(service.currentPrice)}</td>
        <td className={`${td} text-xs`}>
          {service.upcomingPrices.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-amber-700">
              {peso(p.regularPrice)} from {longDate(p.effectiveFrom)}
              <button type="button" className="text-stone-500 underline" onClick={() => removePrice.mutate(p.id)}>
                remove
              </button>
            </div>
          ))}
        </td>
        <td className={`${td} whitespace-nowrap text-right`}>
          <Button variant="secondary" className="h-8 px-3" onClick={() => setMode('price')}>Change price</Button>{' '}
          <Button variant="secondary" className="h-8 px-3" onClick={() => setMode('edit')}>Edit</Button>
        </td>
      </tr>
      {mode !== 'view' && (
        <tr>
          <td colSpan={6} className="px-3 pb-3">
            {mode === 'price' ? (
              <PriceForm service={service} onDone={() => setMode('view')} />
            ) : (
              <ServiceForm service={service} onDone={() => setMode('view')} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function ServicesSettings() {
  const { data, error } = useServices();
  const [adding, setAdding] = useState(false);
  return (
    <Card title="Services & Regular Prices" actions={!adding && <Button onClick={() => setAdding(true)}>Add service</Button>}>
      {error && <Alert>{error.message}</Alert>}
      {adding && (
        <div className="mb-4">
          <ServiceForm onDone={() => setAdding(false)} />
        </div>
      )}
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Code</th>
            <th className={th}>Service</th>
            <th className={th}>Duration</th>
            <th className={`${th} text-right`}>Price today</th>
            <th className={th}>Upcoming</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {data?.services.map((s) => <ServiceRow key={s.id} service={s} />)}
        </tbody>
      </table>
    </Card>
  );
}
