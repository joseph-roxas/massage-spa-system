import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { topUpTotal } from '@spa/domain';
import { Alert, Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import { useServices } from '../../lib/catalogue';
import { duration, peso } from '../../lib/format';
import { useDeskAction, type Board } from '../../lib/front-desk';

/** What these dialogs need of a Booking; checkout has less to hand than the board. */
export type ChangeTarget = { id: string; serviceId: string; serviceName: string; status: string; startedAt: string | null; durationMin: number };

type TopUpChoice = { price: number | null; hourPrice: number | null; steps: number };
type TopUpOptions = TopUpChoice & { eligible: boolean; parts: (TopUpChoice & { part: 'head' | 'back' | 'foot' })[] };

/** What adding `steps` costs on top of what's there, since two halves make a full hour. */
const addedCost = (c: TopUpChoice | undefined, steps: number) => (c && c.price !== null ? topUpTotal(c.steps + steps, c.price, c.hourPrice) - topUpTotal(c.steps, c.price, c.hourPrice) : null);

const PART_LABEL = { head: 'Head massage', back: 'Back massage', foot: 'Foot massage' } as const;
const STEPS = [1, 2, 3, 4];

/** A Top-up: more time on the same Service, with the same Therapist, in 30-minute steps. */
export function ServiceTopUpDialog({ booking, onClose }: { booking: ChangeTarget; onClose: () => void }) {
  const act = useDeskAction();
  const options = useQuery({ queryKey: ['top-up-options', booking.id, booking.serviceId], queryFn: () => api<TopUpOptions>(`/bookings/${booking.id}/top-up-options`), staleTime: 0 });
  const [steps, setSteps] = useState(1);
  const [part, setPart] = useState<'head' | 'back' | 'foot' | ''>('');
  const data = options.data;
  const picking = !!data?.parts.length;
  const adds = addedCost(picking ? data.parts.find((p) => p.part === part) : data, steps);

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: `/bookings/${booking.id}/top-up`, body: { steps, part: part || null } }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Add time · ${booking.serviceName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {(act.error || options.error) && <Alert>{(act.error ?? options.error)?.message}</Alert>}
        {data && !data.eligible && <Alert tone="info">A combo can’t be topped up. Add a service instead.</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="How much more">
            <Select value={steps} onChange={(e) => setSteps(Number(e.target.value))}>
              {STEPS.map((s) => (
                <option key={s} value={s}>
                  {duration(s * 30)}
                </option>
              ))}
            </Select>
          </Field>
          {picking && (
            <Field label="Which massage">
              <Select required value={part} onChange={(e) => setPart(e.target.value as typeof part)}>
                <option value="">Choose…</option>
                {data.parts.map((p) => (
                  <option key={p.part} value={p.part}>
                    {PART_LABEL[p.part]} · {peso(addedCost(p, steps))}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {adds !== null && (
          <p className="text-sm">
            Adds <span className="font-semibold tabular-nums">{peso(adds)}</span> to the bill.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Go back</Button>
          <Button type="submit" disabled={act.isPending || !data?.eligible || (picking && !part)}>Add time</Button>
        </div>
      </form>
    </Modal>
  );
}

const CHOICE = 'block w-full rounded-lg border-2 border-teal-700 px-4 py-3 text-left hover:bg-teal-50';

/** The one question the Service button asks, because changing and adding charge the Guest differently. */
export function ServiceChoiceDialog({ booking, onChange, onAdd, onClose }: { booking: ChangeTarget; onChange: () => void; onAdd: () => void; onClose: () => void }) {
  return (
    <Modal title={booking.serviceName} onClose={onClose}>
      <div className="space-y-3">
        <button type="button" className={CHOICE} onClick={onChange}>
          <span className="block text-base font-semibold text-teal-900">Change to a different service</span>
          <span className="block text-sm text-stone-600">The guest pays only for the new one.</span>
        </button>
        <button type="button" className={CHOICE} onClick={onAdd}>
          <span className="block text-base font-semibold text-teal-900">Add another service after this</span>
          <span className="block text-sm text-stone-600">The guest pays for both.</span>
        </button>
      </div>
    </Modal>
  );
}

/** A Service Change: the sale becomes the new Service at its full price. */
export function ChangeServiceDialog({ booking, onClose }: { booking: ChangeTarget; onClose: () => void }) {
  const services = useServices();
  const act = useDeskAction();
  const [serviceId, setServiceId] = useState('');
  const [reason, setReason] = useState('');
  const [openedAt] = useState(() => Date.now());
  const offered = (services.data?.services ?? []).filter((s) => s.active && s.id !== booking.serviceId);
  const picked = offered.find((s) => s.id === serviceId);
  const used = booking.status === 'in_service' && booking.startedAt ? Math.round((openedAt - new Date(booking.startedAt).getTime()) / 60_000) : 0;
  const tooShort = !!picked && used > picked.durationMin;

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: `/bookings/${booking.id}/change-service`, body: { serviceId, reason } }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Change service · ${booking.serviceName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-stone-600">The guest pays only for the new service. It counts from when the service started, and any added time is cleared.</p>
        {act.error && <Alert>{act.error.message}</Alert>}
        <Field label="New service">
          <Select required autoFocus value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Choose a service…</option>
            {offered.map((s) => (
              <option key={s.id} value={s.id}>
                {s.kind === 'combo' ? `${s.code} ` : ''}
                {s.name} · {duration(s.durationMin)} · {peso(s.currentPrice)}
              </option>
            ))}
          </Select>
        </Field>
        {tooShort && <Alert tone="info">{used} minutes have already passed, which is longer than this service.</Alert>}
        <Field label="Reason" hint="Kept in the audit log">
          <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Go back</Button>
          <Button type="submit" disabled={act.isPending || !serviceId}>Change service</Button>
        </div>
      </form>
    </Modal>
  );
}

/** A Therapist Change: someone else takes over; the clock keeps running. */
export function ChangeTherapistDialog({ booking, currentName, board, onClose }: { booking: ChangeTarget; currentName: string | null; board: Board; onClose: () => void }) {
  const act = useDeskAction();
  const [therapistId, setTherapistId] = useState('');
  const [reason, setReason] = useState('');
  const [guestNamed, setGuestNamed] = useState(false);
  const free = board.rotation.filter((r) => r.status === 'free' && !r.reservedFor);

  function submit(e: FormEvent) {
    e.preventDefault();
    act.mutate({ path: `/bookings/${booking.id}/change-therapist`, body: { therapistId, reason, guestNamed } }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Change therapist · ${currentName ?? ''}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-stone-600">
          The new therapist earns the whole Commission and the time keeps running. {currentName} earns nothing for this service and keeps their place in the Rotation.
        </p>
        {act.error && <Alert>{act.error.message}</Alert>}
        {free.length === 0 && <Alert tone="info">No other therapist is free right now.</Alert>}
        <Field label="New therapist">
          <Select required autoFocus value={therapistId} onChange={(e) => setTherapistId(e.target.value)}>
            <option value="">Choose…</option>
            {free.map((r) => (
              <option key={r.staffId} value={r.staffId}>
                {r.position}. {r.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label="The guest asked for this therapist by name" checked={guestNamed} onChange={(e) => setGuestNamed(e.target.checked)} />
        <Field label="Reason" hint="Shown in reports">
          <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="E.g. pressure too strong" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Go back</Button>
          <Button type="submit" disabled={act.isPending || !therapistId}>Change therapist</Button>
        </div>
      </form>
    </Modal>
  );
}
