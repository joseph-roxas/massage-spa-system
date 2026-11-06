import { Alert, Button } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { manilaTime } from '../../lib/attendance';
import { REJECT_REASON_LABELS, useRejects, type RejectReason } from '../../lib/front-desk';
import { useDayAction } from '../../lib/sales';

/** Records someone the shop did not serve, with one tap for the reason. */
export function TurnedAwayDialog({ onClose }: { onClose: () => void }) {
  const list = useRejects();
  const act = useDayAction();
  const rows = list.data?.rejects ?? [];
  return (
    <Modal title="Turned away" onClose={onClose}>
      <div className="space-y-4">
        {(list.error || act.error) && <Alert>{(list.error ?? act.error)!.message}</Alert>}
        <p className="text-sm text-stone-600">Why was this person not served?</p>
        <div className="grid gap-2">
          {Object.entries(REJECT_REASON_LABELS).map(([reason, label]) => (
            <Button key={reason} variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: '/rejects', body: { reason: reason as RejectReason } }, { onSuccess: onClose })}>
              {label}
            </Button>
          ))}
        </div>
        {rows.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium">Today</p>
            <ul className="divide-y divide-stone-100 text-sm">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-1.5">
                  <span className="w-20 tabular-nums text-stone-500">{manilaTime(r.createdAt)}</span>
                  <span className="flex-1">{REJECT_REASON_LABELS[r.reason]}</span>
                  <button type="button" className="text-xs text-stone-500 underline" disabled={act.isPending} onClick={() => act.mutate({ path: `/rejects/${r.id}`, method: 'DELETE' })}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
