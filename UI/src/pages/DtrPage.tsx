import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { fromLocalInput, hoursBetween, manilaTime, toLocalInput, useClockStaff, useDtr, type DtrEntry } from '../lib/attendance';
import { useCan } from '../lib/auth';
import { businessDayOf } from '@spa/domain';
import { longDate } from '../lib/format';

function useDtrChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; method: string; body: unknown }) => api(req.path, { method: req.method, body: req.body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['dtr-review'] });
      qc.invalidateQueries({ queryKey: ['attention'] });
    },
  });
}

type BatchRow = { day: string; inAt: string; outAt: string; reason: string };

/** A Manila date and times to ISO instants; a time out before the time in is after midnight. */
function rowTimes(r: BatchRow) {
  const clockIn = fromLocalInput(`${r.day}T${r.inAt}`);
  if (!r.outAt) return { clockIn, clockOut: null };
  let clockOut = fromLocalInput(`${r.day}T${r.outAt}`);
  if (clockOut <= clockIn) clockOut = new Date(new Date(clockOut).getTime() + 86_400_000).toISOString();
  return { clockIn, clockOut };
}

const nextDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Several missing entries for one person at once, e.g. copied from the paper DTR; saved together or not at all. */
function BatchForm({ day, onDone }: { day: string; onDone: () => void }) {
  const staff = useClockStaff();
  const canFixReceptionist = useCan('dtr.correct.receptionist');
  const change = useDtrChange();
  const [staffId, setStaffId] = useState('');
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState<BatchRow[]>([{ day, inAt: '14:00', outAt: '23:00', reason: '' }]);
  const [isRelief, setRelief] = useState(false);
  const kind = staff.data?.staff.find((s) => s.id === staffId)?.kind;
  const problems = change.error instanceof ApiError ? ((change.error.body.problems as { index: number; message: string }[] | undefined) ?? []) : [];
  const setRow = (i: number, r: Partial<BatchRow>) => setRows((all) => all.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const choices = staff.data?.staff.filter((s) => s.kind === 'therapist' || canFixReceptionist) ?? [];
  const last = rows[rows.length - 1]!;

  function submit(e: FormEvent) {
    e.preventDefault();
    change.mutate(
      { path: '/dtr/batch', method: 'POST', body: { staffId, reason, isRelief, rows: rows.map((r) => ({ ...rowTimes(r), ...(r.reason.trim() ? { reason: r.reason } : {}) })) } },
      { onSuccess: onDone },
    );
  }

  return (
    <FormPanel onSubmit={submit}>
      {change.error && <Alert>{change.error.message}</Alert>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Staff">
          <Select required value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason for all rows" hint="Required; a row can give its own instead">
          <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="E.g. copied from the paper DTR" />
        </Field>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Business Day</th>
            <th className={th}>In</th>
            <th className={th}>Out</th>
            <th className={th}>Own reason (optional)</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const problem = problems.find((p) => p.index === i);
            return (
              <tr key={i} className={problem ? 'bg-red-50' : ''}>
                <td className={td}>
                  <Input type="date" required value={r.day} onChange={(e) => setRow(i, { day: e.target.value })} />
                  {problem && <p className="mt-1 text-xs text-red-700">{problem.message}</p>}
                </td>
                <td className={td}>
                  <Input type="time" required value={r.inAt} onChange={(e) => setRow(i, { inAt: e.target.value })} />
                </td>
                <td className={td}>
                  <Input type="time" value={r.outAt} onChange={(e) => setRow(i, { outAt: e.target.value })} />
                </td>
                <td className={td}>
                  <Input value={r.reason} onChange={(e) => setRow(i, { reason: e.target.value })} />
                </td>
                <td className={`${td} text-right`}>
                  {rows.length > 1 && (
                    <button type="button" className="text-xs text-stone-500 underline" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-stone-500">A time out earlier than the time in is after midnight. Leave Out blank only if they are still here.</p>
      {kind === 'therapist' && <Checkbox label="Relief Shifts: ran the front desk on these days" checked={isRelief} onChange={(e) => setRelief(e.target.checked)} />}
      <div className="flex gap-2">
        <Button type="button" variant="secondary" disabled={rows.length >= 14} onClick={() => setRows((all) => [...all, { ...last, day: nextDay(last.day), reason: '' }])}>
          + Another day
        </Button>
        <span className="flex-1" />
        <Button type="submit" disabled={change.isPending}>
          Save {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </FormPanel>
  );
}

type ReviewEntry = DtrEntry & { reviewedAt: string | null };

/** One flagged entry; the Super Admin can tick it, or correct or remove it on the spot. */
function ReviewRow({ entry: e, picked, onPick, act }: { entry: ReviewEntry; picked: boolean; onPick: (on: boolean) => void; act: ReturnType<typeof useDtrChange> }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <tr>
        <td colSpan={7} className="py-2">
          <EntryForm entry={e} day={e.businessDay} onDone={() => setEditing(false)} />
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className={td}>
        {e.reviewedAt ? <Badge>Reviewed</Badge> : <input type="checkbox" aria-label={`Pick ${e.displayName} on ${e.businessDay}`} checked={picked} onChange={(ev) => onPick(ev.target.checked)} />}
      </td>
      <td className={`${td} whitespace-nowrap`}>{longDate(e.businessDay)}</td>
      <td className={td}>{e.displayName}</td>
      <td className={`${td} whitespace-nowrap tabular-nums`}>{manilaTime(e.clockIn)}</td>
      <td className={`${td} whitespace-nowrap tabular-nums`}>{e.clockOut ? manilaTime(e.clockOut) : <Badge tone="red">No clock-out</Badge>}</td>
      <td className={td}>
        {e.correctedAt ? (
          <>
            <Badge tone="amber">{e.source === 'manual' ? 'Added by hand' : 'Corrected'}</Badge>
            <span className="ml-2 text-xs text-stone-500">{e.correctionReason}</span>
          </>
        ) : e.autoClockOut ? (
          <span className="text-xs text-stone-500">Forgot to clock out; check the time out</span>
        ) : (
          <span className="text-xs text-stone-500">Never clocked out</span>
        )}
        {e.autoClockOut && (
          <span className="ml-2">
            <Badge tone="amber">Auto clock-out</Badge>
          </span>
        )}
      </td>
      <td className={`${td} whitespace-nowrap text-right`}>
        <Button variant="secondary" className="h-8 px-3" onClick={() => setEditing(true)}>Edit</Button>{' '}
        <Button
          variant="danger"
          className="h-8 px-3"
          onClick={() => {
            const reason = prompt(`Why remove ${e.displayName}'s entry?`);
            if (reason && reason.trim().length >= 3) act.mutate({ path: `/dtr/${e.id}`, method: 'DELETE', body: { reason } });
          }}
        >
          Remove
        </Button>
      </td>
    </tr>
  );
}

/** The Super Admin's DTR Review: entries added by hand, corrected or never clocked out, whatever their date. */
function ReviewTab() {
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const { data, error } = useQuery({ queryKey: ['dtr-review', all], queryFn: () => api<{ entries: ReviewEntry[] }>(`/dtr/review${all ? '?all=1' : ''}`) });
  const mark = useDtrChange();
  const entries = data?.entries ?? [];
  const open = entries.filter((e) => !e.reviewedAt);
  const problem = error ?? mark.error;

  return (
    <Card
      title={all ? 'Every flagged time record' : `To review (${open.length})`}
      actions={
        <div className="flex items-center gap-3">
          <Checkbox label="Show reviewed too" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <Button
            disabled={!picked.length || mark.isPending}
            onClick={() => mark.mutate({ path: '/dtr/review', method: 'POST', body: { ids: picked } }, { onSuccess: () => setPicked([]) })}
          >
            Mark {picked.length || ''} reviewed
          </Button>
        </div>
      }
    >
      <p className="mb-4 text-sm text-stone-500">Entries added by hand, corrected, or never clocked out on an earlier day. Edit one here and your version stands: it counts as reviewed, and the receptionist can no longer change it.</p>
      {problem && <Alert>{problem.message}</Alert>}
      {entries.length === 0 ? (
        <p className="text-sm text-stone-500">Nothing to review.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>
                <input
                  type="checkbox"
                  aria-label="Pick all"
                  checked={open.length > 0 && picked.length === open.length}
                  onChange={(e) => setPicked(e.target.checked ? open.map((x) => x.id) : [])}
                />
              </th>
              <th className={th}>Day</th>
              <th className={th}>Staff</th>
              <th className={th}>In</th>
              <th className={th}>Out</th>
              <th className={th}>Why</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {entries.map((e) => (
              <ReviewRow key={e.id} entry={e} picked={picked.includes(e.id)} onPick={(on) => setPicked((p) => (on ? [...p, e.id] : p.filter((x) => x !== e.id)))} act={mark} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

type Draft = { staffId: string; clockIn: string; clockOut: string; reason: string; isRelief: boolean };

function EntryForm({ entry, day, onDone }: { entry?: DtrEntry; day: string; onDone: () => void }) {
  const staff = useClockStaff();
  const canFixReceptionist = useCan('dtr.correct.receptionist');
  const [d, setD] = useState<Draft>({
    staffId: entry?.staffId ?? '',
    clockIn: entry ? toLocalInput(entry.clockIn) : `${day}T14:00`,
    clockOut: entry?.clockOut ? toLocalInput(entry.clockOut) : '',
    reason: '',
    isRelief: entry?.isRelief ?? false,
  });
  const change = useDtrChange();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const kind = entry?.kind ?? staff.data?.staff.find((s) => s.id === d.staffId)?.kind;

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { clockIn: fromLocalInput(d.clockIn), clockOut: d.clockOut ? fromLocalInput(d.clockOut) : null, reason: d.reason, isRelief: d.isRelief };
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
      {kind === 'therapist' && (
        <Checkbox label="Relief Shift: ran the front desk (paid the Minimum Wage Rate, out of the Rotation)" checked={d.isRelief} onChange={(e) => set('isRelief', e.target.checked)} />
      )}
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
        <p className="text-xs text-stone-500">
          {entry.kind === 'receptionist' ? 'Receptionist' : entry.kind === 'reliever' ? 'Outside Reliever' : 'Therapist'}
          {entry.isRelief && (
            <>
              {' '}
              <Badge tone="teal">Relief</Badge>
            </>
          )}
        </p>
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
        ) : entry.autoClockOut ? null : (
          <Badge>PIN</Badge>
        )}
        {entry.autoClockOut && (
          <span className="ml-2">
            <Badge tone="amber">Auto clock-out</Badge>
          </span>
        )}
      </td>
      <td className={`${td} whitespace-nowrap text-right`}>
        {entry.lockedAs && <Badge>{entry.lockedAs === 'corrected' ? 'Corrected by the owner' : 'Checked by the owner'}</Badge>}
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

const TABS = [
  ['day', 'By day'],
  ['review', 'To review'],
] as const;

export function DtrPage() {
  const today = businessDayOf(new Date());
  const [day, setDay] = useState(today);
  const { data, error } = useDtr(day);
  const [adding, setAdding] = useState<'one' | 'several' | null>(null);
  const canReview = useCan('dtr.correct.receptionist');
  const [params, setParams] = useSearchParams();
  const tab = canReview && params.get('tab') === 'review' ? 'review' : 'day';

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Time Records</h1>
        {canReview && (
          <div className="flex rounded-md border border-stone-300 bg-white p-0.5 text-sm">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setParams(key === 'review' ? { tab: 'review' } : {})}
                className={`rounded px-3 py-1.5 ${tab === key ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {tab === 'review' && <ReviewTab />}
      {tab === 'day' && (
      <Card
        title={longDate(day)}
        actions={
          <div className="flex items-center gap-2">
            <div className="w-44">
              <Input type="date" aria-label="Business Day" value={day} max={today} onChange={(e) => setDay(e.target.value)} />
            </div>
            {!adding && (
              <>
                <Button variant="secondary" onClick={() => setAdding('one')}>
                  Add missing entry
                </Button>
                <Button onClick={() => setAdding('several')}>Add several days</Button>
              </>
            )}
          </div>
        }
      >
        <p className="mb-4 text-sm text-stone-500">
          Times after midnight count toward the day the shop opened. Every correction needs a reason and is logged.
        </p>
        {error && <Alert>{error.message}</Alert>}
        {adding && (
          <div className="mb-4">
            {adding === 'one' ? <EntryForm day={day} onDone={() => setAdding(null)} /> : <BatchForm day={day} onDone={() => setAdding(null)} />}
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
      )}
    </div>
  );
}
