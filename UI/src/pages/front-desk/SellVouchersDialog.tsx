import { useState, type FormEvent } from 'react';
import { BUNDLE_SIZE } from '@spa/domain';
import { Alert, Badge, Button, Field, Input, Select } from '../../components/ui';
import { GuestPicker, guestBody, NO_GUEST, type GuestChoice } from '../../components/GuestPicker';
import { Modal } from '../../components/Modal';
import { useServices } from '../../lib/catalogue';
import { duration, peso } from '../../lib/format';
import { useDayAction } from '../../lib/sales';
import { useVouchers } from '../../lib/vouchers';
import { usePayment } from './PaymentFields';

type Sold = { total: number; serviceName: string; buyerName: string; serials: string[] };

export function SellVouchersDialog({ onClose }: { onClose: () => void }) {
  const services = useServices();
  const save = useDayAction();
  const eligible = (services.data?.services ?? []).filter((s) => s.active && s.voucherEligible && s.currentPrice !== null);
  const [serviceId, setServiceId] = useState('');
  const [qty, setQty] = useState(BUNDLE_SIZE);
  // One picked card per slot: the paid ones, then the free ones.
  const [picked, setPicked] = useState<string[]>([]);
  const [buyer, setBuyer] = useState<GuestChoice>(NO_GUEST);
  const buyerName = buyer.guestName.trim();
  const [sold, setSold] = useState<Sold | null>(null);

  const service = eligible.find((s) => s.id === serviceId) ?? eligible[0];
  const inShop = useVouchers({ serviceId: service?.id, status: 'in_shop' }, !!service);
  const cards = inShop.data?.vouchers.filter((v) => v.serviceId === service?.id).map((v) => v.serial) ?? [];
  const count = Number.isInteger(qty) && qty >= 1 ? qty : 0;
  const total = service ? service.currentPrice! * count : 0;
  const free = Math.floor(count / BUNDLE_SIZE);
  const slots = Array.from({ length: count + free }, (_, i) => picked[i] ?? '');
  const allPicked = slots.length > 0 && slots.every(Boolean);
  const pay = usePayment(total);

  function pickService(id: string) {
    setServiceId(id);
    setPicked([]);
  }

  function pick(slot: number, serial: string) {
    setPicked(() => slots.map((s, i) => (i === slot ? serial : s)));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!service) return;
    save.mutate(
      { path: '/voucher-sales', body: { serviceId: service.id, qty: count, serials: slots, ...guestBody(buyer), buyerName, buyerPhone: buyer.guestPhone, payments: pay.payments } },
      { onSuccess: (res) => setSold({ total: res.total!, serviceName: service.name, buyerName, serials: res.serials! }) },
    );
  }

  if (sold) {
    return (
      <Modal title="Vouchers sold" onClose={onClose}>
        <div className="space-y-4">
          <p className="text-sm text-stone-600">
            {sold.serials.length} × {sold.serviceName} to {sold.buyerName} · paid {peso(sold.total)}. Hand over these cards:
          </p>
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 font-mono text-lg">
            {sold.serials.map((s) => (
              <li key={s} className="px-4 py-2">
                {s}
              </li>
            ))}
          </ul>
          <p className="text-xs text-stone-500">Whichever cards of this purchase are used last are the free ones.</p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Sell vouchers" onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        {save.error && <Alert>{save.error.message}</Alert>}
        {services.isSuccess && eligible.length === 0 && <Alert tone="info">No service is sold as a voucher. The Super Admin can turn this on under Settings.</Alert>}
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label="Service">
            <Select value={service?.id ?? ''} onChange={(e) => pickService(e.target.value)}>
              {eligible.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({duration(s.durationMin)}) · {peso(s.currentPrice)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How many paid">
            <Input type="number" min={1} max={50} required value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </Field>
        </div>

        {service && inShop.isSuccess && cards.length < slots.length && (
          <Alert>
            Only {cards.length} unsold {service.name} card{cards.length === 1 ? '' : 's'} at the shop. Ask the Super Admin to endorse more.
          </Alert>
        )}
        {slots.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-stone-700">Pick each card you hand over</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {slots.map((serial, i) => (
                <label key={i} className="block text-xs text-stone-500">
                  {i < count ? `Card ${i + 1}` : `Card ${i + 1} (free)`}
                  <Select required value={serial} onChange={(e) => pick(i, e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5 font-mono text-sm">
                    <option value="">Choose…</option>
                    {cards
                      .filter((c) => c === serial || !slots.includes(c))
                      .map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                  </Select>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <GuestPicker value={buyer} onChange={setBuyer} nameLabel="Buyer name" required />

        <div className="space-y-1 rounded-lg bg-stone-50 p-4 text-sm">
          <div className="flex justify-between">
            <span>
              {count} × {peso(service?.currentPrice ?? 0)}
            </span>
            <span className="tabular-nums">{peso(total)}</span>
          </div>
          <div className="flex justify-between text-stone-600">
            <span>{free ? <Badge tone="teal">Plus {free} free (5+1)</Badge> : `Buy ${BUNDLE_SIZE} to get 1 free`}</span>
            <span>
              {count + free} card{count + free === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex justify-between border-t border-stone-200 pt-2 text-base font-semibold">
            <span>To pay</span>
            <span className="tabular-nums">{peso(total)}</span>
          </div>
        </div>

        {pay.fields}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!service || !count || !allPicked || !buyerName.trim() || pay.invalid || save.isPending}>
            Paid {peso(total)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
