import { Fragment, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, td, th } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { longDate, parsePesos, peso, todayManila } from '../../lib/format';
import { usePayrollAction, useBalances, type Balance, type CashAdvance } from '../../lib/payroll';

function GiveDialog({ person, onClose }: { person: Balance; onClose: () => void }) {
  const canOverride = useCan('cash_advance.override');
  const act = usePayrollAction();
  const [amount, setAmount] = useState('');
  const [fromDrawer, setFromDrawer] = useState(true);
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const value = parsePesos(amount);
  const cap = person.cap?.cap;
  const above = cap !== undefined && value !== null && value > cap;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (value === null) return;
    act.mutate({ path: '/cash-advances', body: { staffId: person.staffId, amount: value, fromDrawer, note, override } }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Cash Advance · ${person.displayName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        {person.cap ? (
          <p className="text-sm text-stone-600">
            Deducted from the payroll for the week of {longDate(person.cap.week.start)}. Can take up to <strong>{peso(person.cap.cap)}</strong>
            {person.cap.taken > 0 && ` (already took ${peso(person.cap.taken)})`}.
          </p>
        ) : (
          <p className="text-sm text-stone-600">
            Added to the balance of {peso(person.balance)}. The repayment is chosen on each week’s payroll.
          </p>
        )}
        <Field label="Amount" hint={above ? 'More than the limit' : undefined}>
          <Input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Checkbox label="Taken from the cash drawer (counted at Day Close)" checked={fromDrawer} onChange={(e) => setFromDrawer(e.target.checked)} />
        {above && canOverride && <Checkbox label="Allow more than the limit" checked={override} onChange={(e) => setOverride(e.target.checked)} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={value === null || value <= 0 || act.isPending || (above && !override)}>
            Give {value ? peso(value) : ''}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function OpeningDialog({ person, onClose }: { person: Balance; onClose: () => void }) {
  const act = usePayrollAction();
  const [amount, setAmount] = useState('');
  const value = parsePesos(amount);
  return (
    <Modal title={`Opening CA balance · ${person.displayName}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (value !== null) act.mutate({ path: '/cash-advances/opening', method: 'PUT', body: { staffId: person.staffId, amount: value } }, { onSuccess: onClose });
        }}
      >
        {act.error && <Alert>{act.error.message}</Alert>}
        <p className="text-sm text-stone-600">What {person.displayName} already owed before using the system. Replaces any earlier opening balance.</p>
        <Field label="Amount owed">
          <Input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={value === null || act.isPending}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

const ENTRY_LABEL = { opening: 'Opening balance', advance: 'Cash Advance', repayment: 'Repaid from payroll' } as const;
type LedgerRow = { id: string; entry: keyof typeof ENTRY_LABEL; amount: number; createdAt: string; cashAdvanceId: string | null };

function History({ person }: { person: Balance }) {
  const act = usePayrollAction();
  const { data } = useQuery({
    queryKey: ['cash-advances', 'history', person.staffId],
    queryFn: () => api<{ ledger: LedgerRow[]; advances: CashAdvance[] }>(`/cash-advances?staffId=${person.staffId}`),
  });
  const today = todayManila();
  if (!data) return null;
  if (!data.ledger.length) return <p className="px-3 py-2 text-sm text-stone-500">No Cash Advances yet.</p>;
  return (
    <div className="px-3 pb-3">
      {act.error && <Alert>{act.error.message}</Alert>}
      <ul className="divide-y divide-stone-100 rounded-md border border-stone-200 bg-white text-sm">
        {data.ledger.map((l) => {
          const advance = data.advances.find((a) => a.id === l.cashAdvanceId);
          return (
            <li key={l.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-32 text-stone-500">{longDate(advance?.businessDay ?? l.createdAt.slice(0, 10))}</span>
              <span className="flex-1">
                {ENTRY_LABEL[l.entry]}
                {advance?.note && <span className="text-stone-500"> · {advance.note}</span>}
                {advance?.overrideBy && <Badge tone="amber">Over the limit</Badge>}
              </span>
              <span className="tabular-nums">{l.entry === 'repayment' ? `−${peso(l.amount)}` : peso(l.amount)}</span>
              {advance && advance.businessDay >= today && (
                <button
                  type="button"
                  className="text-xs text-stone-500 underline"
                  onClick={() => confirm('Remove this Cash Advance? Use this only for a mistake.') && act.mutate({ path: `/cash-advances/${advance.id}`, method: 'DELETE' })}
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CashAdvances() {
  const { data, error } = useBalances();
  const canOpening = useCan('cash_advance.override');
  const [giving, setGiving] = useState<Balance | null>(null);
  const [opening, setOpening] = useState<Balance | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const rows = data?.balances ?? [];

  return (
    <Card title="Cash Advances">
      {error && <Alert>{error.message}</Alert>}
      <p className="mb-3 text-sm text-stone-500">
        Therapists can take up to what they earned last week (net) until that payroll is approved; after that, up to what they have earned this week.
      </p>
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Name</th>
            <th className={`${th} text-right`}>Owes now</th>
            <th className={`${th} text-right`}>Can take now</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((b) => (
            <Fragment key={b.staffId}>
              <tr>
                <td className={td}>
                  <button type="button" className="font-medium hover:underline" onClick={() => setOpen(open === b.staffId ? null : b.staffId)}>
                    {open === b.staffId ? '▾' : '▸'} {b.displayName}
                  </button>
                  {b.kind === 'receptionist' && <span className="ml-2 text-xs text-stone-500">Receptionist</span>}
                </td>
                <td className={`${td} text-right tabular-nums`}>{b.balance ? peso(b.balance) : '—'}</td>
                <td className={`${td} text-right tabular-nums`}>{b.cap ? peso(b.cap.cap) : 'No limit'}</td>
                <td className={`${td} text-right`}>
                  <div className="flex justify-end gap-2">
                    {canOpening && (
                      <button type="button" className="text-xs text-stone-500 underline" onClick={() => setOpening(b)}>
                        Opening balance
                      </button>
                    )}
                    <Button variant="secondary" className="h-8" onClick={() => setGiving(b)}>
                      Give CA
                    </Button>
                  </div>
                </td>
              </tr>
              {open === b.staffId && (
                <tr className="bg-stone-50">
                  <td colSpan={4}>
                    <History person={b} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {giving && <GiveDialog person={giving} onClose={() => setGiving(null)} />}
      {opening && <OpeningDialog person={opening} onClose={() => setOpening(null)} />}
    </Card>
  );
}
