import { useState, type FormEvent } from 'react';
import { BUNDLE_SIZE } from '@spa/domain';
import { Alert, Badge, Button, Field, Input, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useServices } from '../../lib/catalogue';
import { duration, peso } from '../../lib/format';
import { useDayAction } from '../../lib/sales';
import { usePayment } from './PaymentFields';

type Sold = { total: number; serviceName: string; serials: { serial: string; isFree: boolean }[] };

export function SellVouchersDialog({ onClose }: { onClose: () => void }) {
  const services = useServices();
  const save = useDayAction();
  const eligible = (services.data?.services ?? []).filter((s) => s.active && s.voucherEligible && s.currentPrice !== null);
  const [serviceId, setServiceId] = useState('');
  const [qty, setQty] = useState(BUNDLE_SIZE);
  const [buyerName, setBuyerName] = useState('');
  const [buyerPhone, setBuyerPhone] = useState('');
  const [sold, setSold] = useState<Sold | null>(null);

  const service = eligible.find((s) => s.id === serviceId) ?? eligible[0];
  const count = Number.isInteger(qty) && qty >= 1 ? qty : 0;
  const total = service ? service.currentPrice! * count : 0;
  const free = Math.floor(count / BUNDLE_SIZE);
  const pay = usePayment(total);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!service) return;
    save.mutate(
      { path: '/voucher-sales', body: { serviceId: service.id, qty: count, buyerName, buyerPhone, payments: pay.payments } },
      { onSuccess: (res) => setSold({ total: res.total!, serviceName: service.name, serials: res.serials! }) },
    );
  }

  if (sold) {
    return (
      <Modal title="Vouchers sold" onClose={onClose}>
        <div className="space-y-4 print:space-y-2">
          <p className="text-sm text-stone-600">
            {sold.serials.length} × {sold.serviceName} · paid {peso(sold.total)}. Write each serial on a voucher card.
          </p>
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 font-mono text-lg">
            {sold.serials.map((s) => (
              <li key={s.serial} className="flex items-center justify-between px-4 py-2">
                {s.serial}
                {s.isFree && <Badge tone="teal">Free (5+1)</Badge>}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2 print:hidden">
            <Button variant="secondary" onClick={() => window.print()}>Print</Button>
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
            <Select value={service?.id ?? ''} onChange={(e) => setServiceId(e.target.value)}>
              {eligible.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({duration(s.durationMin)}) · {peso(s.currentPrice)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How many">
            <Input type="number" min={1} max={50} required value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Buyer name (optional)">
            <Input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
          </Field>
          <Field label="Buyer phone (optional)">
            <Input value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-1 rounded-lg bg-stone-50 p-4 text-sm">
          <div className="flex justify-between">
            <span>
              {count} × {peso(service?.currentPrice ?? 0)}
            </span>
            <span className="tabular-nums">{peso(total)}</span>
          </div>
          <div className="flex justify-between text-stone-600">
            <span>{free ? `Plus ${free} free (5+1)` : `Buy ${BUNDLE_SIZE} to get 1 free`}</span>
            <span>
              {count + free} voucher{count + free === 1 ? '' : 's'}
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
          <Button type="submit" disabled={!service || !count || pay.invalid || save.isPending}>
            Paid {peso(total)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
