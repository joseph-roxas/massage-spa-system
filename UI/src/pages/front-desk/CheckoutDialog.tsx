import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { GuestPicker, guestBody, type GuestChoice } from '../../components/GuestPicker';
import { Modal } from '../../components/Modal';
import { useCan } from '../../lib/auth';
import { useAddons } from '../../lib/catalogue';
import { longDate, peso, percent } from '../../lib/format';
import { guestLabel, type Booking } from '../../lib/front-desk';
import { STATUTORY_LABEL, useGuest, useGuestAction, visitsLabel } from '../../lib/guests';
import { useDayAction, useQuote } from '../../lib/sales';
import { useVouchers, type VoucherBundle } from '../../lib/vouchers';
import { toManila } from '@spa/domain';
import { usePayment } from './PaymentFields';

/** A Discount dropdown value: `promo:<id>` for a Promo. */
type DiscountPick = 'none' | `promo:${string}` | 'senior' | 'pwd' | 'voucher' | 'complimentary';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-stone-200 pt-2 text-base font-semibold' : 'text-sm'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** Who bought the Voucher's Bundle, when, and how many are used, so the desk can double-check. */
function BundlePanel({ bundle }: { bundle: VoucherBundle }) {
  const used = bundle.vouchers.filter((v) => v.redeemedAt);
  return (
    <div className="space-y-2 rounded-lg border border-stone-200 p-3 text-sm">
      <p>
        Bought by <span className="font-medium">{bundle.buyerName ?? 'unknown'}</span>
        {bundle.buyerPhone && ` (${bundle.buyerPhone})`}
        {bundle.soldOn ? ` on ${longDate(bundle.soldOn)}` : ' before the system'}
        {bundle.qtyPaid !== null && ` · ${used.length} of ${bundle.vouchers.length} used`}
      </p>
      {used.length > 0 && (
        <ul className="space-y-0.5 text-xs text-stone-600">
          {used.map((v) => (
            <li key={v.serial} className="font-mono">
              {v.serial} · used {longDate(toManila(new Date(v.redeemedAt!)).date)}
              {v.free && ' · Free'}
            </li>
          ))}
        </ul>
      )}
      {bundle.thisIsFree && <Badge tone="teal">This one is free (Real FOC)</Badge>}
    </div>
  );
}

/** What checkout needs of a booking; the Day Close dialog passes one from an earlier day. */
export type CheckoutBooking = Pick<Booking, 'id' | 'guestName' | 'serviceId' | 'serviceName' | 'therapistName'> & { guestId?: string | null };

export function CheckoutDialog({ booking, onClose }: { booking: CheckoutBooking; onClose: () => void }) {
  const canComp = useCan('sales.complimentary');
  const addons = useAddons();
  const save = useDayAction();
  // Null until the Receptionist chooses: the server then applies the best Promo, and the dropdown shows it.
  const [picked, setChosen] = useState<DiscountPick | null>(null);
  // Null until typed: the Guest Record's saved ID fills it in.
  const [typedId, setIdNumber] = useState<string | null>(null);
  const [saveId, setSaveId] = useState(true);
  const [linking, setLinking] = useState(false);
  const [link, setLink] = useState<GuestChoice>({ guestId: null, guestName: booking.guestName ?? '', guestPhone: '', saveGuest: false });
  const guestAction = useGuestAction();
  const saved = useGuest(booking.guestId).data?.guest;
  // A Guest with a saved SC/PWD ID gets that Discount unless the Receptionist picks another.
  const chosen: DiscountPick | null = picked ?? saved?.statutoryType ?? null;
  const [reason, setReason] = useState('');
  const [serial, setSerial] = useState('');
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [invoiceNo, setInvoiceNo] = useState('');

  const statutory = chosen === 'senior' || chosen === 'pwd' ? chosen : null;
  const savedId = saved && saved.statutoryType === statutory ? saved.statutoryIdNo : null;
  const idNumber = typedId ?? savedId ?? '';
  // Offer to keep a new or changed ID on the Guest Record being checked out.
  const willHaveGuest = !!booking.guestId || (linking && (!!link.guestId || (link.saveGuest && !!link.guestName.trim())));
  const canSaveId = !!statutory && willHaveGuest && idNumber.trim().length >= 3 && idNumber.trim() !== savedId;
  const promoId = chosen === null ? undefined : chosen.startsWith('promo:') ? chosen.slice('promo:'.length) : null;
  // Look the serial up only once it could be one.
  const voucherSerial = chosen === 'voucher' && serial.trim().length >= 3 ? serial.trim() : null;
  const quote = useQuote({ bookingId: booking.id, statutory, promoId, addonIds, complimentary: chosen === 'complimentary', voucherSerial });
  const autoPromo = chosen === null ? quote.data?.discount.promoId : null;
  const pick: DiscountPick = chosen ?? (autoPromo ? `promo:${autoPromo}` : 'none');
  // Until a voucher is found, a quote without one must not stand in for it. (Submit also waits while re-pricing.)
  const q = chosen === 'voucher' && (!voucherSerial || quote.isError || quote.data?.discount.type !== 'voucher') ? undefined : quote.data;
  const due = q?.amountDue ?? 0;
  const unused = useVouchers({ serviceId: booking.serviceId, status: 'unused' }, chosen === 'voucher');
  const pay = usePayment(due);

  /** After the sale: link the Guest Record and keep the ID on it, if asked. */
  async function afterSale() {
    let guestId = booking.guestId ?? null;
    if (!guestId && linking && (link.guestId || link.saveGuest)) {
      guestId = (await guestAction.mutateAsync({ path: `/bookings/${booking.id}/guest`, method: 'PUT', body: guestBody(link) }).catch(() => null))?.guestId ?? null;
    }
    if (guestId && canSaveId && saveId) {
      await guestAction.mutateAsync({ path: `/guests/${guestId}`, method: 'PATCH', body: { statutoryType: statutory, statutoryIdNo: idNumber.trim() } }).catch(() => null);
    }
    onClose();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      {
        path: '/sales',
        body: {
          bookingId: booking.id,
          statutory: statutory ? { kind: statutory, idNumber } : null,
          promoId: promoId === undefined ? autoPromo ?? null : promoId,
          addonIds,
          complimentaryReason: chosen === 'complimentary' ? reason : null,
          voucherSerial,
          payments: pay.payments,
          bookletInvoiceNo: invoiceNo || null,
        },
      },
      { onSuccess: () => void afterSale() },
    );
  }

  const promoOptions = quote.data?.promos ?? [];

  return (
    <Modal title={`Checkout · ${guestLabel(booking)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <p className="text-sm text-stone-600">
          {booking.serviceName} with {booking.therapistName}
          {saved && (
            <>
              {' · '}
              {saved.isRegular && <Badge tone="teal">Regular</Badge>} {visitsLabel(saved)}
              {saved.statutoryType && ` · ${STATUTORY_LABEL[saved.statutoryType]} ID on file`}
            </>
          )}
        </p>
        {!booking.guestId &&
          (linking ? (
            <GuestPicker value={link} onChange={setLink} />
          ) : (
            <button type="button" className="text-sm text-teal-800 underline" onClick={() => setLinking(true)}>
              Link a Guest Record (to count the visit or keep an SC/PWD ID)
            </button>
          ))}
        {(save.error || quote.error) && <Alert>{(save.error ?? quote.error)?.message}</Alert>}

        <Field label="Discount" hint="One discount per service. Greyed-out Promos don't apply to this service.">
          <Select value={pick} onChange={(e) => setChosen(e.target.value as DiscountPick)}>
            <option value="none">No discount</option>
            {promoOptions.length > 0 && (
              <optgroup label="Promos">
                {promoOptions.map((p) => (
                  <option key={p.id} value={`promo:${p.id}`} disabled={!!p.problem}>
                    {p.name} ({percent(p.percentBp)}){p.problem ? ` · ${p.problem}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="senior">Senior Citizen (20%)</option>
            <option value="pwd">PWD (20%)</option>
            <option value="voucher">Voucher</option>
            {canComp && <option value="complimentary">Complimentary (Real FOC)</option>}
          </Select>
        </Field>
        {statutory && (
          <Field label={`${statutory === 'senior' ? 'Senior Citizen' : 'PWD'} ID number`}>
            <Input required minLength={3} autoFocus value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
          </Field>
        )}
        {canSaveId && <Checkbox label={savedId === null && !saved?.statutoryIdNo ? 'Save this ID to the Guest Record' : 'Replace the ID saved on the Guest Record'} checked={saveId} onChange={(e) => setSaveId(e.target.checked)} />}
        {chosen === 'voucher' && (
          <Field label="Voucher serial number" hint="Only for this exact service; no upgrades. Dashes and case don't matter.">
            <Input required autoFocus list="unused-vouchers" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="E.g. NTL-SM-0271" />
            <datalist id="unused-vouchers">
              {(unused.data?.vouchers ?? [])
                .filter((v) => v.serviceId === booking.serviceId)
                .map((v) => (
                  <option key={v.id} value={v.serial}>
                    {v.buyerName ?? ''}
                  </option>
                ))}
            </datalist>
          </Field>
        )}
        {chosen === 'voucher' && q?.voucherBundle && <BundlePanel bundle={q.voucherBundle} />}
        {chosen === 'complimentary' && (
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
          <Button type="submit" disabled={!q || save.isPending || guestAction.isPending || pay.invalid || quote.isFetching}>
            {due === 0 ? 'Record' : `Paid ${peso(due)}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
