import { useState, type FormEvent } from 'react';
import { topUpNeeded } from '@spa/domain';
import { Alert, Button, Field, Input } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useCashAction, useCashSummary } from '../../lib/cash';
import { longDate, parsePesos, peso, pesosText } from '../../lib/format';

/** Sales Cash in the shop, and what to do with it: hold for Payroll and Laundry, hand over, or top up petty cash. */
export function CashReminder({ onHandover, onTopUp }: { onHandover: () => void; onTopUp: () => void }) {
  const summary = useCashSummary();
  const s = summary.data;
  if (!s) return null;
  const since = s.lastHandover ? ` since the handover on ${longDate(s.lastHandover.businessDay)}` : '';
  const tone = s.reminder === 'hand_over' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-stone-200 bg-white text-stone-700';
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm ${tone}`}>
      <span className="flex-1">
        {s.reminder === 'hand_over' ? (
          <>
            <span className="font-semibold">All payroll and laundry are paid: hand over {peso(s.salesCash)}</span> to the owner. Keep petty cash at ₱800.
          </>
        ) : (
          <>
            Sales cash in the shop: <span className="font-semibold">{peso(s.salesCash)}</span>
            {since}.{' '}
            {s.salesCash > 0 && 'Pay payroll and laundry from it, then hand the rest to the owner. Keep petty cash at ₱800.'}
          </>
        )}
        <span className="block text-xs opacity-80">
          Petty cash {peso(s.pettyCash)}
          {s.waiting.length > 0 && ` · ${s.waiting.length} handover${s.waiting.length === 1 ? '' : 's'} waiting for the owner to confirm`}
        </span>
      </span>
      {s.topUpDue > 0 && (
        <Button variant="secondary" className="h-8 px-3" onClick={onTopUp}>
          Top up petty cash {peso(s.topUpDue)}
        </Button>
      )}
      {s.salesCash > 0 && (
        <Button variant={s.reminder === 'hand_over' ? 'primary' : 'secondary'} className="h-8 px-3" onClick={onHandover}>
          Hand over cash
        </Button>
      )}
    </div>
  );
}

export function HandoverDialog({ onClose }: { onClose: () => void }) {
  const summary = useCashSummary();
  const save = useCashAction();
  const inShop = summary.data?.salesCash ?? 0;
  const [amount, setAmount] = useState(() => pesosText(inShop));
  const [note, setNote] = useState('');
  const centavos = parsePesos(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ path: '/cash/handovers', body: { amount: centavos, note: note || undefined } }, { onSuccess: onClose });
  }

  return (
    <Modal title="Hand over cash to the owner" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {save.error && <Alert>{save.error.message}</Alert>}
        <p className="text-sm text-stone-600">
          Sales cash that should be in the shop: <span className="font-semibold">{peso(inShop)}</span>. Hand over all of it; petty cash stays.
        </p>
        <div className="grid grid-cols-[10rem_1fr] gap-3">
          <Field label="Amount handed (₱)">
            <Input required autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Note (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="E.g. given to Marites" />
          </Field>
        </div>
        <p className="text-xs text-stone-500">It shows as “Waiting for owner” until the owner confirms receipt.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!centavos || save.isPending}>Record handover</Button>
        </div>
      </form>
    </Modal>
  );
}

export function TopUpDialog({ onClose }: { onClose: () => void }) {
  const summary = useCashSummary();
  const save = useCashAction();
  const needed = summary.data ? topUpNeeded(summary.data.pettyCash) : 0;
  const [amount, setAmount] = useState(() => pesosText(needed));
  const centavos = parsePesos(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ path: '/cash/petty-topups', body: { amount: centavos } }, { onSuccess: onClose });
  }

  return (
    <Modal title="Top up petty cash" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {save.error && <Alert>{save.error.message}</Alert>}
        <p className="text-sm text-stone-600">
          Petty cash has {peso(summary.data?.pettyCash ?? 0)}. Move {peso(needed)} from sales cash to bring it back to ₱800.
        </p>
        <Field label="Amount (₱)">
          <Input required autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!centavos || save.isPending}>Top up</Button>
        </div>
      </form>
    </Modal>
  );
}
