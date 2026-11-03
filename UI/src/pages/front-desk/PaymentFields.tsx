import { useState } from 'react';
import { Field, Input } from '../../components/ui';
import { parsePesos, peso } from '../../lib/format';
import type { PaymentLine } from '../../lib/sales';

type PayMode = 'cash' | 'gcash' | 'split';

/** Cash, GCash or a split of both, for `due` centavos. */
export function usePayment(due: number) {
  const [mode, setMode] = useState<PayMode>('cash');
  const [tendered, setTendered] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [gcashRef, setGcashRef] = useState('');

  const cashPart = mode === 'cash' ? due : mode === 'split' ? (parsePesos(splitCash) ?? 0) : 0;
  const gcashPart = due - cashPart;
  const payments: PaymentLine[] =
    due === 0
      ? []
      : [
          ...(cashPart > 0 ? [{ method: 'cash' as const, amount: cashPart }] : []),
          ...(gcashPart > 0 ? [{ method: 'gcash' as const, amount: gcashPart, gcashRef }] : []),
        ];
  const invalid = mode === 'split' && (cashPart <= 0 || cashPart >= due);

  const tenderedAmount = parsePesos(tendered);
  const change = mode === 'cash' && tenderedAmount !== null ? tenderedAmount - due : null;

  const fields =
    due > 0 ? (
      <fieldset className="space-y-3 text-sm">
        <legend className="mb-1 font-medium text-stone-700">Payment</legend>
        <div className="flex gap-6">
          {(['cash', 'gcash', 'split'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" name="pay" checked={mode === m} onChange={() => setMode(m)} />
              {m === 'cash' ? 'Cash' : m === 'gcash' ? 'GCash' : 'Cash + GCash'}
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {mode === 'cash' && (
            <Field label="Cash received (optional)" hint={change !== null ? (change >= 0 ? `Change: ${peso(change)}` : 'Not enough') : 'To work out change'}>
              <Input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} />
            </Field>
          )}
          {mode === 'split' && (
            <Field label="Cash part" hint={invalid ? 'Less than the total' : `GCash part: ${peso(gcashPart)}`}>
              <Input inputMode="decimal" required value={splitCash} onChange={(e) => setSplitCash(e.target.value)} />
            </Field>
          )}
          {mode !== 'cash' && (
            <Field label="GCash reference number">
              <Input required value={gcashRef} onChange={(e) => setGcashRef(e.target.value)} />
            </Field>
          )}
        </div>
      </fieldset>
    ) : null;

  return { payments, invalid, fields };
}
