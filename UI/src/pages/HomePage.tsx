import { Link } from 'react-router';
import { Alert, Badge, Card } from '../components/ui';
import { useCan, useCurrentUser } from '../lib/auth';
import { manilaTime, useRotation } from '../lib/attendance';
import { longDate } from '../lib/format';

function RotationBoard() {
  const { data, error, isPending } = useRotation();
  return (
    <Card
      title={data ? `Rotation · ${longDate(data.day)}` : 'Rotation'}
      actions={
        <Link to="/clock" className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">
          Open Clock-in Screen
        </Link>
      }
    >
      {error && <Alert>{error.message}</Alert>}
      {isPending && <p className="text-sm text-stone-500">Loading…</p>}
      {data?.rotation.length === 0 && (
        <p className="text-sm text-stone-500">No therapists clocked in yet. They clock in on the Clock-in Screen.</p>
      )}
      {!!data?.rotation.length && (
        <ol className="divide-y divide-stone-100">
          {data.rotation.map((r) => {
            const isNext = r.staffId === data.next;
            return (
              <li key={r.staffId} className={`flex items-center gap-4 py-3 ${isNext ? '-mx-5 bg-teal-50 px-5' : ''}`}>
                <span className="w-8 text-center text-lg font-semibold tabular-nums text-stone-400">{r.position}</span>
                <div className="flex-1">
                  <p className="font-medium">
                    {r.displayName}{' '}
                    {r.therapistClass === 'lmt' && <Badge tone="teal">LMT</Badge>}{' '}
                    {r.isOnCall && <Badge tone="amber">On-call</Badge>}
                  </p>
                  <p className="text-xs text-stone-500">In line since {manilaTime(r.queuedSince)}</p>
                </div>
                {isNext && <span className="text-sm font-semibold text-teal-800">Next guest</span>}
                {r.status === 'in_service' ? <Badge tone="amber">With a guest</Badge> : <Badge>Free</Badge>}
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-4 text-xs text-stone-500">
        Order follows arrival time. A therapist goes to the back after finishing a guest who didn&apos;t request them.
      </p>
    </Card>
  );
}

export function HomePage() {
  const { data: user } = useCurrentUser();
  const canDesk = useCan('bookings.manage');
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Good day, {user?.firstName}</h1>
      {canDesk ? (
        <RotationBoard />
      ) : (
        <Card title="Front Desk">
          <p className="text-sm text-stone-600">The front desk tools are for receptionists and the owner.</p>
        </Card>
      )}
    </div>
  );
}
