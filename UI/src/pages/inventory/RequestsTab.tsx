import { useState } from 'react';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { manilaTime } from '../../lib/attendance';
import { useCan } from '../../lib/auth';
import { longDate } from '../../lib/format';
import { itemLabel, useInventoryAction, useItems, useTakeoutRequests, useTurnovers, type Item, type TakeoutRequest } from '../../lib/inventory';
import { toManila } from '@spa/domain';
import { RequestDialog, SendDialog } from './StockTab';

const dayOf = (iso: string) => longDate(toManila(new Date(iso)).date);

/** Turnovers that arrived short, for the Super Admin to say where the rest went. */
function Shortfalls() {
  const list = useTurnovers();
  const act = useInventoryAction();
  const open = (list.data?.turnovers ?? []).filter((t) => t.short > 0 && !t.shortfallResolvedAt);
  if (!open.length) return null;
  return (
    <Card title={`Short on arrival (${open.length})`}>
      {act.error && <Alert>{act.error.message}</Alert>}
      <ul className="divide-y divide-stone-100 text-sm">
        {open.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="flex-1">
              {t.qty} {itemLabel({ name: t.itemName, unit: t.unit })} sent {longDate(t.sentOn)}, {t.receivedQty} received: <span className="font-semibold">{t.short} short</span>
              {t.receiveNote && <span className="block text-xs text-stone-500">“{t.receiveNote}”</span>}
            </span>
            <Button variant="secondary" className="h-8" onClick={() => act.mutate({ path: `/inventory/turnovers/${t.id}/resolve`, body: { outcome: 'in_storage' } })}>
              Still in my storage
            </Button>
            <Button variant="secondary" className="h-8" onClick={() => confirm(`Mark ${t.short} as lost? They come off your storage count.`) && act.mutate({ path: `/inventory/turnovers/${t.id}/resolve`, body: { outcome: 'lost' } })}>
              Lost
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function RequestsTab() {
  const isAdmin = useCan('inventory.po.approve');
  const list = useTakeoutRequests();
  const items = useItems();
  const act = useInventoryAction();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState<TakeoutRequest | null>(null);
  const rows = list.data?.requests ?? [];
  const open = rows.filter((r) => !r.resolvedAt);
  const closed = rows.filter((r) => r.resolvedAt).slice(0, 20);
  const allItems = items.data?.items ?? [];
  const itemOf = (r: TakeoutRequest): Item | undefined => allItems.find((i) => i.id === r.itemId);

  const row = (r: TakeoutRequest) => (
    <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
      <span className="flex-1">
        <Badge tone={r.level === 'out' ? 'red' : 'amber'}>{r.level === 'out' ? 'Out' : 'Low'}</Badge> <span className="font-semibold tabular-nums">{r.qty}</span> {r.itemName}
        {r.unit && <span className="text-stone-500"> ({r.unit})</span>}
        <span className="block text-xs text-stone-500">
          {r.requestedByName ?? 'Someone'} · {dayOf(r.createdAt)} {manilaTime(r.createdAt)}
          {r.note && ` · ${r.note}`}
          {r.sent > 0 && !r.resolvedAt && ` · ${r.sent} sent, waiting to be received`}
          {r.dismissReason && ` · closed: ${r.dismissReason}`}
        </span>
      </span>
      {isAdmin && !r.resolvedAt && (
        <>
          {r.itemId && (
            <Button className="h-8" onClick={() => setSending(r)}>
              Send {itemOf(r) ? `(${itemOf(r)!.storage} in storage)` : ''}
            </Button>
          )}
          <Button
            variant="secondary"
            className="h-8"
            onClick={() => {
              const reason = prompt('Why close this request?');
              if (reason && reason.trim().length >= 3) act.mutate({ path: `/inventory/takeout-requests/${r.id}/dismiss`, body: { reason } });
            }}
          >
            Close
          </Button>
        </>
      )}
    </li>
  );

  return (
    <div className="space-y-6">
      {isAdmin && <Shortfalls />}
      <Card title={`Requests from the shop (${open.length})`} actions={<Button variant="secondary" onClick={() => setAsking(true)}>Ask for items</Button>}>
        {(list.error || act.error) && <Alert>{(list.error ?? act.error)!.message}</Alert>}
        {open.length === 0 ? <p className="text-sm text-stone-500">Nothing requested.</p> : <ul className="divide-y divide-stone-100 text-sm">{open.map(row)}</ul>}
      </Card>
      {closed.length > 0 && (
        <Card title="Recently done">
          <ul className="divide-y divide-stone-100 text-sm text-stone-600">{closed.map(row)}</ul>
        </Card>
      )}
      {asking && <RequestDialog items={allItems} onClose={() => setAsking(false)} />}
      {sending && (
        <SendDialog item={itemOf(sending)} items={allItems} qty={Math.max(1, sending.qty - sending.sent)} requestId={sending.id} onClose={() => setSending(null)} />
      )}
    </div>
  );
}
