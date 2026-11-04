import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useCan, useCurrentUser } from '../../lib/auth';
import { longDate, parsePesos, peso, pesosText, todayManila } from '../../lib/format';
import { itemLabel, PO_STATUS_LABELS, PO_STATUS_TONE, useInventoryAction, useItems, usePurchaseOrders, type PurchaseOrder } from '../../lib/inventory';
import { VendorPicker } from './shared';

type DraftLine = { itemId: string; qty: string; price: string };

function NewOrderDialog({ onClose, start }: { onClose: () => void; start: string[] }) {
  const items = useItems();
  const act = useInventoryAction();
  const [vendorId, setVendorId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(start.length ? start.map((itemId) => ({ itemId, qty: '1', price: '' })) : [{ itemId: '', qty: '1', price: '' }]);
  const set = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const valid = vendorId && lines.every((l) => l.itemId && Number.isInteger(Number(l.qty)) && Number(l.qty) > 0 && (l.price === '' || parsePesos(l.price) !== null));
  const options = (items.data?.items ?? []).filter((i) => i.active);

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate(
      {
        path: '/inventory/purchase-orders',
        body: { vendorId, note, lines: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), expectedPrice: l.price ? parsePesos(l.price) : null })) },
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Modal title="New Purchase Order" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        <Field label="Vendor">
          <VendorPicker value={vendorId} onChange={setVendorId} />
        </Field>
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_5rem_7rem_2rem] gap-2 text-xs font-medium text-stone-600">
            <span>Item</span>
            <span>How many</span>
            <span>Price each (if known)</span>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_5rem_7rem_2rem] gap-2">
              <Select required value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value })} aria-label="Item">
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id} disabled={lines.some((x, j) => j !== i && x.itemId === o.id)}>
                    {itemLabel(o)}
                  </option>
                ))}
              </Select>
              <Input inputMode="numeric" required value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label="How many" />
              <Input inputMode="decimal" value={l.price} onChange={(e) => set(i, { price: e.target.value })} aria-label="Price each" />
              <button type="button" className="text-stone-400 hover:text-red-700 disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="text-sm text-teal-800 underline" onClick={() => setLines((ls) => [...ls, { itemId: '', qty: '1', price: '' }])}>
            + Add an item
          </button>
        </div>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid || act.isPending}>Send for approval</Button>
        </div>
      </form>
    </Modal>
  );
}

function ReceiveDialog({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
  const items = useItems();
  const act = useInventoryAction();
  const [date, setDate] = useState(todayManila());
  const [fromDrawer, setFromDrawer] = useState(false);
  const open = po.lines.filter((l) => l.received < l.qty);
  const lastPrice = (itemId: string) => items.data?.items.find((i) => i.id === itemId)?.latestPurchase?.unitPrice ?? null;
  const [got, setGot] = useState(() =>
    Object.fromEntries(open.map((l) => [l.id, { qty: String(l.qty - l.received), price: pesosText(l.expectedPrice ?? lastPrice(l.itemId) ?? 0) }])),
  );
  const rows = open.map((l) => ({ line: l, qty: Number(got[l.id]!.qty), price: parsePesos(got[l.id]!.price) }));
  const valid = rows.every((r) => Number.isInteger(r.qty) && r.qty >= 0 && r.qty <= r.line.qty - r.line.received && r.price !== null) && rows.some((r) => r.qty > 0);
  const total = rows.reduce((s, r) => s + (r.price ?? 0) * (r.qty || 0), 0);

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate(
      { path: `/inventory/purchase-orders/${po.id}/receive`, body: { purchaseDate: date, fromDrawer, lines: rows.map((r) => ({ lineId: r.line.id, qty: r.qty, unitPrice: r.price })) } },
      { onSuccess: onClose },
    );
  }

  return (
    <Modal title={`Receive delivery · ${po.vendorName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        <p className="text-sm text-stone-600">Enter what actually arrived and the price paid. Anything not delivered stays on the order.</p>
        <div className="grid grid-cols-[1fr_6rem_7rem] gap-2 text-xs font-medium text-stone-600">
          <span>Item</span>
          <span>Received</span>
          <span>Price each</span>
        </div>
        {rows.map(({ line }) => (
          <div key={line.id} className="grid grid-cols-[1fr_6rem_7rem] items-center gap-2 text-sm">
            <span>
              {itemLabel({ name: line.itemName, unit: line.unit })}
              <span className="block text-xs text-stone-500">{line.qty - line.received} still to come</span>
            </span>
            <Input inputMode="numeric" value={got[line.id]!.qty} onChange={(e) => setGot({ ...got, [line.id]: { ...got[line.id]!, qty: e.target.value } })} aria-label={`${line.itemName} received`} />
            <Input inputMode="decimal" value={got[line.id]!.price} onChange={(e) => setGot({ ...got, [line.id]: { ...got[line.id]!, price: e.target.value } })} aria-label={`${line.itemName} price`} />
          </div>
        ))}
        <div className="flex items-end justify-between gap-3">
          <Field label="Delivered on">
            <Input type="date" required max={todayManila()} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <p className="pb-2 text-sm font-medium">Total {peso(total)}</p>
        </div>
        <Checkbox label="Paid from the cash drawer today (counted at Day Close)" checked={fromDrawer} onChange={(e) => setFromDrawer(e.target.checked)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid || act.isPending}>Add to stock</Button>
        </div>
      </form>
    </Modal>
  );
}

function OrderCard({ po, onReceive }: { po: PurchaseOrder; onReceive: () => void }) {
  const canApprove = useCan('inventory.po.approve');
  const canReceive = useCan('inventory.receive');
  const { data: me } = useCurrentUser();
  const act = useInventoryAction();
  const canCancel = canApprove ? ['requested', 'approved', 'partially_received'].includes(po.status) : po.status === 'requested' && po.requestedBy === me?.id;
  const estimate = po.lines.reduce((s, l) => s + (l.expectedPrice ?? 0) * l.qty, 0);

  return (
    <li className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="font-semibold">{po.vendorName}</span>
        <Badge tone={PO_STATUS_TONE[po.status]}>{PO_STATUS_LABELS[po.status]}</Badge>
        <span className="text-sm text-stone-500">
          {longDate(po.requestedAt.slice(0, 10))}
          {po.requestedByName && ` · asked by ${po.requestedByName}`}
        </span>
        <span className="flex-1" />
        {canApprove && po.status === 'requested' && (
          <Button className="h-8" disabled={act.isPending} onClick={() => act.mutate({ path: `/inventory/purchase-orders/${po.id}/approve` })}>
            Approve
          </Button>
        )}
        {canReceive && (po.status === 'approved' || po.status === 'partially_received') && (
          <Button className="h-8" onClick={onReceive}>
            Receive delivery
          </Button>
        )}
        {canCancel && (
          <button
            type="button"
            className="text-xs text-stone-500 underline"
            onClick={() => {
              const reason = prompt(po.status === 'partially_received' ? 'Why stop waiting for the rest?' : 'Why cancel this order?');
              if (reason && reason.trim().length >= 3) act.mutate({ path: `/inventory/purchase-orders/${po.id}/cancel`, body: { reason } });
            }}
          >
            {po.status === 'requested' && !canApprove ? 'Withdraw' : po.status === 'requested' ? 'Reject' : 'Cancel'}
          </button>
        )}
      </div>
      {act.error && <Alert>{act.error.message}</Alert>}
      <ul className="text-sm">
        {po.lines.map((l) => (
          <li key={l.id} className="flex justify-between gap-3 py-0.5">
            <span>
              {l.qty} × {itemLabel({ name: l.itemName, unit: l.unit })}
              {l.expectedPrice !== null && <span className="text-stone-500"> @ {peso(l.expectedPrice)}</span>}
            </span>
            {po.status !== 'requested' && (
              <span className={l.received >= l.qty ? 'text-teal-800' : 'text-stone-500'}>
                {l.received}/{l.qty} received
              </span>
            )}
          </li>
        ))}
      </ul>
      {estimate > 0 && <p className="mt-1 text-xs text-stone-500">Estimated {peso(estimate)}</p>}
      {po.note && <p className="mt-1 text-sm text-stone-600">Note: {po.note}</p>}
      {po.cancelReason && <p className="mt-1 text-sm text-red-700">{po.cancelReason}</p>}
    </li>
  );
}

export function OrdersTab() {
  const { data, error } = usePurchaseOrders();
  const items = useItems();
  const canRequest = useCan('inventory.po.request');
  const [creating, setCreating] = useState<string[] | null>(null);
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const all = data?.purchaseOrders ?? [];
  const openOrders = all.filter((p) => ['requested', 'approved', 'partially_received'].includes(p.status));
  const closed = all.filter((p) => !openOrders.includes(p));
  const low = (items.data?.items ?? []).filter((i) => i.low && i.active);

  return (
    <Card
      title="Purchase Orders"
      actions={
        canRequest && (
          <div className="flex gap-2">
            {low.length > 0 && (
              <Button variant="secondary" onClick={() => setCreating(low.map((i) => i.id))}>
                Order low stock ({low.length})
              </Button>
            )}
            <Button onClick={() => setCreating([])}>New order</Button>
          </div>
        )
      }
    >
      {error && <Alert>{error.message}</Alert>}
      {openOrders.length === 0 ? (
        <p className="text-sm text-stone-500">No open orders.</p>
      ) : (
        <ul className="space-y-3">
          {openOrders.map((po) => (
            <OrderCard key={po.id} po={po} onReceive={() => setReceiving(po)} />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div className="mt-4">
          <button type="button" className="text-sm text-stone-600 underline" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'Hide' : 'Show'} delivered and cancelled ({closed.length})
          </button>
          {showClosed && (
            <ul className="mt-3 space-y-3">
              {closed.map((po) => (
                <OrderCard key={po.id} po={po} onReceive={() => setReceiving(po)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {creating && <NewOrderDialog start={creating} onClose={() => setCreating(null)} />}
      {receiving && <ReceiveDialog po={receiving} onClose={() => setReceiving(null)} />}
    </Card>
  );
}
