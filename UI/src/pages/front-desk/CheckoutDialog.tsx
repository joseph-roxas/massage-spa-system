import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field, Input } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useCan } from '../../lib/auth';
import { useAddons } from '../../lib/catalogue';
import { parsePesos, peso, percent } from '../../lib/format';
import { guestLabel, type Booking } from '../../lib/front-desk';
import { useDayAction, useQuote, type PaymentLine } from '../../lib/sales';

type DiscountPick = 'auto' | 'senior' | 'pwd' | 'complimentary';
type PayMode = 'cash' | 'gcash' | 'split';

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
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [mode, setMode] = useState<PayMode>('cash');
  const [tendered, setTendered] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [gcashRef, setGcashRef] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');

  const statutory = pick === 'senior' || pick === 'pwd' ? pick : null;
  const quote = useQuote({ bookingId: booking.id, statutory, addonIds, complimentary: pick === 'complimentary' });
  const q = quote.data;
  const due = q?.amountDue ?? 0;

  const cashPart = mode === 'cash' ? due : mode === 'split' ? (parsePesos(splitCash) ?? 0) : 0;
  const gcashPart = due - cashPart;
  const tenderedAmount = parsePesos(tendered);
  const change = mode === 'cash' && tenderedAmount !== null ? tenderedAmount - due : null;

  const payments: PaymentLine[] =
    due === 0
      ? []
      : [
          ...(cashPart > 0 ? [{ method: 'cash' as const, amount: cashPart }] : []),
          ...(gcashPart > 0 ? [{ method: 'gcash' as const, amount: gcashPart, gcashRef }] : []),
        ];
  const splitInvalid = mode === 'split' && (cashPart <= 0 || cashPart >= due);

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
          payments,
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
            {canComp && choice('complimentary', 'Complimentary')}
          </div>
          <p className="text-xs text-stone-500">The guest gets one discount only: whichever is larger.</p>
        </fieldset>
        {statutory && (
          <Field label={`${statutory === 'senior' ? 'Senior Citizen' : 'PWD'} ID number`}>
            <Input required minLength={3} autoFocus value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
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
              <Row label={`${q.discount.label}${q.discount.type === 'complimentary' ? '' : ` (${percent(q.discount.bp)})`}`} value={`−${peso(q.discount.amount)}`} />
            )}
            {q.addons.map((a) => (
              <Row key={a.id} label={a.name} value={peso(a.price)} />
            ))}
            <Row label="To pay" value={peso(q.amountDue)} strong />
          </div>
        )}

        {due > 0 && (
          <fieldset className="space-y-3 text-sm">
            <legend className="mb-1 font-medium text-stone-700">Payment</legend>
            <div className="flex gap-6">
              {(['cash', 'gcash', 'split'] as const).map((m) => (
                <label key={m} className="flex items-center gap-2">
                  <input type="radio" name="pay" checked={mode === m} onChange={() => setMode(m)} />
                  {m === 'cash' ? 'Cash' : m === 'gcash' ? 'GCash' : 'Cash + GCash'}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {mode === 'cash' && (
                <Field label="Cash received (optional)" hint={change !== null ? (change >= 0 ? `Change: ${peso(change)}` : 'Not enough') : 'To work out change'}>
                  <Input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                </Field>
              )}
              {mode === 'split' && (
                <Field label="Cash part" hint={splitInvalid ? 'Less than the total' : `GCash part: ${peso(gcashPart)}`}>
                  <Input inputMode="decimal" required value={splitCash} onChange={(e) => setSplitCash(e.target.value)} />
                </Field>
              )}
              {mode !== 'cash' && (
                <Field label="GCash reference number">
                  <Input required value={gcashRef} onChange={(e) => setGcashRef(e.target.value)} />
                </Field>
              )}
            </div>
          </fieldset>
        )}

        <Field label="Booklet invoice no. (optional)">
          <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Not yet</Button>
          <Button type="submit" disabled={!q || save.isPending || splitInvalid || quote.isFetching}>
            {due === 0 ? 'Record' : `Paid ${peso(due)}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
