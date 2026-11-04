import { Fragment, useState, type FormEvent } from 'react';
import { businessDayOf } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select, td, th } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useClockStaff } from '../../lib/attendance';
import { useCan } from '../../lib/auth';
import { longDate, parsePesos, peso, todayManila } from '../../lib/format';
import {
  DISCARD_REASON_LABELS,
  ITEM_KIND_LABELS,
  itemLabel,
  useInventoryAction,
  useItemHistory,
  useItems,
  useTurnovers,
  type Item,
  type ItemKind,
} from '../../lib/inventory';
import { VendorPicker } from './shared';

/** Use for a Consumable; Discard (with a reason) for a Reusable Supply or Equipment. */
function TakeOutDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const staff = useClockStaff();
  const act = useInventoryAction();
  const discard = item.kind !== 'consumable';
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState<keyof typeof DISCARD_REASON_LABELS>('broken');
  const [takenBy, setTakenBy] = useState('');
  const [note, setNote] = useState('');
  const n = Number(qty);

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate(
      { path: '/inventory/stock-outs', body: { itemId: item.id, qty: n, kind: discard ? 'discard' : 'use', reason: discard ? reason : undefined, takenByStaffId: takenBy || null, note } },
      { onSuccess: onClose },
    );
  }

  return (
    <Modal title={`${discard ? 'Discard' : 'Use'} · ${itemLabel(item)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        <p className="text-sm text-stone-600">
          At the shop: {item.shop} {item.unit}
          {discard && '. Discard only what is broken, worn out or lost; it is gone from the count.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`How many (${item.unit})`}>
            <Input inputMode="numeric" required value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          {discard ? (
            <Field label="Why">
              <Select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
                {Object.entries(DISCARD_REASON_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Taken by (optional)">
              <Select value={takenBy} onChange={(e) => setTakenBy(e.target.value)}>
                <option value="">—</option>
                {(staff.data?.staff ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={discard ? 'E.g. cracked in Room 3' : 'E.g. for Rooms 1–4'} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!Number.isInteger(n) || n < 1 || n > item.shop || act.isPending}>
            {discard ? 'Discard' : 'Use'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The Receptionist tells the Super Admin the shop needs something. */
export function RequestDialog({ item, items, onClose }: { item?: Item; items: Item[]; onClose: () => void }) {
  const act = useInventoryAction();
  const [itemId, setItemId] = useState(item?.id ?? '');
  const [itemText, setItemText] = useState('');
  const [qty, setQty] = useState('1');
  const [level, setLevel] = useState<'low' | 'out'>(item && item.shop === 0 ? 'out' : 'low');
  const [note, setNote] = useState('');
  const n = Number(qty);
  const isNew = itemId === '__new__';

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate(
      { path: '/inventory/takeout-requests', body: { ...(isNew ? { itemText } : { itemId }), qty: n, level, note: note || undefined } },
      { onSuccess: onClose },
    );
  }

  return (
    <Modal title="Ask the owner for items" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        <Field label="Item">
          <Select required value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Choose…</option>
            {items
              .filter((i) => i.active)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {itemLabel(i)} · {i.shop} at the shop
                </option>
              ))}
            <option value="__new__">Something not on the list…</option>
          </Select>
        </Field>
        {isNew && (
          <Field label="What is it?">
            <Input required minLength={2} value={itemText} onChange={(e) => setItemText(e.target.value)} placeholder="E.g. small bamboo baskets" />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="How many needed">
            <Input inputMode="numeric" required value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="At the shop now">
            <Select value={level} onChange={(e) => setLevel(e.target.value as 'low' | 'out')}>
              <option value="low">Running low</option>
              <option value="out">Out of stock</option>
            </Select>
          </Field>
        </div>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!itemId || !Number.isInteger(n) || n < 1 || act.isPending}>Send request</Button>
        </div>
      </form>
    </Modal>
  );
}

/** The Super Admin sends items from Storage to the shop. */
export function SendDialog({ item, items, qty: wanted, requestId, onClose }: { item?: Item; items: Item[]; qty?: number; requestId?: string; onClose: () => void }) {
  const act = useInventoryAction();
  const [itemId, setItemId] = useState(item?.id ?? '');
  const [qty, setQty] = useState(String(wanted ?? 1));
  const [sentOn, setSentOn] = useState(todayManila());
  const [note, setNote] = useState('');
  const chosen = items.find((i) => i.id === itemId);
  const n = Number(qty);

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: '/inventory/turnovers', body: { itemId, qty: n, sentOn, takeoutRequestId: requestId, note: note || undefined } }, { onSuccess: onClose });
  }

  return (
    <Modal title="Send to the shop" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        <Field label="Item">
          <Select required value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!!item}>
            <option value="">Choose…</option>
            {items
              .filter((i) => i.active)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {itemLabel(i)} · {i.storage} in storage
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="How many" hint={chosen ? `${chosen.storage} in storage` : undefined}>
            <Input inputMode="numeric" required value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="Sent on">
            <Input type="date" required max={todayManila()} value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
          </Field>
        </div>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="text-xs text-stone-500">The receptionist confirms what arrived before it counts as shop stock.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!itemId || !Number.isInteger(n) || n < 1 || (chosen && n > chosen.storage) || act.isPending}>Send</Button>
        </div>
      </form>
    </Modal>
  );
}

/** A purchase made without a Purchase Order, e.g. bought at the market. It goes into Storage. */
function PurchaseDialog({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const act = useInventoryAction();
  const [d, setD] = useState({ itemId: '', vendorId: '', qty: '1', price: '', date: todayManila(), fromDrawer: false });
  const price = parsePesos(d.price);
  const n = Number(d.qty);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (price === null) return;
    act.mutate({ path: '/inventory/stock-ins', body: { itemId: d.itemId, vendorId: d.vendorId, qty: n, unitPrice: price, purchaseDate: d.date, fromDrawer: d.fromDrawer } }, { onSuccess: onClose });
  }

  return (
    <Modal title="Record a purchase" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        <p className="text-sm text-stone-600">Goes into your storage. Send what the shop needs with “Send to shop”.</p>
        <Field label="Item">
          <Select required value={d.itemId} onChange={(e) => setD({ ...d, itemId: e.target.value })}>
            <option value="">Choose…</option>
            {items.filter((i) => i.active).map((i) => (
              <option key={i.id} value={i.id}>
                {itemLabel(i)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Vendor">
          <VendorPicker value={d.vendorId} onChange={(vendorId) => setD((x) => ({ ...x, vendorId }))} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="How many">
            <Input inputMode="numeric" required value={d.qty} onChange={(e) => setD({ ...d, qty: e.target.value })} />
          </Field>
          <Field label="Price each">
            <Input inputMode="decimal" required value={d.price} onChange={(e) => setD({ ...d, price: e.target.value })} />
          </Field>
          <Field label="Bought on">
            <Input type="date" required max={todayManila()} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} />
          </Field>
        </div>
        {price !== null && Number.isInteger(n) && n > 0 && <p className="text-sm text-stone-600">Total {peso(price * n)}</p>}
        <Checkbox label="Paid from the shop’s sales cash today (counted at Day Close)" checked={d.fromDrawer} onChange={(e) => setD({ ...d, fromDrawer: e.target.checked })} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!d.itemId || !d.vendorId || price === null || !Number.isInteger(n) || n < 1 || act.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Turnovers the Super Admin sent that the shop hasn't confirmed yet. */
export function ForReceiving() {
  const isAdmin = useCan('inventory.po.approve');
  const list = useTurnovers();
  const act = useInventoryAction();
  const pending = (list.data?.turnovers ?? []).filter((t) => !t.receivedAt);
  if (!pending.length) return null;

  function receive(t: (typeof pending)[number]) {
    const got = prompt(`How many ${t.itemName} (${t.unit}) arrived? ${t.qty} were sent.`, String(t.qty));
    if (got === null) return;
    const receivedQty = Number(got);
    if (!Number.isInteger(receivedQty) || receivedQty < 0) return alert('Enter a whole number.');
    const note = receivedQty < t.qty ? prompt('What is missing or damaged?') : '';
    if (note === null) return;
    act.mutate({ path: `/inventory/turnovers/${t.id}/receive`, body: { receivedQty, note: note || undefined } });
  }

  return (
    <Card title={`For receiving (${pending.length})`}>
      {act.error && <Alert>{act.error.message}</Alert>}
      <ul className="divide-y divide-stone-100 text-sm">
        {pending.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="flex-1">
              <span className="font-semibold tabular-nums">{t.qty}</span> {itemLabel({ name: t.itemName, unit: t.unit })}
              <span className="block text-xs text-stone-500">
                Sent {longDate(t.sentOn)}
                {t.note && ` · ${t.note}`}
              </span>
            </span>
            {isAdmin && (
              <button
                type="button"
                className="text-xs text-stone-500 underline"
                onClick={() => confirm('Remove this turnover? The shop has not received it yet.') && act.mutate({ path: `/inventory/turnovers/${t.id}`, method: 'DELETE' })}
              >
                Remove
              </button>
            )}
            <Button onClick={() => receive(t)}>Received</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const MOVE_LABEL = { in: 'Bought', opening: 'Opening count', use: 'Used', discard: 'Discarded', turnover: 'Received at the shop' } as const;

function History({ item }: { item: Item }) {
  const { data } = useItemHistory(item.id);
  const act = useInventoryAction();
  const isAdmin = useCan('inventory.po.approve');
  const today = businessDayOf(new Date());
  if (!data) return null;
  if (!data.moves.length) return <p className="px-3 py-2 text-sm text-stone-500">Nothing recorded yet.</p>;
  return (
    <div className="px-3 pb-3">
      {act.error && <Alert>{act.error.message}</Alert>}
      <ul className="divide-y divide-stone-100 rounded-md border border-stone-200 bg-white text-sm">
        {data.moves.map((m) => {
          const out = m.type === 'use' || m.type === 'discard';
          return (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-32 text-stone-500">{longDate(m.date)}</span>
              <span className="flex-1">
                {MOVE_LABEL[m.type]}
                <span className="text-stone-500"> · {m.location === 'storage' ? 'storage' : 'shop'}</span>
                {m.who && <span className="text-stone-500"> · {m.who}</span>}
                {m.unitPrice !== null && <span className="text-stone-500"> · {peso(m.unitPrice)} each</span>}
                {m.note && <span className="text-stone-500"> · {m.note}</span>}
              </span>
              <span className={`tabular-nums ${out ? 'text-red-700' : 'text-teal-800'}`}>
                {out ? '−' : '+'}
                {m.qty}
              </span>
              {out && (m.date === today || isAdmin) && (
                <button
                  type="button"
                  className="text-xs text-stone-500 underline"
                  onClick={() => confirm('Remove this? Use this only for a mistake.') && act.mutate({ path: `/inventory/stock-outs/${m.id}`, method: 'DELETE' })}
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function StockTab() {
  const { data, error } = useItems();
  const isAdmin = useCan('inventory.po.approve');
  const [takeOut, setTakeOut] = useState<Item | null>(null);
  const [requesting, setRequesting] = useState<Item | 'any' | null>(null);
  const [sending, setSending] = useState<Item | 'any' | null>(null);
  const [buying, setBuying] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<ItemKind | ''>('');
  const [lowOnly, setLowOnly] = useState(false);
  const items = data?.items ?? [];
  const all = items.filter((i) => i.active || i.shop > 0 || i.storage > 0);
  const rows = all.filter((i) => (!kind || i.kind === kind) && (!lowOnly || i.low));
  const lowCount = all.filter((i) => i.low).length;

  return (
    <div className="space-y-6">
      <ForReceiving />
      <Card
        title="Stock"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setRequesting('any')}>Ask for items</Button>
            {isAdmin && (
              <>
                <Button variant="secondary" onClick={() => setSending('any')}>Send to shop</Button>
                <Button variant="secondary" onClick={() => setBuying(true)}>Record a purchase</Button>
              </>
            )}
          </div>
        }
      >
        {error && <Alert>{error.message}</Alert>}
        <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ItemKind | '')} className="w-48 rounded-md border border-stone-300 px-2 py-1.5 text-sm">
            <option value="">All kinds</option>
            {Object.entries(ITEM_KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          {lowCount > 0 && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Only low at the shop <Badge tone="amber">{lowCount}</Badge>
            </label>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Item</th>
                <th className={`${th} text-right`}>At the shop</th>
                <th className={`${th} text-right`}>In storage</th>
                <th className={th}>Last used</th>
                {isAdmin && <th className={th}>Last bought</th>}
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((i) => (
                <Fragment key={i.id}>
                  <tr>
                    <td className={td}>
                      <button type="button" className="text-left font-medium hover:underline" onClick={() => setOpen(open === i.id ? null : i.id)}>
                        {open === i.id ? '▾' : '▸'} {i.name}
                      </button>
                      <span className="ml-1 text-stone-500">({i.unit})</span>
                      <span className="block text-xs text-stone-500">{ITEM_KIND_LABELS[i.kind]}</span>
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      {i.low && <Badge tone="amber">Low</Badge>} <span className="font-semibold">{i.shop}</span>
                      {i.reorderLevel > 0 && <span className="block text-xs text-stone-500">low at {i.reorderLevel}</span>}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      {i.storage}
                      {i.inTransit > 0 && <span className="block text-xs text-stone-500">{i.inTransit} on the way</span>}
                    </td>
                    <td className={td}>{i.lastStockOut ? longDate(i.lastStockOut) : '—'}</td>
                    {isAdmin && (
                      <td className={td}>
                        {i.latestPurchase ? (
                          <>
                            {i.latestPurchase.unitPrice !== null && peso(i.latestPurchase.unitPrice)}
                            <span className="block text-xs text-stone-500">
                              {i.latestPurchase.vendorName} · {longDate(i.latestPurchase.purchaseDate)}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td className={`${td} text-right`}>
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" className="h-8" disabled={i.shop < 1} onClick={() => setTakeOut(i)}>
                          {i.kind === 'consumable' ? 'Use' : 'Discard'}
                        </Button>
                        {isAdmin ? (
                          <Button variant="secondary" className="h-8" disabled={i.storage < 1} onClick={() => setSending(i)}>
                            Send
                          </Button>
                        ) : (
                          <Button variant="secondary" className="h-8" onClick={() => setRequesting(i)}>
                            Ask
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {open === i.id && (
                    <tr className="bg-stone-50">
                      <td colSpan={isAdmin ? 6 : 5}>
                        <History item={i} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {takeOut && <TakeOutDialog item={takeOut} onClose={() => setTakeOut(null)} />}
        {requesting && <RequestDialog item={requesting === 'any' ? undefined : requesting} items={items} onClose={() => setRequesting(null)} />}
        {sending && <SendDialog item={sending === 'any' ? undefined : sending} items={items} onClose={() => setSending(null)} />}
        {buying && <PurchaseDialog items={items} onClose={() => setBuying(false)} />}
      </Card>
    </div>
  );
}
