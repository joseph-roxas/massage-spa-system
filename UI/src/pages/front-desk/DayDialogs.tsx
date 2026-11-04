import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { manilaTime } from '../../lib/attendance';
import { longDate, parsePesos, peso } from '../../lib/format';
import { CASH_OUT_CATEGORIES, FORM_CASH_OUTS, useCashOuts, useClosePreview, useDayAction } from '../../lib/sales';

export function CashOutDialog({ day, onClose }: { day: string; onClose: () => void }) {
  const list = useCashOuts(day);
  const save = useDayAction();
  const remove = useDayAction();
  const [category, setCategory] = useState<keyof typeof FORM_CASH_OUTS>('petty_cash');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const centavos = parsePesos(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      { path: '/cash-outs', body: { category, amount: centavos, purpose } },
      {
        onSuccess: () => {
          setAmount('');
          setPurpose('');
        },
      },
    );
  }

  const rows = list.data?.cashOuts ?? [];
  return (
    <Modal title="Cash-outs" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {(save.error || remove.error) && <Alert>{(save.error ?? remove.error)?.message}</Alert>}
        <div className="grid grid-cols-[1fr_8rem] gap-3">
          <Field label="What for">
            <Input required minLength={3} autoFocus value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="E.g. rice for staff" />
          </Field>
          <Field label="Amount (₱)">
            <Input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        <Field label="Category" hint={FORM_CASH_OUTS[category].hint}>
          <Select value={category} onChange={(e) => setCategory(e.target.value as keyof typeof FORM_CASH_OUTS)}>
            {Object.keys(FORM_CASH_OUTS).map((k) => (
              <option key={k} value={k}>
                {CASH_OUT_CATEGORIES[k as keyof typeof FORM_CASH_OUTS]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Done</Button>
          <Button type="submit" disabled={!centavos || save.isPending}>Record Cash-out</Button>
        </div>
      </form>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-stone-700">Today</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No Cash-outs yet.</p>
      ) : (
        <ul className="divide-y divide-stone-100 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <span className="w-16 tabular-nums text-stone-500">{manilaTime(r.createdAt)}</span>
              <span className="flex-1">
                {r.purpose} <span className="text-xs text-stone-500">· {CASH_OUT_CATEGORIES[r.category]}</span>
              </span>
              <span className="tabular-nums">{peso(r.amount)}</span>
              {r.category !== 'on_call_commission' && r.category !== 'cash_advance' && (
                <button
                  type="button"
                  className="text-xs text-stone-500 underline"
                  onClick={() => confirm(`Remove “${r.purpose}”?`) && remove.mutate({ path: `/cash-outs/${r.id}`, method: 'DELETE' })}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function EarlyCloseDialog({ onClose }: { onClose: () => void }) {
  const save = useDayAction();
  const [reason, setReason] = useState('');
  return (
    <Modal title="Early Close" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ path: '/days/current/early-close', body: { reason } }, { onSuccess: onClose });
        }}
      >
        <p className="text-sm text-stone-600">
          Closing before 11:00 PM. Time after now won’t count as your undertime, unless the owner rejects this.
        </p>
        {save.error && <Alert>{save.error.message}</Alert>}
        <Field label="Why are we closing early?">
          <Input required minLength={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={save.isPending}>Record Early Close</Button>
        </div>
      </form>
    </Modal>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function DayCloseDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const preview = useClosePreview(date);
  const save = useDayAction();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const p = preview.data;
  const countedCash = parsePesos(counted);
  const variance = p && countedCash !== null ? countedCash - p.totals.expectedCash : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ path: `/days/${date}/close`, body: { countedCash, note: note || undefined } }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Day Close · ${longDate(date)}`} onClose={onClose}>
      {preview.error && <Alert>{preview.error.message}</Alert>}
      {!p ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : p.blockers.length > 0 ? (
        <div className="space-y-4">
          <Alert tone="info">Finish these guests first, then close the day.</Alert>
          <ul className="divide-y divide-stone-100 text-sm">
            {p.blockers.map((b) => (
              <li key={b.bookingId} className="flex justify-between py-2">
                <span>
                  {b.guest} · {b.service}
                </span>
                <span className="text-amber-700">{b.problem}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>Back to the Front Desk</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {save.error && <Alert>{save.error.message}</Alert>}
          <div className="space-y-1 rounded-lg bg-stone-50 p-4 text-sm">
            <Line label={`Guests checked out`} value={String(p.guests)} />
            <Line label="Sales cash already in the shop" value={peso(p.totals.carriedIn)} />
            <Line label="Cash received" value={peso(p.totals.cashIn)} />
            <Line label="Cash-outs from sales cash" value={`−${peso(p.totals.cashOut - p.owed.reduce((s, o) => s + o.amount, 0))}`} />
            {p.totals.transfersOut > 0 && <Line label="Payroll, petty cash top-up, handed to owner" value={`−${peso(p.totals.transfersOut)}`} />}
            {p.owed.map((o) => (
              <Line key={o.staffId} label={`On-call pay: ${o.displayName} (pay now)`} value={`−${peso(o.amount)}`} />
            ))}
            <div className="border-t border-stone-200 pt-1">
              <Line label="Sales cash expected in the shop" value={peso(p.totals.expectedCash)} strong />
            </div>
            <Line label="GCash received" value={peso(p.totals.expectedGcash)} />
            {p.vouchersSold > 0 && (
              <p className="pt-1 text-xs text-stone-500">Includes {peso(p.vouchersSold)} from vouchers sold today.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Cash counted (₱)"
              hint={variance === null ? 'Count all sales cash in the shop, not the ₱800 petty cash' : variance === 0 ? 'Matches' : variance > 0 ? `Over by ${peso(variance)}` : `Short by ${peso(-variance)}`}
            >
              <Input required autoFocus inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
            </Field>
            <Field label={variance ? 'Why is it different?' : 'Note (optional)'}>
              <Input required={!!variance} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-stone-500">After closing, this day’s sales are locked. Only the owner can reopen it.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Not yet</Button>
            <Button type="submit" disabled={countedCash === null || save.isPending}>Close the day</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
