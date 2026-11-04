import { useSearchParams } from 'react-router';
import { MonthTab } from './expenses/MonthTab';
import { RoyaltyTab } from './expenses/RoyaltyTab';
import { SetupTab } from './expenses/SetupTab';

type Tab = 'month' | 'royalty' | 'setup';
const TABS: [Tab, string][] = [
  ['month', 'Spending'],
  ['royalty', 'Royalty'],
  ['setup', 'Monthly & categories'],
];

export function ExpensesPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'month';
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Expenses</h1>
        <div className="flex rounded-md border border-stone-300 bg-white p-0.5 text-sm">
          {TABS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setParams({ tab: key })} className={`rounded px-3 py-1.5 ${tab === key ? 'bg-teal-700 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'month' && <MonthTab />}
      {tab === 'royalty' && <RoyaltyTab />}
      {tab === 'setup' && <SetupTab />}
    </div>
  );
}
