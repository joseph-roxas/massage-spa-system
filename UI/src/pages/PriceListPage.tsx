import { Alert, Badge, Card, td, th } from '../components/ui';
import { usePromos, useServices, type Service } from '../lib/catalogue';
import { clock, duration, longDate, peso, percent } from '../lib/format';

function ServiceTable({ title, services }: { title: string; services: Service[] }) {
  return (
    <Card title={title}>
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Code</th>
            <th className={th}>Service</th>
            <th className={th}>Duration</th>
            <th className={`${th} text-right`}>Price</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {services.map((s) => (
            <tr key={s.id}>
              <td className={`${td} font-mono text-stone-500`}>{s.code}</td>
              <td className={td}>
                {s.name}
                <div className="mt-1 flex gap-1">
                  {s.voucherEligible && <Badge tone="teal">Voucher</Badge>}
                  {s.isFootType && <Badge>Recliner OK</Badge>}
                </div>
              </td>
              <td className={td}>{duration(s.durationMin)}</td>
              <td className={`${td} text-right font-semibold tabular-nums`}>{peso(s.currentPrice)}</td>
              <td className={`${td} text-xs text-amber-700`}>
                {s.upcomingPrices.map((p) => (
                  <div key={p.id}>
                    {peso(p.regularPrice)} from {longDate(p.effectiveFrom)}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function PriceListPage() {
  const services = useServices();
  const promos = usePromos();
  const today = services.data?.today ?? '';
  const active = services.data?.services.filter((s) => s.active) ?? [];
  const name = (id: string) => services.data?.services.find((s) => s.id === id)?.name ?? id;
  const runningPromos = promos.data?.promos.filter((p) => p.active && p.validTo >= today) ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Price List</h1>
      {services.error && <Alert>{services.error.message}</Alert>}

      {runningPromos.length > 0 && (
        <Card title="Promos">
          <ul className="space-y-2 text-sm">
            {runningPromos.map((p) => (
              <li key={p.id}>
                <span className="font-semibold">{p.name}</span>: {percent(p.percentBp)} off {name(p.serviceId)} when the
                service starts from {clock(p.startTime)} to {clock(p.endTime)}, daily until {longDate(p.validTo)}
                {p.validFrom > today && ` (starts ${longDate(p.validFrom)})`}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ServiceTable title="Services" services={active.filter((s) => s.kind === 'single')} />
      <ServiceTable title="Combo rates" services={active.filter((s) => s.kind === 'combo')} />
    </div>
  );
}
