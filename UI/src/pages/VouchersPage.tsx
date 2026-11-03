import { useState, type FormEvent } from 'react';
import { businessDayOf } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../components/ui';
import { manilaTime } from '../lib/attendance';
import { useCan } from '../lib/auth';
import { useServices } from '../lib/catalogue';
import { longDate, peso } from '../lib/format';
import { useDayAction } from '../lib/sales';
import { useVouchers, useVoucherSales, VOUCHER_STATUS_LABELS, type VoucherStatus } from '../lib/vouchers';
import { SellVouchersDialog } from './front-desk/SellVouchersDialog';

const STATUS_TONE = { unused: 'teal', redeemed: 'stone', voided: 'red' } as const;

function TodaySales() {
  const day = businessDayOf(new Date());
  const list = useVoucherSales(day);
  const cancel = useDayAction();
  const rows = list.data?.voucherSales ?? [];
  return (
    <Card title={`Sold today (${longDate(day)})`}>
      {cancel.error && <Alert>{cancel.error.message}</Alert>}
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No vouchers sold yet today.</p>
      ) : (
        <ul className="divide-y divide-stone-100 text-sm">
          {rows.map((s) => (
            <li key={s.id} className="flex items-start gap-3 py-2">
              <span className="w-16 tabular-nums text-stone-500">{manilaTime(s.createdAt)}</span>
              <span className="flex-1">
                {s.qtyPaid + s.qtyFree} × {s.serviceName}
                {s.buyerName && <span className="text-stone-500"> · {s.buyerName}</span>}
                <span className="block font-mono text-xs text-stone-500">{s.vouchers.map((v) => v.serial).join('  ')}</span>
              </span>
              <span className="tabular-nums">{peso(s.total)}</span>
              {s.status === 'voided' ? (
                <Badge tone="red">Cancelled</Badge>
              ) : (
                <button
                  type="button"
                  className="text-xs text-stone-500 underline"
                  onClick={() => {
                    const reason = prompt('Why cancel this voucher sale? Its vouchers stop working.');
                    if (reason && reason.trim().length >= 3) cancel.mutate({ path: `/voucher-sales/${s.id}/void`, body: { reason } });
                  }}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** For go-live: paper Vouchers already sold are entered with their printed serials. */
function ImportForm({ onDone }: { onDone: () => void }) {
  const services = useServices();
  const save = useDayAction();
  const [serviceId, setServiceId] = useState('');
  const [text, setText] = useState('');
  const [isFree, setIsFree] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const serials = text.split(/[\s,]+/).filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The API takes at most 90 per request.
    let imported = 0;
    for (let i = 0; i < serials.length; i += 90) {
      const res = await save.mutateAsync({ path: '/vouchers/import', body: { serviceId, serials: serials.slice(i, i + 90), isFree } }).catch(() => null);
      if (!res) break;
      imported += serials.slice(i, i + 90).length;
    }
    setDone(imported);
    if (imported === serials.length) setText('');
  }

  return (
    <FormPanel onSubmit={submit}>
      {save.error && <Alert>{save.error.message}</Alert>}
      {done !== null && !save.error && <Alert tone="success">{done} voucher(s) added.</Alert>}
      <p className="text-sm text-stone-600">Vouchers sold on paper before the system. They are not counted as sales again.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Service">
          <Select required value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Choose…</option>
            {(services.data?.services ?? [])
              .filter((s) => s.voucherEligible)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="pt-6">
          <Checkbox label="These are free (5+1) vouchers" checked={isFree} onChange={(e) => setIsFree(e.target.checked)} />
        </div>
      </div>
      <Field label={`Serial numbers, one per line (${serials.length})`}>
        <textarea
          required
          rows={5}
          className="w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Close</Button>
        <Button type="submit" disabled={!serials.length || save.isPending}>Add vouchers</Button>
      </div>
    </FormPanel>
  );
}

export function VouchersPage() {
  const canImport = useCan('vouchers.import');
  const [selling, setSelling] = useState(false);
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<VoucherStatus | ''>('');
  const list = useVouchers({ q, status });
  const rows = list.data?.vouchers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Vouchers</h1>
        <div className="flex gap-2">
          {canImport && !importing && (
            <Button variant="secondary" onClick={() => setImporting(true)}>Add paper vouchers</Button>
          )}
          <Button onClick={() => setSelling(true)}>Sell vouchers</Button>
        </div>
      </div>
      {importing && <ImportForm onDone={() => setImporting(false)} />}
      <TodaySales />

      <Card title="Look up a voucher">
        <div className="mb-4 grid grid-cols-[1fr_12rem] gap-3">
          <Input placeholder="Serial number" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select value={status} onChange={(e) => setStatus(e.target.value as VoucherStatus | '')}>
            <option value="">Any status</option>
            {Object.entries(VOUCHER_STATUS_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        {list.error && <Alert>{list.error.message}</Alert>}
        {rows.length === 0 ? (
          <p className="text-sm text-stone-500">No vouchers match.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Serial</th>
                <th className={th}>Service</th>
                <th className={th}>Sold</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className={`${td} font-mono`}>
                    {v.serial} {v.isFree && <Badge tone="teal">Free</Badge>}
                  </td>
                  <td className={td}>{v.serviceName}</td>
                  <td className={td}>
                    {v.imported ? 'Paper (before the system)' : v.soldOn ? longDate(v.soldOn) : ''}
                    {v.buyerName && <span className="text-stone-500"> · {v.buyerName}</span>}
                  </td>
                  <td className={td}>
                    <Badge tone={STATUS_TONE[v.status]}>{VOUCHER_STATUS_LABELS[v.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {selling && <SellVouchersDialog onClose={() => setSelling(false)} />}
    </div>
  );
}
