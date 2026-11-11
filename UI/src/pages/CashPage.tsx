import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field, FormPanel, Input, Select, td, th } from '../components/ui';
import { useCan } from '../lib/auth';
import { TRANSFER_LABELS, useCashAction, useCashSummary, useCashTransfers, type CashTransfer } from '../lib/cash';
import { longDate, parsePesos, peso, pesosText, todayManila } from '../lib/format';

function daysAgo(n: number): string {
  const d = new Date(`${todayManila()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** The owner confirms a handover: the amount counted, when, and who received it. */
function ReceiveForm({ handover, onDone }: { handover: CashTransfer; onDone: () => void }) {
  const save = useCashAction();
  const [amount, setAmount] = useState(pesosText(handover.amount));
  const [receivedOn, setReceivedOn] = useState(todayManila());
  const [who, setWho] = useState<'me' | 'other'>('me');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const centavos = parsePesos(amount);
  const diff = centavos === null ? 0 : centavos - handover.amount;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      {
        path: `/cash/handovers/${handover.id}/receive`,
        body: { receivedAmount: centavos, receivedOn, receivedByName: who === 'other' ? name : undefined, note: note || undefined },
      },
      { onSuccess: onDone },
    );
  }

  return (
    <FormPanel onSubmit={submit}>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Amount counted (₱)" hint={diff === 0 ? 'Matches the handover' : diff > 0 ? `Over by ${peso(diff)}` : `Short by ${peso(-diff)}`}>
          <Input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Received on">
          <Input type="date" required max={todayManila()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </Field>
        <Field label="Received by">
          <Select value={who} onChange={(e) => setWho(e.target.value as 'me' | 'other')}>
            <option value="me">Me</option>
            <option value="other">Someone for me</option>
          </Select>
        </Field>
        {who === 'other' && (
          <Field label="Their name">
            <Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label={diff ? 'Why is it different?' : 'Note (optional)'}>
        <Input required={diff !== 0} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={centavos === null || save.isPending}>Confirm received</Button>
      </div>
    </FormPanel>
  );
}

/** Restarts the running count of Sales Cash from what is actually in the shop, e.g. at go-live. */
function OpeningForm({ onDone }: { onDone: () => void }) {
  const save = useCashAction();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const centavos = parsePesos(amount);
  return (
    <FormPanel
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ path: '/cash/opening', body: { amount: centavos, note: note || undefined } }, { onSuccess: onDone });
      }}
    >
      {save.error && <Alert>{save.error.message}</Alert>}
      <p className="text-sm text-stone-600">
        Count the sales cash in the shop now, without the ₱800 petty cash. Day Close and the reminders run on from this count.
      </p>
      <div className="grid grid-cols-[10rem_1fr] gap-3">
        <Field label="Sales cash counted (₱)">
          <Input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={centavos === null || save.isPending}>Save count</Button>
      </div>
    </FormPanel>
  );
}

export function CashPage() {
  const isOwner = useCan('cash.receive');
  const summary = useCashSummary();
  const remove = useCashAction();
  const [from, setFrom] = useState(daysAgo(60));
  const [to, setTo] = useState(todayManila());
  const history = useCashTransfers(from, to);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const s = summary.data;
  const rows = history.data?.transfers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Cash</h1>
        {isOwner && !opening && (
          <Button variant="secondary" onClick={() => setOpening(true)}>Count sales cash in the shop</Button>
        )}
      </div>
      {opening && <OpeningForm onDone={() => setOpening(false)} />}

      {s && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card title="Sales cash in the shop">
            <p className="text-2xl font-semibold tabular-nums">{peso(s.salesCash)}</p>
            <p className="text-xs text-stone-500">{s.lastHandover ? `Last handover ${longDate(s.lastHandover.businessDay)}` : 'No handover yet'}</p>
          </Card>
          <Card title="Petty cash">
            <p className="text-2xl font-semibold tabular-nums">{peso(s.pettyCash)}</p>
            <p className="text-xs text-stone-500">Kept at ₱800, topped up Saturday</p>
          </Card>
          <Card title={`Pay week ${longDate(s.payWeek.start)}`}>
            <p className="text-sm">
              Payroll {s.payrollReleased ? <Badge tone="teal">paid</Badge> : <Badge tone="amber">not all paid</Badge>}
            </p>
            <p className="mt-1 text-sm">
              Laundry this week {s.laundryPaid ? <Badge tone="teal">paid</Badge> : <Badge tone="amber">not yet</Badge>}
            </p>
          </Card>
        </div>
      )}

      {s && s.waiting.length > 0 && (
        <Card title={`Waiting for the owner (${s.waiting.length})`}>
          <ul className="divide-y divide-stone-100 text-sm">
            {s.waiting.map((h) => (
              <li key={h.id} className="space-y-3 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex-1">
                    <span className="font-semibold tabular-nums">{peso(h.amount)}</span> handed over {longDate(h.businessDay)}
                    {h.note && <span className="text-stone-500"> · {h.note}</span>}
                  </span>
                  {isOwner && receiving !== h.id && <Button onClick={() => setReceiving(h.id)}>Received</Button>}
                  {!isOwner && <Badge tone="amber">Waiting for owner</Badge>}
                </div>
                {receiving === h.id && <ReceiveForm handover={h} onDone={() => setReceiving(null)} />}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="History">
        <div className="mb-4 grid grid-cols-2 gap-3 sm:w-96">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {(history.error || remove.error) && <Alert>{(history.error ?? remove.error)!.message}</Alert>}
        {rows.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing in these dates.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className={th}>Day</th>
                  <th className={th}>What</th>
                  <th className={`${th} text-right`}>Amount</th>
                  <th className={th}>Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className={td}>{longDate(t.businessDay)}</td>
                    <td className={td}>
                      {TRANSFER_LABELS[t.kind]}
                      <span className="block text-xs text-stone-500">
                        {t.createdByName}
                        {t.note && ` · ${t.note}`}
                      </span>
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{peso(t.amount)}</td>
                    <td className={td}>
                      {t.kind !== 'handover' ? (
                        ''
                      ) : t.confirmedAt ? (
                        <>
                          {peso(t.receivedAmount)} on {longDate(t.receivedOn!)} by {t.receivedByName ?? t.confirmedByName}
                          {t.receivedAmount !== t.amount && <Badge tone="red">{t.receivedAmount! > t.amount ? 'Over' : 'Short'}</Badge>}
                          {t.receiveNote && <span className="block text-xs text-stone-500">{t.receiveNote}</span>}
                        </>
                      ) : (
                        <Badge tone="amber">Waiting for owner</Badge>
                      )}
                      {(t.kind === 'handover' || t.kind === 'petty_topup') && !t.confirmedAt && (
                        <button
                          type="button"
                          className="ml-2 text-xs text-stone-500 underline"
                          onClick={() => confirm(`Remove this ${TRANSFER_LABELS[t.kind].toLowerCase()} of ${peso(t.amount)}?`) && remove.mutate({ path: `/cash/transfers/${t.id}`, method: 'DELETE' })}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
