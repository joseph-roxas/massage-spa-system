import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Field, Input, td, th } from '../../components/ui';
import { api } from '../../lib/api';
import { longDate } from '../../lib/format';

type Device = { id: string; label: string; createdAt: string; lastUsedAt: string | null; createdBy: string | null; thisDevice: boolean };

/** Marking the reception PC so its login page offers the Clock-in Screen without logging in (ADR 0004). */
export function FrontDeskSettings() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['front-desk-devices'], queryFn: () => api<{ devices: Device[] }>('/front-desk-devices') });
  const act = useMutation({
    mutationFn: (req: { path: string; method?: string; body?: unknown }) => api(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['front-desk-devices'] });
      qc.invalidateQueries({ queryKey: ['device'] });
    },
  });
  const [label, setLabel] = useState('Reception PC');
  const devices = data?.devices ?? [];
  const thisOne = devices.find((d) => d.thisDevice);

  return (
    <Card title="Front-desk device">
      <div className="space-y-4">
        <p className="text-sm text-stone-600">
          Mark the PC at the reception table once. Its login page then shows a <strong>Clock in or out</strong> button, so therapists can clock in before
          anyone logs in. Staff still need their own PIN. No other device gets the button.
        </p>
        {(error || act.error) && <Alert>{(error ?? act.error)?.message}</Alert>}
        {thisOne ? (
          <Alert tone="success">This device is marked as “{thisOne.label}”.</Alert>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: '/front-desk-devices', body: { label } });
            }}
          >
            <Field label="Name for this device">
              <Input required minLength={2} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} className="w-56" />
            </Field>
            <Button type="submit" disabled={act.isPending}>
              Mark this device as the front desk
            </Button>
          </form>
        )}
        {devices.length > 0 && (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Device</th>
                <th className={th}>Marked</th>
                <th className={th}>Last used</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className={td}>
                    {d.label} {d.thisDevice && <Badge tone="teal">This device</Badge>}
                  </td>
                  <td className={td}>
                    {longDate(d.createdAt.slice(0, 10))}
                    {d.createdBy && <span className="text-stone-500"> by {d.createdBy}</span>}
                  </td>
                  <td className={td}>{d.lastUsedAt ? longDate(d.lastUsedAt.slice(0, 10)) : '—'}</td>
                  <td className={`${td} text-right`}>
                    <Button
                      variant="secondary"
                      className="h-8"
                      disabled={act.isPending}
                      onClick={() => confirm(`Remove “${d.label}”? Its login page stops offering Clock in.`) && act.mutate({ path: `/front-desk-devices/${d.id}`, method: 'DELETE' })}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
