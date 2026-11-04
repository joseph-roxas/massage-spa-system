import { Fragment, useState, type FormEvent } from 'react';
import { businessDayOf } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select, td, th } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useClockStaff } from '../../lib/attendance';
import { useCan } from '../../lib/auth';
import { longDate, parsePesos, peso, todayManila } from '../../lib/format';
import { itemLabel, useInventoryAction, useItemHistory, useItems, type Item } from '../../lib/inventory';
import { VendorPicker } from './shared';

function TakeOutDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const staff = useClockStaff();
  const act = useInventoryAction();
  const [qty, setQty] = useState('1');
  const [takenBy, setTakenBy] = useState('');
  const [note, setNote] = useState('');
  const n = Number(qty);

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: '/inventory/stock-outs', body: { itemId: item.id, qty: n, takenByStaffId: takenBy || null, note } }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Take out · ${itemLabel(item)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        <p className="text-sm text-stone-600">On hand: {item.onHand} {item.unit}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`How many (${item.unit})`}>
            <Input inputMode="numeric" required value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
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
        </div>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="E.g. for Rooms 1–4" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!Number.isInteger(n) || n < 1 || n > item.onHand || act.isPending}>
            Take out
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A purchase made without a Purchase Order, e.g. bought at the market. */
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
        <p className="text-sm text-stone-600">For items bought without a Purchase Order. Ordered items are received from their order.</p>
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
        <Checkbox label="Paid from the cash drawer today (counted at Day Close)" checked={d.fromDrawer} onChange={(e) => setD({ ...d, fromDrawer: e.target.checked })} />
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

const MOVE_LABEL = { in: 'Received', out: 'Taken out', opening: 'Opening count' } as const;

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
        {data.moves.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2">
            <span className="w-32 text-stone-500">{longDate(m.date)}</span>
            <span className="flex-1">
              {MOVE_LABEL[m.type]}
              {m.who && <span className="text-stone-500"> · {m.who}</span>}
              {m.unitPrice !== null && <span className="text-stone-500"> · {peso(m.unitPrice)} each</span>}
              {m.note && <span className="text-stone-500"> · {m.note}</span>}
            </span>
            <span className={`tabular-nums ${m.type === 'out' ? 'text-red-700' : 'text-teal-800'}`}>
              {m.type === 'out' ? '−' : '+'}
              {m.qty}
            </span>
            {m.type === 'out' && (m.date === today || isAdmin) && (
              <button
                type="button"
                className="text-xs text-stone-500 underline"
                onClick={() => confirm('Remove this Stock-out? Use this only for a mistake.') && act.mutate({ path: `/inventory/stock-outs/${m.id}`, method: 'DELETE' })}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StockTab() {
  const { data, error } = useItems();
  const canReceive = useCan('inventory.receive');
  const [takeOut, setTakeOut] = useState<Item | null>(null);
  const [buying, setBuying] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [lowOnly, setLowOnly] = useState(false);
  const all = (data?.items ?? []).filter((i) => i.active || i.onHand > 0);
  const rows = lowOnly ? all.filter((i) => i.low) : all;
  const lowCount = all.filter((i) => i.low).length;

  return (
    <Card
      title="Stock on hand"
      actions={canReceive && <Button variant="secondary" onClick={() => setBuying(true)}>Record a purchase</Button>}
    >
      {error && <Alert>{error.message}</Alert>}
      {lowCount > 0 && (
        <div className="mb-3 flex items-center gap-3 text-sm">
          <Badge tone="amber">{lowCount} low</Badge>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Show only low stock
          </label>
        </div>
      )}
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Item</th>
            <th className={`${th} text-right`}>On hand</th>
            <th className={th}>Last taken out</th>
            <th className={th}>Last bought</th>
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
                </td>
                <td className={`${td} text-right tabular-nums`}>
                  {i.low && <Badge tone="amber">Low</Badge>} <span className="font-semibold">{i.onHand}</span>
                  {i.reorderLevel > 0 && <span className="block text-xs text-stone-500">reorder at {i.reorderLevel}</span>}
                </td>
                <td className={td}>{i.lastStockOut ? longDate(i.lastStockOut) : '—'}</td>
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
                <td className={`${td} text-right`}>
                  <Button variant="secondary" className="h-8" disabled={i.onHand < 1} onClick={() => setTakeOut(i)}>
                    Take out
                  </Button>
                </td>
              </tr>
              {open === i.id && (
                <tr className="bg-stone-50">
                  <td colSpan={5}>
                    <History item={i} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {takeOut && <TakeOutDialog item={takeOut} onClose={() => setTakeOut(null)} />}
      {buying && <PurchaseDialog items={data?.items ?? []} onClose={() => setBuying(false)} />}
    </Card>
  );
}
