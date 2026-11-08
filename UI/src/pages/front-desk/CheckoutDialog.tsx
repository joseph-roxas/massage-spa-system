import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { GuestPicker, guestBody, type GuestChoice } from '../../components/GuestPicker';
import { Modal } from '../../components/Modal';
import { useCan } from '../../lib/auth';
import { useServices } from '../../lib/catalogue';
import { longDate, peso, percent } from '../../lib/format';
import { guestLabel, type Booking } from '../../lib/front-desk';
import { STATUTORY_LABEL, useGuest, useGuestAction, visitsLabel } from '../../lib/guests';
import { useDayAction, useQuotes, useStay, type PriceChoice, type Quote, type StayBooking } from '../../lib/sales';
import { useVouchers, type VoucherBundle } from '../../lib/vouchers';
import { toManila } from '@spa/domain';
import { usePayment } from './PaymentFields';
import { ChangeServiceDialog, ServiceTopUpDialog } from './ServiceChangeDialogs';

/** A Discount dropdown value: `promo:<id>` for a Promo. */
type DiscountPick = 'none' | `promo:${string}` | 'senior' | 'pwd' | 'voucher' | 'complimentary';

/** What the Receptionist chose for one Service of the stay. */
type Line = { picked: DiscountPick | null; reason: string; serial: string };
const NEW_LINE: Line = { picked: null, reason: '', serial: '' };

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

const statutoryOf = (pick: DiscountPick | null) => (pick === 'senior' || pick === 'pwd' ? pick : null);
const promoIdOf = (pick: DiscountPick | null) => (pick === null ? undefined : pick.startsWith('promo:') ? pick.slice('promo:'.length) : null);
// Look the serial up only once it could be one.
const serialOf = (pick: DiscountPick | null, line: Line) => (pick === 'voucher' && line.serial.trim().length >= 3 ? line.serial.trim() : null);

/** The Discount and Voucher of one Service, priced by its quote. */
function LineEditor({
  stay,
  line,
  set,
  chosen,
  quote,
  priced,
  showTitle,
  onChange,
}: {
  stay: StayBooking;
  line: Line;
  set: (l: Line) => void;
  chosen: DiscountPick | null;
  quote: { data?: Quote; error: Error | null };
  /** The quote, unless a Voucher is chosen but not found yet. */
  priced: Quote | undefined;
  showTitle: boolean;
  onChange: (what: 'top-up' | 'service') => void;
}) {
  const canComp = useCan('sales.complimentary');
  const isCombo = useServices().data?.services.find((s) => s.id === stay.serviceId)?.kind === 'combo';
  const unused = useVouchers({ serviceId: stay.serviceId, status: 'unused' }, chosen === 'voucher');
  const autoPromo = chosen === null ? quote.data?.discount.promoId : null;
  const pick: DiscountPick = chosen ?? (autoPromo ? `promo:${autoPromo}` : 'none');
  const promoOptions = quote.data?.promos ?? [];
  const listId = `unused-vouchers-${stay.id}`;

  return (
    <div className="space-y-3">
      {showTitle && (
        <p className="text-sm font-semibold">
          {stay.serviceName} <span className="font-normal text-stone-500">with {stay.therapistName}</span>
        </p>
      )}
      {quote.error && <Alert>{quote.error.message}</Alert>}
      <div className="flex gap-4 text-sm">
        {!isCombo && (
          <button type="button" className="text-teal-800 underline" onClick={() => onChange('top-up')}>
            Add time
          </button>
        )}
        <button type="button" className="text-teal-800 underline" onClick={() => onChange('service')}>
          Change service
        </button>
      </div>
      <Field label="Discount" hint="One discount per service. Greyed-out Promos don't apply to this service.">
        <Select value={pick} onChange={(e) => set({ ...line, picked: e.target.value as DiscountPick })}>
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
      {chosen === 'voucher' && (
        <Field label="Voucher serial number" hint="Only for this exact service; no upgrades. Dashes and case don't matter.">
          <Input required autoFocus list={listId} value={line.serial} onChange={(e) => set({ ...line, serial: e.target.value })} placeholder="E.g. NTL-SM-0271" />
          <datalist id={listId}>
            {(unused.data?.vouchers ?? [])
              .filter((v) => v.serviceId === stay.serviceId)
              .map((v) => (
                <option key={v.id} value={v.serial}>
                  {v.buyerName ?? ''}
                </option>
              ))}
          </datalist>
        </Field>
      )}
      {chosen === 'voucher' && priced?.voucherBundle && <BundlePanel bundle={priced.voucherBundle} />}
      {chosen === 'complimentary' && (
        <Field label="Why is this complimentary?" hint="Counted as a Real FOC; the therapist still earns Commission">
          <Input required minLength={3} autoFocus value={line.reason} onChange={(e) => set({ ...line, reason: e.target.value })} />
        </Field>
      )}
      {priced && (
        <div className="space-y-1 rounded-lg bg-stone-50 p-4">
          <Row label="Regular Price" value={peso(priced.regularPrice)} />
          {priced.topUpsTotal > 0 && <Row label="Added time" value={peso(priced.topUpsTotal)} />}
          {priced.discount.type !== 'none' && (
            <Row
              label={`${priced.discount.label}${priced.discount.type === 'complimentary' || priced.discount.type === 'voucher' ? '' : ` (${percent(priced.discount.bp)})`}`}
              value={`−${peso(priced.discount.amount)}`}
            />
          )}
          <Row label={showTitle ? 'This service' : 'To pay'} value={peso(priced.amountDue)} strong />
        </div>
      )}
    </div>
  );
}

/** What checkout needs of a booking; the Day Close dialog passes one from an earlier day. */
export type CheckoutBooking = Pick<Booking, 'id' | 'guestName' | 'serviceId' | 'serviceName' | 'therapistName'> & { guestId?: string | null };

/**
 * Checks out a Guest's whole stay with one payment: the Booking and any Added
 * Services, each with its own Discount. A saved SC/PWD ID is filled in.
 */
export function CheckoutDialog({ booking, onClose }: { booking: CheckoutBooking; onClose: () => void }) {
  const save = useDayAction();
  const stay = useStay(booking.id);
  const owing = (stay.data?.bookings ?? []).filter((b) => !b.paid);
  const unfinished = owing.filter((b) => b.status !== 'done');
  const [lines, setLines] = useState<Record<string, Line>>({});
  const lineOf = (id: string) => lines[id] ?? NEW_LINE;
  // Null until typed: the Guest Record's saved ID fills it in. One ID serves every Service.
  const [typedId, setIdNumber] = useState<string | null>(null);
  const [saveId, setSaveId] = useState(true);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [linking, setLinking] = useState(false);
  const [changing, setChanging] = useState<{ id: string; what: 'top-up' | 'service' } | null>(null);
  const [link, setLink] = useState<GuestChoice>({ guestId: null, guestName: booking.guestName ?? '', guestPhone: '', saveGuest: false });
  const guestAction = useGuestAction();
  const saved = useGuest(booking.guestId).data?.guest;

  // A Guest with a saved SC/PWD ID gets that Discount unless the Receptionist picks another.
  const chosenOf = (id: string): DiscountPick | null => lineOf(id).picked ?? saved?.statutoryType ?? null;
  const choices: PriceChoice[] = owing.map((b) => {
    const chosen = chosenOf(b.id);
    return {
      bookingId: b.id,
      statutory: statutoryOf(chosen),
      promoId: promoIdOf(chosen),
      complimentary: chosen === 'complimentary',
      voucherSerial: serialOf(chosen, lineOf(b.id)),
    };
  });
  const quotes = useQuotes(unfinished.length ? [] : choices);
  // Until a voucher is found, a quote without one must not stand in for it.
  const priced = owing.map((b, i) => {
    const q = quotes[i];
    return chosenOf(b.id) === 'voucher' && (!choices[i]!.voucherSerial || q?.isError || q?.data?.discount.type !== 'voucher') ? undefined : q?.data;
  });
  const due = priced.reduce((s, q) => s + (q?.amountDue ?? 0), 0);
  const ready = owing.length > 0 && unfinished.length === 0 && priced.every(Boolean) && !quotes.some((q) => q.isFetching);
  const pay = usePayment(due);

  const statutory = owing.map((b) => statutoryOf(chosenOf(b.id))).find(Boolean) ?? null;
  const savedId = saved && saved.statutoryType === statutory ? saved.statutoryIdNo : null;
  const idNumber = typedId ?? savedId ?? '';
  // Offer to keep a new or changed ID on the Guest Record being checked out.
  const willHaveGuest = !!booking.guestId || (linking && (!!link.guestId || (link.saveGuest && !!link.guestName.trim())));
  const canSaveId = !!statutory && willHaveGuest && idNumber.trim().length >= 3 && idNumber.trim() !== savedId;

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
        path: '/sales/stay',
        body: {
          items: owing.map((b, i) => {
            const chosen = chosenOf(b.id);
            const kind = statutoryOf(chosen);
            const promoId = promoIdOf(chosen);
            return {
              bookingId: b.id,
              statutory: kind ? { kind, idNumber } : null,
              promoId: promoId === undefined ? (quotes[i]?.data?.discount.promoId ?? null) : promoId,
              complimentaryReason: chosen === 'complimentary' ? lineOf(b.id).reason : null,
              voucherSerial: choices[i]!.voucherSerial,
            };
          }),
          payments: pay.payments,
          bookletInvoiceNo: invoiceNo || null,
        },
      },
      { onSuccess: () => void afterSale() },
    );
  }

  const changingLine = owing.find((b) => b.id === changing?.id);
  const several = owing.length > 1;

  return (
    <>
      <Modal title={`Checkout · ${guestLabel(booking)}`} onClose={onClose}>
        <form onSubmit={submit} className="space-y-5">
          <p className="text-sm text-stone-600">
            {several ? `${owing.length} services` : `${booking.serviceName} with ${booking.therapistName}`}
            {saved && (
              <>
                {' · '}
                {saved.isRegular && <Badge tone="teal">Regular</Badge>} {visitsLabel(saved)}
                {saved.statutoryType && ` · ${STATUTORY_LABEL[saved.statutoryType]} ID on file`}
              </>
            )}
          </p>
          {(save.error || stay.error) && <Alert>{(save.error ?? stay.error)?.message}</Alert>}
          {unfinished.length > 0 && (
            <Alert tone="info">
              {unfinished.map((b) => b.serviceName).join(', ')} {unfinished.length === 1 ? 'is' : 'are'} still going. The whole stay is checked out together once it ends.
            </Alert>
          )}
          {!booking.guestId &&
            (linking ? (
              <GuestPicker value={link} onChange={setLink} />
            ) : (
              <button type="button" className="text-sm text-teal-800 underline" onClick={() => setLinking(true)}>
                Link a Guest Record (to count the visit or keep an SC/PWD ID)
              </button>
            ))}

          {unfinished.length === 0 &&
            owing.map((b, i) => (
              <LineEditor
                key={b.id}
                stay={b}
                line={lineOf(b.id)}
                set={(l) => setLines((all) => ({ ...all, [b.id]: l }))}
                chosen={chosenOf(b.id)}
                quote={{ data: quotes[i]?.data, error: quotes[i]?.error ?? null }}
                priced={priced[i]}
                showTitle={several}
                onChange={(what) => setChanging({ id: b.id, what })}
              />
            ))}

          {statutory && unfinished.length === 0 && (
            <Field label={`${STATUTORY_LABEL[statutory]} ID number`} hint={several ? 'Used for every service with this discount' : undefined}>
              <Input required minLength={3} value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
            </Field>
          )}
          {canSaveId && unfinished.length === 0 && (
            <Checkbox
              label={savedId === null && !saved?.statutoryIdNo ? 'Save this ID to the Guest Record' : 'Replace the ID saved on the Guest Record'}
              checked={saveId}
              onChange={(e) => setSaveId(e.target.checked)}
            />
          )}

          {several && ready && (
            <div className="rounded-lg bg-teal-50 p-4">
              <Row label="To pay for the stay" value={peso(due)} strong />
            </div>
          )}

          {ready && pay.fields}

          <Field label="Booklet invoice no. (optional)">
            <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </Field>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Not yet</Button>
            <Button type="submit" disabled={!ready || save.isPending || guestAction.isPending || pay.invalid}>
              {due === 0 ? 'Record' : `Paid ${peso(due)}`}
            </Button>
          </div>
        </form>
      </Modal>
      {changingLine && changing?.what === 'top-up' && <ServiceTopUpDialog booking={changingLine} onClose={() => setChanging(null)} />}
      {changingLine && changing?.what === 'service' && <ChangeServiceDialog booking={changingLine} onClose={() => setChanging(null)} />}
    </>
  );
}
