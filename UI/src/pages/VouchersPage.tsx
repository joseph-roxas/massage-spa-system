import { useState, type FormEvent } from 'react';
import { businessDayOf, toManila } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../components/ui';
import { useCan } from '../lib/auth';
import { useServices } from '../lib/catalogue';
import { longDate, peso, todayManila } from '../lib/format';
import { useDayAction } from '../lib/sales';
import { useEndorsements, useVouchers, useVoucherSales, VOUCHER_STATUS_LABELS, type VoucherStatus } from '../lib/vouchers';
import { SellVouchersDialog } from './front-desk/SellVouchersDialog';

const STATUS_TONE = { in_shop: 'amber', unused: 'teal', redeemed: 'stone', voided: 'red' } as const;

/** "Nov 4, 2026" for a timestamp, in Manila. */
const dayOf = (iso: string) => longDate(toManila(new Date(iso)).date);

function useVoucherServices() {
  const services = useServices();
  return (services.data?.services ?? []).filter((s) => s.voucherEligible);
}

/** Cards the Super Admin endorsed that the shop hasn't confirmed yet. */
function ForReceiving() {
  const canEndorse = useCan('vouchers.endorse');
  const list = useEndorsements();
  const act = useDayAction();
  const pending = (list.data?.endorsements ?? []).filter((e) => !e.receivedAt);
  if (!pending.length) return null;
  return (
    <Card title={`For receiving (${pending.length})`}>
      {act.error && <Alert>{act.error.message}</Alert>}
      <ul className="divide-y divide-stone-100 text-sm">
        {pending.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="flex-1">
              <span className="font-mono">
                {e.firstSerial} to {e.lastSerial}
              </span>{' '}
              · {e.count} {e.serviceName} card{e.count === 1 ? '' : 's'}
              <span className="block text-xs text-stone-500">
                Endorsed {longDate(e.endorsedOn)}
                {e.note && ` · ${e.note}`}
              </span>
            </span>
            {canEndorse && (
              <button
                type="button"
                className="text-xs text-stone-500 underline"
                onClick={() => confirm('Remove this endorsement? The shop has not received it yet.') && act.mutate({ path: `/voucher-endorsements/${e.id}`, method: 'DELETE' })}
              >
                Remove
              </button>
            )}
            <Button
              onClick={() => {
                const note = prompt(`Received all ${e.count} cards? Note any missing or damaged card (leave empty if complete).`);
                if (note !== null) act.mutate({ path: `/voucher-endorsements/${e.id}/receive`, body: { note: note.trim() || undefined } });
              }}
            >
              Received
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The Super Admin hands a printed range of cards to the shop. */
function EndorseForm({ onDone }: { onDone: () => void }) {
  const services = useVoucherServices();
  const save = useDayAction();
  const [serviceId, setServiceId] = useState('');
  const [fromNo, setFromNo] = useState('');
  const [toNo, setToNo] = useState('');
  const [endorsedOn, setEndorsedOn] = useState(todayManila());
  const [note, setNote] = useState('');
  const service = services.find((s) => s.id === serviceId);
  const count = Number(toNo) - Number(fromNo) + 1;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      { path: '/voucher-endorsements', body: { serviceId, fromNo: Number(fromNo), toNo: Number(toNo), endorsedOn, note: note || undefined } },
      { onSuccess: onDone },
    );
  }

  return (
    <FormPanel onSubmit={submit}>
      {save.error && <Alert>{save.error.message}</Alert>}
      <p className="text-sm text-stone-600">Cards you hand to the shop. The receptionist confirms receipt before they can be sold.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-2">
          <Field label="Service">
            <Select required value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">Choose…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.voucherPrefix}>
                  {s.voucherPrefix ?? 'No voucher code'} · {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="First card no.">
          <Input type="number" min={1} max={9999} required value={fromNo} onChange={(e) => setFromNo(e.target.value)} />
        </Field>
        <Field label="Last card no.">
          <Input type="number" min={1} max={9999} required value={toNo} onChange={(e) => setToNo(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Endorsed on">
          <Input type="date" required max={todayManila()} value={endorsedOn} onChange={(e) => setEndorsedOn(e.target.value)} />
        </Field>
        <div className="col-span-1 sm:col-span-3">
          <Field label="Note (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>
      {service?.voucherPrefix && count > 0 && (
        <p className="text-sm text-stone-600">
          {count} card{count === 1 ? '' : 's'}: <span className="font-mono">{service.voucherPrefix}-{fromNo.padStart(4, '0')}</span> to{' '}
          <span className="font-mono">{service.voucherPrefix}-{toNo.padStart(4, '0')}</span>
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={save.isPending || !(count > 0)}>Endorse cards</Button>
      </div>
    </FormPanel>
  );
}

/** Go-live: cards at the shop not sold yet, and paper Vouchers sold before the system and still unused. */
function CountForm({ onDone }: { onDone: () => void }) {
  const services = useVoucherServices();
  const save = useDayAction();
  const [serviceId, setServiceId] = useState('');
  const [state, setState] = useState<'in_shop' | 'unused'>('in_shop');
  const [numbers, setNumbers] = useState('');
  const [isFree, setIsFree] = useState(false);
  const [buyerName, setBuyerName] = useState('');
  const [soldOn, setSoldOn] = useState('');
  const [done, setDone] = useState<number | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    save.mutate(
      {
        path: '/vouchers/import',
        body: { serviceId, numbers, state, ...(state === 'unused' ? { isFree, buyerName: buyerName || undefined, soldOn: soldOn || undefined } : {}) },
      },
      {
        onSuccess: (res) => {
          setDone((res as { imported?: number }).imported ?? 0);
          setNumbers('');
        },
      },
    );
  }

  return (
    <FormPanel onSubmit={submit}>
      {save.error && <Alert>{save.error.message}</Alert>}
      {done !== null && !save.error && <Alert tone="success">{done} card(s) added.</Alert>}
      <p className="text-sm text-stone-600">
        Go-live count, one service at a time. Enter card numbers and ranges, e.g. <span className="font-mono">93-142, 150</span>. Paper vouchers sold before the system are not counted as sales again.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Service">
          <Select required value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Choose…</option>
            {services.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.voucherPrefix}>
                {s.voucherPrefix ?? 'No voucher code'} · {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="These cards are">
          <Select value={state} onChange={(e) => setState(e.target.value as 'in_shop' | 'unused')}>
            <option value="in_shop">At the shop, not sold yet</option>
            <option value="unused">Sold on paper, not used yet</option>
          </Select>
        </Field>
      </div>
      <Field label="Card numbers">
        <Input required value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="E.g. 93-142, 150" className="w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-sm" />
      </Field>
      {state === 'unused' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Buyer (if known)">
            <Input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
          </Field>
          <Field label="Sold on (if known)">
            <Input type="date" value={soldOn} onChange={(e) => setSoldOn(e.target.value)} />
          </Field>
          <div className="pt-6">
            <Checkbox label="Free (5+1) vouchers" checked={isFree} onChange={(e) => setIsFree(e.target.checked)} />
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Close</Button>
        <Button type="submit" disabled={save.isPending}>Add cards</Button>
      </div>
    </FormPanel>
  );
}

/** Unsold cards at the shop, per service. */
function InShop() {
  const services = useVoucherServices();
  const cards = useVouchers({ status: 'in_shop' });
  const rows = cards.data?.vouchers ?? [];
  if (!services.length) return null;
  return (
    <Card title="Unsold cards at the shop">
      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        {services.map((s) => (
          <span key={s.id}>
            <span className="font-mono text-stone-500">{s.voucherPrefix ?? '—'}</span> {s.name}:{' '}
            <span className="font-semibold tabular-nums">{rows.filter((v) => v.serviceId === s.id).length}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function daysAgo(n: number): string {
  const d = new Date(`${todayManila()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Voucher sales for double-checking: date sold, buyer, every serial and when each was used. */
function SalesHistory() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(todayManila());
  const [q, setQ] = useState('');
  const list = useVoucherSales({ from, to, q });
  const cancel = useDayAction();
  const today = businessDayOf(new Date());
  const rows = list.data?.voucherSales ?? [];

  return (
    <Card title="Voucher sales">
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-[10rem_10rem_1fr]">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="col-span-2 sm:col-span-1">
          <Field label="Buyer, phone or serial">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="E.g. Ana or NTLSM0271" />
          </Field>
        </div>
      </div>
      {(list.error || cancel.error) && <Alert>{(list.error ?? cancel.error)!.message}</Alert>}
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No voucher sales match.</p>
      ) : (
        <ul className="divide-y divide-stone-100 text-sm">
          {rows.map((s) => (
            <li key={s.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{longDate(s.businessDay)}</span>
                <span className="flex-1">
                  {s.buyerName ?? 'No name'}
                  {s.buyerPhone && <span className="text-stone-500"> · {s.buyerPhone}</span>}
                  <span className="text-stone-500">
                    {' '}
                    · {s.qtyPaid}
                    {s.qtyFree ? `+${s.qtyFree}` : ''} × {s.serviceName}
                  </span>
                </span>
                <span className="tabular-nums">{peso(s.total)}</span>
                {s.status === 'voided' ? (
                  <Badge tone="red">Cancelled</Badge>
                ) : (
                  <>
                    <Badge tone={s.used === s.vouchers.length ? 'stone' : 'teal'}>
                      {s.used} of {s.vouchers.length} used
                    </Badge>
                    {s.businessDay === today && s.used === 0 && (
                      <button
                        type="button"
                        className="text-xs text-stone-500 underline"
                        onClick={() => {
                          const reason = prompt('Why cancel this voucher sale? Its cards go back to the shop unsold.');
                          if (reason && reason.trim().length >= 3) cancel.mutate({ path: `/voucher-sales/${s.id}/void`, body: { reason } });
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </>
                )}
              </div>
              {s.status === 'paid' && (
                <div className="flex flex-wrap gap-2">
                  {s.vouchers.map((v) => (
                    <span key={v.serial} className={`rounded border px-2 py-0.5 font-mono text-xs ${v.redeemedAt ? 'border-stone-200 bg-stone-50 text-stone-500' : 'border-teal-200 text-teal-800'}`}>
                      {v.serial}
                      {v.redeemedAt ? ` · used ${dayOf(v.redeemedAt)}` : ' · unused'}
                      {v.free && ' · Free'}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function VouchersPage() {
  const canImport = useCan('vouchers.import');
  const canEndorse = useCan('vouchers.endorse');
  const cancelCard = useDayAction();
  const [selling, setSelling] = useState(false);
  const [panel, setPanel] = useState<'endorse' | 'count' | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<VoucherStatus | ''>('');
  const list = useVouchers({ q, status });
  const rows = list.data?.vouchers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Vouchers</h1>
        <div className="flex flex-wrap gap-2">
          {canImport && panel !== 'count' && (
            <Button variant="secondary" onClick={() => setPanel('count')}>Go-live count</Button>
          )}
          {canEndorse && panel !== 'endorse' && (
            <Button variant="secondary" onClick={() => setPanel('endorse')}>Endorse cards</Button>
          )}
          <Button onClick={() => setSelling(true)}>Sell vouchers</Button>
        </div>
      </div>
      {panel === 'endorse' && <EndorseForm onDone={() => setPanel(null)} />}
      {panel === 'count' && <CountForm onDone={() => setPanel(null)} />}
      <ForReceiving />
      <InShop />
      <SalesHistory />

      <Card title="Look up a card">
        <div className="mb-4 grid grid-cols-[1fr_12rem] gap-3">
          <Input placeholder="Serial number, e.g. NTLSM0271" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select value={status} onChange={(e) => setStatus(e.target.value as VoucherStatus | '')}>
            <option value="">Any status</option>
            {Object.entries(VOUCHER_STATUS_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        {(list.error || cancelCard.error) && <Alert>{(list.error ?? cancelCard.error)!.message}</Alert>}
        {rows.length === 0 ? (
          <p className="text-sm text-stone-500">No cards match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className={th}>Serial</th>
                  <th className={th}>Service</th>
                  <th className={th}>Sold</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td className={`${td} font-mono`}>
                      {v.serial} {v.imported && v.isFree && <Badge tone="teal">Free</Badge>}
                    </td>
                    <td className={td}>{v.serviceName}</td>
                    <td className={td}>
                      {v.imported && 'Paper (before the system)'}
                      {v.soldOn && `${v.imported ? ' · ' : ''}${longDate(v.soldOn)}`}
                      {v.buyerName && <span className="text-stone-500"> · {v.buyerName}</span>}
                    </td>
                    <td className={td}>
                      <Badge tone={STATUS_TONE[v.status]}>{VOUCHER_STATUS_LABELS[v.status]}</Badge>
                      {v.redeemedAt && <span className="ml-2 text-xs text-stone-500">{dayOf(v.redeemedAt)}</span>}
                      {v.voidReason && <span className="ml-2 text-xs text-stone-500">{v.voidReason}</span>}
                      {canEndorse && v.status === 'in_shop' && (
                        <button
                          type="button"
                          className="ml-2 text-xs text-stone-500 underline"
                          onClick={() => {
                            const reason = prompt(`Cancel card ${v.serial}? Say why (e.g. torn, lost).`);
                            if (reason && reason.trim().length >= 3) cancelCard.mutate({ path: `/vouchers/${v.id}/void`, body: { reason } });
                          }}
                        >
                          Cancel card
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selling && <SellVouchersDialog onClose={() => setSelling(false)} />}
    </div>
  );
}
