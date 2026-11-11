import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { onBusinessDay } from '@spa/domain';
import { Alert, Badge, Button, Card, Field, Input, Select, td, th } from '../components/ui';
import { api } from '../lib/api';
import { useServices } from '../lib/catalogue';
import { manilaTime } from '../lib/attendance';
import { longDate, parsePesos, peso, todayManila } from '../lib/format';
import { TimeInput } from '../components/TimeInput';

type Detail = {
  day: { date: string; closedAt: string | null; expectedCash: number | null; expectedGcash: number | null; countedCash: number | null; variance: number | null } | null;
  services: {
    bookingId: string;
    guestName: string | null;
    serviceId: string;
    serviceName: string;
    therapistName: string | null;
    startedAt: string;
    doneAt: string;
    enteredLate: boolean;
    sale: { id: string; regularPrice: number; discountType: string; discountAmount: number; amountDue: number; topUpsTotal: number; payments: { method: string; amount: number }[] } | null;
  }[];
};

const DISCOUNT_LABELS: Record<string, string> = { none: 'None', promo: 'Promo', senior: 'Senior Citizen', pwd: 'PWD', voucher: 'Voucher', complimentary: 'Complimentary' };

function yesterday() {
  const d = new Date(`${todayManila()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Super Admin: fix a finished Service's start time (re-pricing its Sale) or a closed day's cash count, after the fact. */
export function CorrectSalesPage() {
  const qc = useQueryClient();
  const [day, setDay] = useState(yesterday());
  const detail = useQuery({ queryKey: ['day-detail', day], queryFn: () => api<Detail>(`/sales/day-detail?day=${day}`) });
  const act = useMutation({
    mutationFn: (req: { path: string; body: unknown }) => api(req.path, { body: req.body }),
    onSettled: () => {
      for (const key of ['day-detail', 'front-desk', 'cash', 'close-preview', 'reports', 'dashboard']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const [editing, setEditing] = useState<{ id: string; what: 'start' | 'service' } | null>(null);
  const [time, setTime] = useState('');
  const [serviceId, setServiceId] = useState('');
  const services = useServices();
  const [reason, setReason] = useState('');
  const [counting, setCounting] = useState(false);
  const [counted, setCounted] = useState('');
  const d = detail.data?.day;
  const rows = detail.data?.services ?? [];

  const startEdit = (id: string, startedAt: string) => {
    setEditing({ id, what: 'start' });
    setTime(manilaTime24(startedAt));
    setReason('');
    act.reset();
  };
  const startService = (id: string, current: string) => {
    setEditing({ id, what: 'service' });
    setServiceId(current);
    setReason('');
    act.reset();
  };
  /** Why a sale's Service can't be corrected here, or null. */
  const serviceBlock = (r: Detail['services'][number]) =>
    !r.sale ? 'Not checked out' : r.sale.discountType === 'voucher' ? 'Paid with a Voucher: void and check out again' : r.sale.topUpsTotal > 0 ? 'Has added time: void and check out again' : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Correct sales</h1>
          <p className="text-sm text-stone-600">Fix when a service really started or which service it was, or what was really counted at a Day Close.</p>
        </div>
        <Field label="Business Day">
          <div className="w-44">
            <Input type="date" max={todayManila()} value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
        </Field>
      </div>
      {(detail.error || act.error) && <Alert>{(detail.error ?? act.error)!.message}</Alert>}

      <Card title={`Day Close · ${longDate(day)}`}>
        {!d ? (
          <p className="text-sm text-stone-500">Nothing was recorded on this day.</p>
        ) : !d.closedAt ? (
          <p className="text-sm text-stone-600">
            <Badge tone="teal">Open</Badge> Not closed yet. A start time can still be corrected; the Day Close will count it.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              Expected {peso(d.expectedCash)} cash · counted {peso(d.countedCash)} · {d.variance === 0 ? 'no variance' : d.variance! > 0 ? `over ${peso(d.variance)}` : `short ${peso(-d.variance!)}`}
              {!counting && (
                <Button variant="secondary" className="ml-3 h-8 px-3" onClick={() => (setCounting(true), setCounted(String((d.countedCash ?? 0) / 100)), setReason(''), act.reset())}>
                  Correct count
                </Button>
              )}
            </p>
            {counting && (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  act.mutate({ path: `/days/${day}/counted`, body: { countedCash: parsePesos(counted), reason } }, { onSuccess: () => setCounting(false) });
                }}
              >
                <Field label="Cash really counted (₱)">
                  <div className="w-36">
                    <Input required inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
                  </div>
                </Field>
                <Field label="Why">
                  <div className="w-72">
                    <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </div>
                </Field>
                <Button type="submit" disabled={parsePesos(counted) === null || act.isPending}>
                  Save count
                </Button>
                <Button type="button" variant="secondary" onClick={() => setCounting(false)}>
                  Cancel
                </Button>
              </form>
            )}
          </div>
        )}
      </Card>

      <Card title={`Services finished (${rows.length})`}>
        {rows.length === 0 ? (
          <p className="text-sm text-stone-500">No finished services on this day.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className={th}>Served</th>
                  <th className={th}>Guest and service</th>
                  <th className={th}>Therapist</th>
                  <th className={th}>Discount</th>
                  <th className={`${th} text-right`}>Paid</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((r) => (
                  <tr key={r.bookingId}>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {manilaTime(r.startedAt)}–{manilaTime(r.doneAt)}
                      {r.enteredLate && (
                        <span className="ml-2">
                          <Badge tone="amber">Entered late</Badge>
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      {r.guestName || 'Walk-in guest'} · {r.serviceName}
                    </td>
                    <td className={td}>{r.therapistName}</td>
                    <td className={td}>
                      {r.sale ? `${DISCOUNT_LABELS[r.sale.discountType] ?? r.sale.discountType}${r.sale.discountAmount ? ` −${peso(r.sale.discountAmount)}` : ''}` : 'Not checked out'}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{r.sale ? peso(r.sale.amountDue) : '—'}</td>
                    <td className={`${td} text-right`}>
                      {editing?.id === r.bookingId && editing.what === 'start' ? (
                        <form
                          className="flex flex-wrap items-end justify-end gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            act.mutate(
                              { path: '/sales/correct-start', body: { bookingId: r.bookingId, startedAt: onBusinessDay(day, time).toISOString(), reason } },
                              { onSuccess: () => setEditing(null) },
                            );
                          }}
                        >
                          <Field label="Really started">
                            <TimeInput required value={time} onChange={setTime} className="w-60" />
                          </Field>
                          <Field label="Why">
                            <div className="w-56">
                              <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                            </div>
                          </Field>
                          <Button type="submit" className="h-10" disabled={act.isPending}>
                            Save
                          </Button>
                          <Button type="button" variant="secondary" className="h-10" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </form>
                      ) : editing?.id === r.bookingId && editing.what === 'service' ? (
                        <form
                          className="flex flex-wrap items-end justify-end gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            act.mutate({ path: '/sales/correct-service', body: { bookingId: r.bookingId, serviceId, reason } }, { onSuccess: () => setEditing(null) });
                          }}
                        >
                          <div className="w-64">
                            <Field label="Really served">
                              <Select required value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                                {(services.data?.services ?? [])
                                  .filter((s) => s.active || s.id === r.serviceId)
                                  .map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {s.code} · {s.name}
                                    </option>
                                  ))}
                              </Select>
                            </Field>
                          </div>
                          <Field label="Why">
                            <div className="w-56">
                              <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                            </div>
                          </Field>
                          <Button type="submit" className="h-10" disabled={act.isPending || serviceId === r.serviceId}>
                            Save
                          </Button>
                          <Button type="button" variant="secondary" className="h-10" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <span className="inline-flex flex-wrap justify-end gap-2">
                          <Button variant="secondary" className="h-8 px-3" onClick={() => startEdit(r.bookingId, r.startedAt)}>
                            Correct start time
                          </Button>
                          <Button variant="secondary" className="h-8 px-3" disabled={!!serviceBlock(r)} title={serviceBlock(r) ?? undefined} onClick={() => startService(r.bookingId, r.serviceId)}>
                            Correct service
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-stone-500">
          <span className="font-medium">Start time:</span> the service keeps its length. A sale with no discount or a Promo is priced again by the checkout rules, so Happy Hours applies if the real
          time qualifies. Commission doesn’t change. <span className="font-medium">Service:</span> same start, the new service’s length and price; Senior, PWD and Complimentary are kept, a Promo is
          checked again, and the Commission follows the new service. Either way the difference comes off the cash payment, and a closed day’s expected cash follows.
        </p>
      </Card>
    </div>
  );
}

/** An ISO instant as HH:MM in Manila, for a time box. */
function manilaTime24(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
}
