import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { parsePesos, peso, pesosText, todayManila } from '../../lib/format';
import { useCategories, useExpenseAction, useRecurring, type Recurring } from '../../lib/expenses';

function RecurringForm({ r, onDone }: { r?: Recurring; onDone: () => void }) {
  const { data } = useCategories();
  const act = useExpenseAction();
  const [d, setD] = useState({ categoryId: r?.categoryId ?? '', description: r?.description ?? '', amount: r ? pesosText(r.amount) : '', day: String(r?.dayOfMonth ?? 1), active: r?.active ?? true });
  const amount = parsePesos(d.amount);
  const day = Number(d.day);

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { categoryId: d.categoryId, description: d.description, amount, dayOfMonth: day, active: d.active };
    act.mutate(r ? { path: `/expenses/recurring/${r.id}`, method: 'PATCH', body } : { path: '/expenses/recurring', body }, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {act.error && <Alert>{act.error.message}</Alert>}
      <div className="grid grid-cols-[1fr_1fr_8rem_6rem] gap-3">
        <Field label="Category">
          <Select required value={d.categoryId} onChange={(e) => setD({ ...d, categoryId: e.target.value })}>
            <option value="">Choose…</option>
            {(data?.categories ?? [])
              .filter((c) => c.active && c.id !== 'royalty')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="What for">
          <Input required minLength={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </Field>
        <Field label="Amount" hint="Changeable each month">
          <Input inputMode="decimal" required value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} />
        </Field>
        <Field label="Day" hint="1–31">
          <Input inputMode="numeric" required value={d.day} onChange={(e) => setD({ ...d, day: e.target.value })} />
        </Field>
      </div>
      {r && <Checkbox label="Still monthly" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />}
      <div className="flex gap-2">
        <Button type="submit" disabled={!amount || !d.categoryId || !Number.isInteger(day) || day < 1 || day > 31 || act.isPending}>Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

export function SetupTab() {
  const recurring = useRecurring();
  const cats = useCategories();
  const act = useExpenseAction();
  const [editing, setEditing] = useState<Recurring | 'new' | null>(null);
  const catName = (id: string) => cats.data?.categories.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <Card
        title="Monthly expenses"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: '/expenses/recurring/draft', body: { month: todayManila().slice(0, 7) } })}>
              Draft this month now
            </Button>
            <Button onClick={() => setEditing('new')}>Add monthly expense</Button>
          </div>
        }
      >
        <p className="mb-3 text-sm text-stone-500">Each month the system drafts these as Expenses for you to confirm when paid (the amount can be changed first, e.g. for a varying bill).</p>
        {act.error && <Alert>{act.error.message}</Alert>}
        {editing === 'new' && (
          <div className="mb-4">
            <RecurringForm onDone={() => setEditing(null)} />
          </div>
        )}
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Day</th>
              <th className={th}>Category</th>
              <th className={th}>What for</th>
              <th className={`${th} text-right`}>Amount</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {recurring.data?.recurring.map((r) =>
              editing !== 'new' && editing?.id === r.id ? (
                <tr key={r.id}>
                  <td colSpan={5} className="py-2">
                    <RecurringForm r={r} onDone={() => setEditing(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={r.id} className={r.active ? '' : 'text-stone-400'}>
                  <td className={td}>{r.dayOfMonth}</td>
                  <td className={td}>{catName(r.categoryId)}</td>
                  <td className={td}>
                    {r.description} {!r.active && <Badge>Stopped</Badge>}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{peso(r.amount)}</td>
                  <td className={`${td} text-right`}>
                    <button type="button" className="text-sm text-teal-800 underline" onClick={() => setEditing(r)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </Card>

      <Card
        title="Categories"
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              const name = prompt('New category name');
              if (name?.trim()) act.mutate({ path: '/expenses/categories', body: { name: name.trim() } });
            }}
          >
            Add category
          </Button>
        }
      >
        <ul className="divide-y divide-stone-100 text-sm">
          {cats.data?.categories.map((c) => (
            <li key={c.id} className={`flex items-center justify-between py-1.5 ${c.active ? '' : 'text-stone-400'}`}>
              <span>
                {c.name} {!c.active && <Badge>Hidden</Badge>}
              </span>
              {c.id !== 'royalty' && (
                <button type="button" className="text-stone-600 underline" onClick={() => act.mutate({ path: `/expenses/categories/${c.id}`, method: 'PATCH', body: { active: !c.active } })}>
                  {c.active ? 'Hide' : 'Show'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
