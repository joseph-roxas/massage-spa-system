import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field, Input } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useCan } from '../../lib/auth';
import { useAddons } from '../../lib/catalogue';
import { peso, percent } from '../../lib/format';
import { guestLabel, type Booking } from '../../lib/front-desk';
import { useDayAction, useQuote } from '../../lib/sales';
import { usePayment } from './PaymentFields';

type DiscountPick = 'auto' | 'senior' | 'pwd' | 'voucher' | 'complimentary';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-stone-200 pt-2 text-base font-semibold' : 'text-sm'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function CheckoutDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const canComp = useCan('sales.complimentary');
  const addons = useAddons();
  const save = useDayAction();
  const [pick, setPick] = useState<DiscountPick>('auto');
  const [idNumber, setIdNumber] = useState('');
  const [reason, setReason] = useState('');
  const [serial, setSerial] = useState('');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [invoiceNo, setInvoiceNo] = useState('');

  const statutory = pick === 'senior' || pick === 'pwd' ? pick : null;
  // Look the serial up only once it could be one.
  const voucherSerial = pick === 'voucher' && serial.trim().length >= 3 ? serial.trim() : null;
  const quote = useQuote({ bookingId: booking.id, statutory, addonIds, complimentary: pick === 'complimentary', voucherSerial });
  // Until a voucher is found, a quote without one must not stand in for it. (Submit also waits while re-pricing.)
  const q = pick === 'voucher' && (!voucherSerial || quote.isError || quote.data?.discount.type !== 'voucher') ? undefined : quote.data;
  const due = q?.amountDue ?? 0;
  const pay = usePayment(due);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      {
        path: '/sales',
        body: {
          bookingId: booking.id,
          statutory: statutory ? { kind: statutory, idNumber } : null,
          addonIds,
          complimentaryReason: pick === 'complimentary' ? reason : null,
          voucherSerial,
          payments: pay.payments,
          bookletInvoiceNo: invoiceNo || null,
        },
      },
      { onSuccess: onClose },
    );
  }

  const choice = (value: DiscountPick, label: string) => (
    <label className="flex items-center gap-2">
      <input type="radio" name="discount" checked={pick === value} onChange={() => setPick(value)} /> {label}
    </label>
  );

  return (
    <Modal title={`Checkout · ${guestLabel(booking)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <p className="text-sm text-stone-600">
          {booking.serviceName} with {booking.therapistName}
        </p>
        {(save.error || quote.error) && <Alert>{(save.error ?? quote.error)?.message}</Alert>}

        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 font-medium text-stone-700">Discount</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {choice('auto', 'Promo if any')}
            {choice('senior', 'Senior Citizen')}
            {choice('pwd', 'PWD')}
            {choice('voucher', 'Voucher')}
            {canComp && choice('complimentary', 'Complimentary')}
          </div>
          <p className="text-xs text-stone-500">The guest gets one discount only: whichever is larger.</p>
        </fieldset>
        {statutory && (
          <Field label={`${statutory === 'senior' ? 'Senior Citizen' : 'PWD'} ID number`}>
            <Input required minLength={3} autoFocus value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
          </Field>
        )}
        {pick === 'voucher' && (
          <Field label="Voucher serial number" hint="Only for this exact service; no upgrades">
            <Input required autoFocus value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="E.g. SWE-7K3M9P" />
          </Field>
        )}
        {pick === 'complimentary' && (
          <Field label="Why is this complimentary?" hint="Counted as a Real FOC; the therapist still earns Commission">
            <Input required minLength={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}

        {(addons.data?.addons.filter((a) => a.active).length ?? 0) > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-stone-700">Add-ons</legend>
            {addons.data!.addons
              .filter((a) => a.active)
              .map((a) => (
                <Checkbox
                  key={a.id}
                  label={`${a.name} (${peso(a.price)})`}
                  checked={addonIds.includes(a.id)}
                  onChange={(e) => setAddonIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                />
              ))}
          </fieldset>
        )}

        {q && (
          <div className="space-y-1 rounded-lg bg-stone-50 p-4">
            <Row label="Regular Price" value={peso(q.regularPrice)} />
            {q.discount.type !== 'none' && (
              <Row
                label={`${q.discount.label}${q.discount.type === 'complimentary' || q.discount.type === 'voucher' ? '' : ` (${percent(q.discount.bp)})`}`}
                value={`−${peso(q.discount.amount)}`}
              />
            )}
            {q.addons.map((a) => (
              <Row key={a.id} label={a.name} value={peso(a.price)} />
            ))}
            <Row label="To pay" value={peso(q.amountDue)} strong />
          </div>
        )}

        {pay.fields}

        <Field label="Booklet invoice no. (optional)">
          <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Not yet</Button>
          <Button type="submit" disabled={!q || save.isPending || pay.invalid || quote.isFetching}>
            {due === 0 ? 'Record' : `Paid ${peso(due)}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
