import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Field, FormPanel, Input, Select, td, th } from '../components/ui';
import { api } from '../lib/api';
import { fromLocalInput, hoursBetween, manilaTime, toLocalInput, useClockStaff, useDtr, type DtrEntry } from '../lib/attendance';
import { useCan } from '../lib/auth';
import { businessDayOf } from '@spa/domain';
import { longDate } from '../lib/format';

function useDtrChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; method: string; body: unknown }) => api(req.path, { method: req.method, body: req.body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance'] }),
  });
}

type Draft = { staffId: string; clockIn: string; clockOut: string; reason: string };

function EntryForm({ entry, day, onDone }: { entry?: DtrEntry; day: string; onDone: () => void }) {
  const staff = useClockStaff();
  const canFixReceptionist = useCan('dtr.correct.receptionist');
  const [d, setD] = useState<Draft>({
    staffId: entry?.staffId ?? '',
    clockIn: entry ? toLocalInput(entry.clockIn) : `${day}T14:00`,
    clockOut: entry?.clockOut ? toLocalInput(entry.clockOut) : '',
    reason: '',
  });
  const change = useDtrChange();
  const set = <K extends keyof Draft>(k: K, v: string) => setD((x) => ({ ...x, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { clockIn: fromLocalInput(d.clockIn), clockOut: d.clockOut ? fromLocalInput(d.clockOut) : null, reason: d.reason };
    change.mutate(
      entry
        ? { path: `/dtr/${entry.id}`, method: 'PATCH', body }
        : { path: '/dtr', method: 'POST', body: { ...body, staffId: d.staffId } },
      { onSuccess: onDone },
    );
  }

  const choices = staff.data?.staff.filter((s) => s.kind === 'therapist' || canFixReceptionist) ?? [];

  return (
    <FormPanel onSubmit={submit}>
      {change.error && <Alert>{change.error.message}</Alert>}
      <div className="grid grid-cols-4 gap-3">
        <Field label="Staff">
          {entry ? (
            <Input disabled value={entry.displayName} />
          ) : (
            <Select required value={d.staffId} onChange={(e) => set('staffId', e.target.value)}>
              <option value="">Choose…</option>
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Clock in">
          <Input type="datetime-local" required value={d.clockIn} onChange={(e) => set('clockIn', e.target.value)} />
        </Field>
        <Field label="Clock out" hint="Leave blank if still here">
          <Input type="datetime-local" value={d.clockOut} onChange={(e) => set('clockOut', e.target.value)} />
        </Field>
        <Field label="Reason" hint="Required; kept in the audit log">
          <Input required minLength={3} value={d.reason} onChange={(e) => set('reason', e.target.value)} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={change.isPending}>{entry ? 'Save correction' : 'Add entry'}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

function EntryRow({ entry, day }: { entry: DtrEntry; day: string }) {
  const [editing, setEditing] = useState(false);
  const remove = useDtrChange();
  if (editing) {
    return (
      <tr>
        <td colSpan={6} className="py-2">
          <EntryForm entry={entry} day={day} onDone={() => setEditing(false)} />
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className={td}>
        <p className="font-medium">{entry.displayName}</p>
        <p className="text-xs text-stone-500">{entry.kind === 'receptionist' ? 'Receptionist' : 'Therapist'}</p>
      </td>
      <td className={`${td} whitespace-nowrap tabular-nums`}>{manilaTime(entry.clockIn)}</td>
      <td className={`${td} whitespace-nowrap tabular-nums`}>{entry.clockOut ? manilaTime(entry.clockOut) : <Badge tone="teal">Still in</Badge>}</td>
      <td className={`${td} whitespace-nowrap tabular-nums`}>{hoursBetween(entry.clockIn, entry.clockOut)}</td>
      <td className={td}>
        {entry.correctedAt ? (
          <span title={entry.correctionReason ?? ''}>
            <Badge tone="amber">{entry.source === 'manual' ? 'Added by hand' : 'Corrected'}</Badge>
            <span className="ml-2 text-xs text-stone-500">{entry.correctionReason}</span>
          </span>
        ) : (
          <Badge>PIN</Badge>
        )}
      </td>
      <td className={`${td} whitespace-nowrap text-right`}>
        {entry.canEdit && (
          <>
            <Button variant="secondary" className="h-8 px-3" onClick={() => setEditing(true)}>Correct</Button>{' '}
            <Button
              variant="danger"
              className="h-8 px-3"
              onClick={() => {
                const reason = prompt(`Why remove ${entry.displayName}'s entry?`);
                if (reason && reason.trim().length >= 3) remove.mutate({ path: `/dtr/${entry.id}`, method: 'DELETE', body: { reason } });
              }}
            >
              Remove
            </Button>
          </>
        )}
      </td>
    </tr>
  );
}

export function DtrPage() {
  const today = businessDayOf(new Date());
  const [day, setDay] = useState(today);
  const { data, error } = useDtr(day);
  const [adding, setAdding] = useState(false);

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Time Records</h1>
      <Card
        title={longDate(day)}
        actions={
          <div className="flex items-center gap-2">
            <div className="w-44">
              <Input type="date" aria-label="Business Day" value={day} max={today} onChange={(e) => setDay(e.target.value)} />
            </div>
            {!adding && <Button onClick={() => setAdding(true)}>Add missing entry</Button>}
          </div>
        }
      >
        <p className="mb-4 text-sm text-stone-500">
          Times after midnight count toward the day the shop opened. Every correction needs a reason and is logged.
        </p>
        {error && <Alert>{error.message}</Alert>}
        {adding && (
          <div className="mb-4">
            <EntryForm day={day} onDone={() => setAdding(false)} />
          </div>
        )}
        {data?.entries.length === 0 && <p className="text-sm text-stone-500">No one clocked in on this day.</p>}
        {!!data?.entries.length && (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Staff</th>
                <th className={th}>In</th>
                <th className={th}>Out</th>
                <th className={th}>Hours</th>
                <th className={th}>Source</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.entries.map((e) => <EntryRow key={e.id} entry={e} day={day} />)}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
