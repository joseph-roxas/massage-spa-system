import { useState, type FormEvent } from 'react';
import { topUpNeeded } from '@spa/domain';
import { Alert, Button, Field, Input } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useCashAction, useCashSummary } from '../../lib/cash';
import { useAttention } from '../../lib/attention';
import { Link } from 'react-router';
import { longDate, parsePesos, peso, pesosText } from '../../lib/format';

/** "3 hours" or "2 days" since an instant. */
function dueFor(since: string, now: number): string {
  const hours = Math.max(0, Math.floor((now - new Date(since).getTime()) / 3_600_000));
  if (hours < 1) return 'just now';
  const days = Math.floor(hours / 24);
  return days ? `${days} day${days === 1 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Sales Cash in the shop, and what to do with it: hold for Payroll and Laundry, hand over, or top up petty cash. */
export function CashReminder({ onHandover, onTopUp }: { onHandover: () => void; onTopUp: () => void }) {
  const summary = useCashSummary();
  const [now] = useState(() => Date.now());
  const s = summary.data;
  if (!s) return null;
  const since = s.lastHandover ? ` since the handover on ${longDate(s.lastHandover.businessDay)}` : '';
  const footnote = (
    <span className="block text-xs opacity-80">
      Petty cash {peso(s.pettyCash)}
      {s.waiting.length > 0 && ` · ${s.waiting.length} handover${s.waiting.length === 1 ? '' : 's'} waiting for the owner to confirm`}
    </span>
  );
  const topUp = s.topUpDue > 0 && (
    <Button variant="secondary" className="h-8 px-3" onClick={onTopUp}>
      Top up petty cash {peso(s.topUpDue)}
    </Button>
  );

  if (s.reminder === 'hand_over') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-4 rounded-lg bg-red-700 px-5 py-4 text-white shadow-md">
        <span className="min-w-64 flex-1">
          <span className="block text-xl font-bold">Hand over {peso(s.salesCash)} to the owner now</span>
          <span className="block text-sm">
            {s.relief ? 'End of your Relief Shift: after Day Close, hand over all Sales Cash.' : 'All payroll and laundry are paid.'} Keep petty cash at ₱800.
            {s.dueSince && dueFor(s.dueSince, now) !== 'just now' && <span className="font-semibold"> Due for {dueFor(s.dueSince, now)}.</span>}
          </span>
          {footnote}
        </span>
        {topUp}
        <button type="button" className="h-12 rounded-md bg-white px-6 text-base font-bold text-red-700 hover:bg-red-50" onClick={onHandover}>
          Hand over cash
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
      <span className="flex-1">
        Sales cash in the shop: <span className="font-semibold">{peso(s.salesCash)}</span>
        {since}. {s.salesCash > 0 && 'Pay payroll and laundry from it, then hand the rest to the owner. Keep petty cash at ₱800.'}
        {footnote}
      </span>
      {topUp}
      {s.salesCash > 0 && (
        <Button variant="secondary" className="h-8 px-3" onClick={onHandover}>
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
  // Left empty on purpose: she types what she actually counted out, not what the system expects.
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const centavos = parsePesos(amount);
  const short = centavos !== null && centavos < inShop ? inShop - centavos : 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ path: '/cash/handovers', body: { amount: centavos, note: note || undefined } }, { onSuccess: onClose });
  }

  return (
    <Modal title="Hand over cash to the owner" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {save.error && <Alert>{save.error.message}</Alert>}
        <p className="text-sm text-stone-600">
          Sales cash that should be in the shop: <span className="font-semibold">{peso(inShop)}</span>. Count the cash you are handing over and type that amount;
          petty cash stays.
        </p>
        <div className="grid grid-cols-[10rem_1fr] gap-3">
          <Field label="Amount counted out (₱)" hint={short ? `${peso(short)} less than expected` : undefined}>
            <Input required autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={short ? 'Why is it less?' : 'Note (optional)'}>
            <Input required={short > 0} value={note} onChange={(e) => setNote(e.target.value)} placeholder={short ? 'E.g. kept for laundry, or short' : 'E.g. given to Marites'} />
          </Field>
        </div>
        {short > 0 && (
          <Alert>
            You are handing over {peso(short)} less than the system expects. Say where the rest is: still in the drawer, paid out for something, or missing.
          </Alert>
        )}
        <p className="text-xs text-stone-500">It shows as “Waiting for owner” until the owner confirms receipt.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!centavos || (short > 0 && note.trim().length < 3) || save.isPending}>Record handover</Button>
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

/** Everything waiting on the owner, urgent first; each links to where it is done. */
export function NeedsAttention({ enabled }: { enabled: boolean }) {
  const { data } = useAttention(enabled);
  const items = data?.items ?? [];
  if (!enabled || !items.length) return null;
  return (
    <section aria-label="Needs attention" className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm">
      <h2 className="mb-2 font-semibold text-amber-900">Needs attention ({items.length})</h2>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.key} className="flex flex-wrap items-baseline gap-x-2">
            <span className={`h-2 w-2 shrink-0 translate-y-[-1px] rounded-full ${i.tone === 'urgent' ? 'bg-red-600' : 'bg-amber-500'}`} />
            <Link to={i.link} className={`font-medium underline-offset-2 hover:underline ${i.tone === 'urgent' ? 'text-red-800' : 'text-stone-800'}`}>
              {i.title}
            </Link>
            {i.detail && <span className="text-xs text-stone-600">{i.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
