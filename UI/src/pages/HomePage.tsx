import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Badge, Button, Card } from '../components/ui';
import { useCan, useCurrentUser } from '../lib/auth';
import { manilaTime } from '../lib/attendance';
import { duration, longDate } from '../lib/format';
import { guestLabel, useBoard, useDeskAction, type Board, type Booking } from '../lib/front-desk';
import { NewBookingDialog } from './front-desk/NewBookingDialog';
import { StartDialog } from './front-desk/StartDialog';

/** Re-renders every 30s so countdowns stay current between board refreshes. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function minutesLeft(endsAt: string, now: number): number {
  return Math.round((new Date(endsAt).getTime() - now) / 60_000);
}

function RoomTile({ room, now, onDone }: { room: Board['rooms'][number]; now: number; onDone: (b: Booking) => void }) {
  const b = room.booking;
  if (!room.active) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 p-3 text-sm text-stone-400">
        <p className="font-medium">{room.name}</p>
        <p>Closed</p>
      </div>
    );
  }
  if (!b) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
        <p className="font-medium">{room.name}</p>
        <p className="text-emerald-700">Free</p>
      </div>
    );
  }
  const left = b.endsAt ? minutesLeft(b.endsAt, now) : null;
  return (
    <div className={`rounded-lg border p-3 text-sm ${left !== null && left <= 0 ? 'border-amber-400 bg-amber-50' : 'border-teal-600 bg-teal-50'}`}>
      <p className="font-medium">
        {room.name} {b.flexMode === 'recliner' && <span className="text-xs text-stone-500">(recliner)</span>}
      </p>
      <p className="truncate">{guestLabel(b)}</p>
      <p className="truncate text-xs text-stone-600">
        {b.serviceCode} · {b.therapistName}
      </p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs font-medium tabular-nums">{left === null ? '' : left > 0 ? `${left} min left` : 'Time is up'}</span>
        <button type="button" className="rounded bg-teal-700 px-2 py-1 text-xs font-medium text-white hover:bg-teal-800" onClick={() => onDone(b)}>
          Done
        </button>
      </div>
    </div>
  );
}

function RotationPanel({ board }: { board: Board }) {
  return (
    <Card
      title="Rotation"
      actions={
        <Link to="/clock" className="text-sm font-medium text-teal-700 hover:underline">
          Clock-in Screen
        </Link>
      }
    >
      {board.rotation.length === 0 ? (
        <p className="text-sm text-stone-500">No therapists clocked in yet.</p>
      ) : (
        <ol className="space-y-2">
          {board.rotation.map((r) => (
            <li key={r.staffId} className={`flex items-center gap-3 rounded-md px-2 py-1.5 ${r.staffId === board.next ? 'bg-teal-50' : ''}`}>
              <span className="w-5 text-center font-semibold tabular-nums text-stone-400">{r.position}</span>
              <span className="flex-1 font-medium">
                {r.displayName} {r.therapistClass === 'lmt' && <Badge tone="teal">LMT</Badge>} {r.isOnCall && <Badge tone="amber">On-call</Badge>}
              </span>
              {r.staffId === board.next && <span className="text-xs font-semibold text-teal-800">Next</span>}
              {r.status === 'in_service' ? <Badge tone="amber">Busy</Badge> : <Badge>Free</Badge>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-stone-500">Done sends a therapist to the back, unless the guest asked for them.</p>
    </Card>
  );
}

function QueueLine({ b, onStart }: { b: Booking; onStart: (b: Booking) => void }) {
  const act = useDeskAction();
  const call = (path: string, body?: unknown) => act.mutate({ path: `/bookings/${b.id}/${path}`, body });
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="w-16 text-sm tabular-nums text-stone-500">{b.scheduledAt ? manilaTime(b.scheduledAt) : manilaTime(b.createdAt)}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {guestLabel(b)} {b.status === 'scheduled' && <Badge tone="amber">Booked</Badge>}
        </p>
        <p className="truncate text-xs text-stone-500">
          {b.serviceName} · {duration(b.durationMin)}
          {b.requestedTherapistName && ` · asked for ${b.requestedTherapistName}`}
          {b.notes && ` · ${b.notes}`}
        </p>
      </div>
      {b.status === 'scheduled' && (
        <>
          <Button variant="secondary" className="h-8 px-3" onClick={() => call('arrived')}>Arrived</Button>
          <Button variant="secondary" className="h-8 px-3" onClick={() => confirm(`Mark ${guestLabel(b)} as a no-show?`) && call('no-show')}>
            No-show
          </Button>
        </>
      )}
      <Button className="h-8 px-3" onClick={() => onStart(b)}>Start</Button>
      <button
        type="button"
        className="text-xs text-stone-500 underline"
        onClick={() => {
          const reason = prompt(`Why is ${guestLabel(b)}'s booking cancelled?`);
          if (reason && reason.trim().length >= 3) call('cancel', { reason });
        }}
      >
        Cancel
      </button>
    </li>
  );
}

function FrontDeskBoard() {
  const { data: board, error } = useBoard();
  const now = useNow();
  const done = useDeskAction();
  const [creating, setCreating] = useState<'walk_in' | 'scheduled' | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  if (error) return <Alert>{error.message}</Alert>;
  if (!board) return <p className="text-stone-500">Loading…</p>;

  const queue = board.bookings.filter((b) => b.status === 'waiting' || b.status === 'scheduled');
  const finished = board.bookings.filter((b) => b.status === 'done');
  const startingBooking = board.bookings.find((b) => b.id === starting);
  const markDone = (b: Booking) => done.mutate({ path: `/bookings/${b.id}/done` });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Front Desk</h1>
          <p className="text-sm text-stone-500">{longDate(board.day)}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setCreating('scheduled')}>Schedule booking</Button>
          <Button onClick={() => setCreating('walk_in')}>New walk-in</Button>
        </div>
      </div>
      {done.error && <Alert>{done.error.message}</Alert>}

      <div className="grid grid-cols-[1fr_18rem] gap-6">
        <div className="space-y-6">
          <section aria-label="Rooms" className="grid grid-cols-4 gap-3">
            {board.rooms.map((r) => (
              <RoomTile key={r.id} room={r} now={now} onDone={markDone} />
            ))}
          </section>

          <Card title={`Waiting and booked today (${queue.length})`}>
            {queue.length === 0 ? (
              <p className="text-sm text-stone-500">No one is waiting.</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {queue.map((b) => (
                  <QueueLine key={b.id} b={b} onStart={(x) => setStarting(x.id)} />
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Finished today (${finished.length})`}>
            {finished.length === 0 ? (
              <p className="text-sm text-stone-500">No services finished yet.</p>
            ) : (
              <ul className="divide-y divide-stone-100 text-sm">
                {finished.map((b) => (
                  <li key={b.id} className="flex gap-3 py-2">
                    <span className="w-28 tabular-nums text-stone-500">
                      {manilaTime(b.startedAt!)}–{manilaTime(b.doneAt!)}
                    </span>
                    <span className="flex-1">
                      {guestLabel(b)} · {b.serviceName}
                    </span>
                    <span className="text-stone-600">
                      {b.therapistName}
                      {b.requestedTherapistId === b.therapistId && b.therapistId ? ' (requested)' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <RotationPanel board={board} />
      </div>

      {creating && (
        <NewBookingDialog
          kind={creating}
          onClose={() => setCreating(null)}
          onNeedsAssignment={(id) => {
            setCreating(null);
            setStarting(id);
          }}
        />
      )}
      {startingBooking && <StartDialog booking={startingBooking} board={board} onClose={() => setStarting(null)} />}
    </div>
  );
}

export function HomePage() {
  const { data: user } = useCurrentUser();
  const canDesk = useCan('bookings.manage');
  if (canDesk) return <FrontDeskBoard />;
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Good day, {user?.firstName}</h1>
      <Card title="Front Desk">
        <p className="text-sm text-stone-600">The front desk tools are for receptionists and the owner.</p>
      </Card>
    </div>
  );
}
