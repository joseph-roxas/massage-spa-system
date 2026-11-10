import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, td, th } from '../../components/ui';
import { api } from '../../lib/api';
import { manilaTime } from '../../lib/attendance';
import { longDate } from '../../lib/format';

type LateEntry = {
  id: string;
  businessDay: string;
  guestName: string | null;
  serviceName: string;
  therapistName: string | null;
  startedAt: string | null;
  doneAt: string | null;
  status: string;
  createdAt: string;
};

/** Guests the desk entered after the Therapist served them; the Super Admin checks the times, e.g. for Happy Hours. */
export function LateEntries() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['late-entries'],
    queryFn: () => api<{ entries: LateEntry[] }>('/bookings/late'),
  });
  const check = useMutation({
    mutationFn: (ids: string[]) => api('/bookings/late/checked', { body: { ids } }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['late-entries'] });
      qc.invalidateQueries({ queryKey: ['attention'] });
    },
  });
  const entries = list.data?.entries ?? [];
  if (!entries.length) return null;

  return (
    <Card
      title={`Guests entered late (${entries.length})`}
      actions={
        <Button variant="secondary" className="h-8 px-3" disabled={check.isPending} onClick={() => check.mutate(entries.map((e) => e.id))}>
          Mark all checked
        </Button>
      }
    >
      <p className="mb-3 text-sm text-stone-600">
        The desk recorded these after the Therapist had already started. Check the times look right, since the start time decides Happy Hours and the Rotation.
      </p>
      {check.error && <Alert>{check.error.message}</Alert>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Day</th>
              <th className={th}>Served</th>
              <th className={th}>Guest and service</th>
              <th className={th}>Therapist</th>
              <th className={th}>Entered at</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className={`${td} whitespace-nowrap`}>{longDate(e.businessDay)}</td>
                <td className={`${td} whitespace-nowrap tabular-nums`}>
                  {e.startedAt ? manilaTime(e.startedAt) : '—'}–{e.doneAt ? manilaTime(e.doneAt) : 'still in service'}
                </td>
                <td className={td}>
                  {e.guestName || 'Walk-in guest'} · {e.serviceName}
                </td>
                <td className={td}>{e.therapistName}</td>
                <td className={`${td} whitespace-nowrap tabular-nums`}>{manilaTime(e.createdAt)}</td>
                <td className={`${td} text-right`}>
                  <Button variant="secondary" className="h-8 px-3" disabled={check.isPending} onClick={() => check.mutate([e.id])}>
                    Checked
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
