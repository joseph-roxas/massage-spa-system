import { useSearchParams } from 'react-router';
import { useCan } from '../lib/auth';
import { usePurchaseOrders, useTakeoutRequests, useTurnovers } from '../lib/inventory';
import { CatalogTab } from './inventory/CatalogTab';
import { OrdersTab } from './inventory/OrdersTab';
import { RequestsTab } from './inventory/RequestsTab';
import { StockTab } from './inventory/StockTab';

type Tab = 'stock' | 'requests' | 'orders' | 'items';

export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const isAdmin = useCan('inventory.po.approve');
  const orders = usePurchaseOrders(isAdmin);
  const requests = useTakeoutRequests();
  const turnovers = useTurnovers();
  const tab = (params.get('tab') as Tab | null) ?? 'stock';
  const waiting = (orders.data?.purchaseOrders ?? []).filter((p) => p.status === 'requested' || p.status === 'approved' || p.status === 'partially_received').length;
  const asked =
    (requests.data?.requests ?? []).filter((r) => !r.resolvedAt).length +
    (isAdmin ? (turnovers.data?.turnovers ?? []).filter((t) => t.short > 0 && !t.shortfallResolvedAt).length : 0);
  const tabs: [Tab, string][] = [
    ['stock', 'Stock'],
    ['requests', `Requests${asked ? ` (${asked})` : ''}`],
    ...(isAdmin
      ? ([
          ['orders', `Purchase Orders${waiting ? ` (${waiting})` : ''}`],
          ['items', 'Items & vendors'],
        ] as [Tab, string][])
      : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <div className="flex rounded-md border border-stone-300 bg-white p-0.5 text-sm">
          {tabs.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setParams({ tab: key })} className={`rounded px-3 py-1.5 ${tab === key ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'stock' && <StockTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'orders' && isAdmin && <OrdersTab />}
      {tab === 'items' && isAdmin && <CatalogTab />}
    </div>
  );
}
