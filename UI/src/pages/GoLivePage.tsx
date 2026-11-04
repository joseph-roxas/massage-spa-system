import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Alert, Badge, Card } from '../components/ui';
import { api } from '../lib/api';
import { longDate } from '../lib/format';

type Check = { key: string; label: string; status: 'done' | 'todo' | 'optional'; detail: string; link: string };

const ICON = { done: '✓', todo: '○', optional: '–' } as const;
const TONE = { done: 'text-teal-700', todo: 'text-amber-600', optional: 'text-stone-400' } as const;

export function GoLivePage() {
  const { data, error } = useQuery({ queryKey: ['go-live'], queryFn: () => api<{ checks: Check[]; firstSunday: string; today: string }>('/go-live/status') });
  const todo = data?.checks.filter((c) => c.status === 'todo').length ?? 0;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Go-live checklist</h1>
      {error && <Alert>{error.message}</Alert>}
      {data && (
        <Alert tone={todo ? 'info' : 'success'}>
          {todo ? `${todo} thing(s) left before the first real day.` : 'Everything is ready.'} Start on a Sunday so the first Pay Week is complete in the system:{' '}
          <strong>{longDate(data.firstSunday)}</strong>.
        </Alert>
      )}

      <Card title="Before the first day">
        <ul className="divide-y divide-stone-100">
          {data?.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-3 py-3">
              <span className={`mt-0.5 w-5 text-center text-lg leading-none ${TONE[c.status]}`} aria-label={c.status}>
                {ICON[c.status]}
              </span>
              <span className="flex-1">
                <Link to={c.link} className="font-medium text-stone-800 hover:underline">
                  {c.label}
                </Link>
                <span className="block text-sm text-stone-500">{c.detail}</span>
              </span>
              {c.status === 'optional' && <Badge>If needed</Badge>}
              {c.status === 'todo' && <Badge tone="amber">To do</Badge>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="On the first day">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-stone-700">
          <li>Open the Clock-in Screen on the front-desk computer; everyone clocks in with their PIN as they arrive.</li>
          <li>Record every guest in the system from the first one. Use the paper sheet only if the internet is down.</li>
          <li>Close the Business Day at the end of the night and count the cash.</li>
          <li>After the first Saturday, generate that week’s payroll and compare it with your manual computation.</li>
        </ol>
      </Card>

      <Card title="If the internet goes down">
        <p className="text-sm text-stone-700">
          Keep a few copies of the{' '}
          <Link to="/paper-sheet" className="font-medium text-teal-800 underline">
            paper backup sheet
          </Link>{' '}
          printed at the front desk. Write each guest on it while offline, then enter them in the system as soon as it is back, the same night, before Day Close.
        </p>
      </Card>
    </div>
  );
}
