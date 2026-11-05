import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card } from '../components/ui';
import { useCan, useCurrentUser } from '../lib/auth';
import { manilaTime } from '../lib/attendance';
import { duration, longDate, peso } from '../lib/format';
import { guestLabel, useBoard, useDeskAction, type Board, type Booking } from '../lib/front-desk';
import { useDayAction } from '../lib/sales';
import { CheckoutDialog } from './front-desk/CheckoutDialog';
import { CashReminder, HandoverDialog, NeedsAttention, TopUpDialog } from './front-desk/CashDialogs';
import { CashOutDialog, DayCloseDialog, EarlyCloseDialog } from './front-desk/DayDialogs';
import { SellVouchersDialog } from './front-desk/SellVouchersDialog';
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
      <p className="truncate">
        {guestLabel(b)} {b.guestIsRegular && <Badge tone="teal">Regular</Badge>}
      </p>
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
          {guestLabel(b)} {b.guestIsRegular && <Badge tone="teal">Regular</Badge>} {b.status === 'scheduled' && <Badge tone="amber">Booked</Badge>}
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

type DayDialog = 'cash-outs' | 'early-close' | 'vouchers' | 'handover' | 'top-up' | { close: string } | null;

/** Business Day status and its end-of-day actions. */
function DayBar({ board, open }: { board: Board; open: (d: DayDialog) => void }) {
  const isAdmin = useCan('day.reopen');
  const act = useDayAction();
  const d = board.businessDay;
  const closed = !!d?.closedAt;
  const withReason = (question: string, path: string) => {
    const reason = prompt(question);
    if (reason && reason.trim().length >= 3) act.mutate({ path, body: { reason } });
  };

  return (
    <div className="space-y-3">
      {board.unclosed.map((date) => (
        <Alert key={date}>
          <span className="flex items-center justify-between gap-4">
            <span>The Business Day of {longDate(date)} was never closed. Close it before taking new guests.</span>
            <Button className="h-8 px-3" onClick={() => open({ close: date })}>Close it now</Button>
          </span>
        </Alert>
      ))}
      {act.error && <Alert>{act.error.message}</Alert>}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm">
        <span className="font-medium">
          {closed ? (
            <Badge tone="red">Closed</Badge>
          ) : d ? (
            <Badge tone="teal">Open since {manilaTime(d.openedAt)}</Badge>
          ) : (
            <Badge>Not opened yet</Badge>
          )}
        </span>
        {d?.earlyCloseStatus && (
          <span className="text-stone-600">
            Early Close at {manilaTime(d.earlyCloseAt!)}: {d.earlyCloseReason}{' '}
            {d.earlyCloseStatus === 'rejected' && <Badge tone="red">Rejected</Badge>}
          </span>
        )}
        {closed && d.variance !== null && (
          <span className="text-stone-600">
            Counted {peso(d.countedCash)} · {d.variance === 0 ? 'no variance' : d.variance > 0 ? `over ${peso(d.variance)}` : `short ${peso(-d.variance)}`}
          </span>
        )}
        <span className="flex-1" />
        {!closed && (
          <>
            <Button variant="secondary" className="h-8 px-3" onClick={() => open('vouchers')}>Sell vouchers</Button>
            <Button variant="secondary" className="h-8 px-3" onClick={() => open('cash-outs')}>Cash-outs</Button>
            {!d?.earlyCloseStatus && (
              <Button variant="secondary" className="h-8 px-3" onClick={() => open('early-close')}>Early Close</Button>
            )}
            {d && <Button className="h-8 px-3" onClick={() => open({ close: d.date })}>Close the day</Button>}
          </>
        )}
        {isAdmin && d?.earlyCloseStatus === 'recorded' && (
          <Button variant="secondary" className="h-8 px-3" onClick={() => withReason('Why reject this Early Close?', `/days/${d.date}/early-close/reject`)}>
            Reject Early Close
          </Button>
        )}
        {isAdmin && closed && (
          <Button variant="secondary" className="h-8 px-3" onClick={() => withReason(`Why reopen ${longDate(d.date)}?`, `/days/${d.date}/reopen`)}>
            Reopen day
          </Button>
        )}
      </div>
    </div>
  );
}

function FrontDeskBoard() {
  const { data: board, error } = useBoard();
  const now = useNow();
  const done = useDeskAction();
  const [creating, setCreating] = useState<'walk_in' | 'scheduled' | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [dayDialog, setDayDialog] = useState<DayDialog>(null);
  const canCash = useCan('cashouts.record');
  const isOwner = useCan('settings.manage');
  // Arriving from a blocked logout opens Day Close straight away.
  const [params, setParams] = useSearchParams();
  const wantsClose = params.has('close');
  const dayToClose = board ? (board.unclosed[0] ?? board.day) : null;
  useEffect(() => {
    if (!wantsClose || !dayToClose) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hand-off from the logout guard
    setDayDialog({ close: dayToClose });
    setParams({}, { replace: true });
  }, [wantsClose, dayToClose, setParams]);

  if (error) return <Alert>{error.message}</Alert>;
  if (!board) return <p className="text-stone-500">Loading…</p>;

  const queue = board.bookings.filter((b) => b.status === 'waiting' || b.status === 'scheduled');
  const finished = board.bookings.filter((b) => b.status === 'done');
  const startingBooking = board.bookings.find((b) => b.id === starting);
  const payingBooking = board.bookings.find((b) => b.id === paying);
  const unpaid = finished.filter((b) => !b.sale).length;
  // Done hands straight over to checkout, since the guest pays on the way out.
  const markDone = (b: Booking) => done.mutate({ path: `/bookings/${b.id}/done` }, { onSuccess: () => setPaying(b.id) });

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
      <DayBar board={board} open={setDayDialog} />
      <NeedsAttention enabled={isOwner} />
      {canCash && <CashReminder onHandover={() => setDayDialog('handover')} onTopUp={() => setDayDialog('top-up')} />}
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

          <Card title={`Finished today (${finished.length})${unpaid ? ` · ${unpaid} to check out` : ''}`}>
            {finished.length === 0 ? (
              <p className="text-sm text-stone-500">No services finished yet.</p>
            ) : (
              <ul className="divide-y divide-stone-100 text-sm">
                {finished.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 py-2">
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
                    <span className="w-28 text-right">
                      {b.sale ? (
                        <span className="tabular-nums text-stone-700">
                          {b.sale.discountType === 'complimentary' ? 'Complimentary' : peso(b.sale.amountDue)}
                        </span>
                      ) : (
                        <Button className="h-7 px-3" onClick={() => setPaying(b.id)}>Checkout</Button>
                      )}
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
      {payingBooking && <CheckoutDialog booking={payingBooking} onClose={() => setPaying(null)} />}
      {dayDialog === 'cash-outs' && <CashOutDialog day={board.day} onClose={() => setDayDialog(null)} />}
      {dayDialog === 'early-close' && <EarlyCloseDialog onClose={() => setDayDialog(null)} />}
      {dayDialog === 'handover' && <HandoverDialog onClose={() => setDayDialog(null)} />}
      {dayDialog === 'top-up' && <TopUpDialog onClose={() => setDayDialog(null)} />}
      {dayDialog === 'vouchers' && <SellVouchersDialog onClose={() => setDayDialog(null)} />}
      {dayDialog && typeof dayDialog === 'object' && <DayCloseDialog date={dayDialog.close} onClose={() => setDayDialog(null)} />}
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
