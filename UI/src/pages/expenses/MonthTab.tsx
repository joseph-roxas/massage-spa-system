import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { longDate, parsePesos, peso, pesosText, todayManila } from '../../lib/format';
import { CASH_OUT_CATEGORIES } from '../../lib/sales';
import { monthLabel, shiftMonth, useCategories, useExpenseAction, useMonthSpending, type Expense } from '../../lib/expenses';

function ExpenseForm({ expense, onDone }: { expense?: Expense; onDone: () => void }) {
  const { data } = useCategories();
  const act = useExpenseAction();
  const [d, setD] = useState({
    categoryId: expense?.categoryId ?? '',
    date: expense?.date ?? todayManila(),
    amount: expense ? pesosText(expense.amount) : '',
    description: expense?.description ?? '',
  });
  const amount = parsePesos(d.amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { ...d, amount };
    act.mutate(expense ? { path: `/expenses/${expense.id}`, method: 'PATCH', body } : { path: '/expenses', body }, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {act.error && <Alert>{act.error.message}</Alert>}
      <div className="grid grid-cols-[1fr_10rem_9rem] gap-3">
        <Field label="Category">
          <Select required value={d.categoryId} onChange={(e) => setD({ ...d, categoryId: e.target.value })}>
            <option value="">Choose…</option>
            {(data?.categories ?? [])
              .filter((c) => (c.active && c.id !== 'royalty') || c.id === d.categoryId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Date">
          <Input type="date" required value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} />
        </Field>
        <Field label="Amount">
          <Input inputMode="decimal" required value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} />
        </Field>
      </div>
      <Field label="What for">
        <Input required minLength={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="E.g. October electric bill, 2551Q filing fee" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!amount || !d.categoryId || act.isPending}>Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

/** Where a Cash-out's money came from, in the glossary's words. */
const FUND = { petty: 'Petty Cash Fund', sales: 'Sales Cash' } as const;

/** Each list shows its newest 15 (the API sends newest first) until asked for all. */
const SHOWN = 15;

function ShowAll({ total, all, onShowAll }: { total: number; all: boolean; onShowAll: () => void }): ReactNode {
  if (all || total <= SHOWN) return null;
  return (
    <button type="button" className="mt-2 text-sm font-medium text-teal-800 underline" onClick={onShowAll}>
      Show all ({total})
    </button>
  );
}

export function MonthTab() {
  const [month, setMonth] = useState(todayManila().slice(0, 7));
  const { data, error } = useMonthSpending(month);
  const cats = useCategories();
  const act = useExpenseAction();
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  // Which lists show everything; picking another month goes back to the newest 15.
  const [showAll, setShowAll] = useState({ month, expenses: false, cashOuts: false, purchases: false });
  const all = showAll.month === month ? showAll : { month, expenses: false, cashOuts: false, purchases: false };
  const showEvery = (list: 'expenses' | 'cashOuts' | 'purchases') => setShowAll({ ...all, [list]: true });
  const shown = <T,>(xs: T[] | undefined, list: 'expenses' | 'cashOuts' | 'purchases') => (all[list] ? (xs ?? []) : (xs ?? []).slice(0, SHOWN));
  const catName = (id: string) => cats.data?.categories.find((c) => c.id === id)?.name ?? id;
  const t = data?.totals;
  const total = t ? t.confirmed + t.cashOuts + t.purchases : 0;

  // Totals per category across all three sources, for a quick read.
  const byCategory = new Map<string, number>();
  for (const e of data?.expenses ?? []) byCategory.set(catName(e.categoryId), (byCategory.get(catName(e.categoryId)) ?? 0) + e.amount);
  for (const c of data?.cashOuts ?? []) {
    const key = `Cash-out: ${CASH_OUT_CATEGORIES[c.category]}`;
    byCategory.set(key, (byCategory.get(key) ?? 0) + c.amount);
  }
  if (t?.purchases) byCategory.set('Inventory purchases', t.purchases);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</Button>
        <p className="min-w-44 text-center font-medium">{monthLabel(month)}</p>
        <Button variant="secondary" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</Button>
      </div>
      {error && <Alert>{error.message}</Alert>}

      {t && (
        <div className="grid grid-cols-4 gap-4">
          {[
            ['Spent', total],
            ['Expenses', t.confirmed],
            ['Cash-outs', t.cashOuts],
            ['Inventory purchases', t.purchases],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-lg border border-stone-200 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{peso(value as number)}</p>
            </div>
          ))}
        </div>
      )}
      {t && t.pending > 0 && <Alert tone="info">{peso(t.pending)} is drafted but not confirmed yet, and is not counted above.</Alert>}

      <Card title="Expenses" actions={<Button onClick={() => setEditing('new')}>Add expense</Button>}>
        {editing === 'new' && (
          <div className="mb-4">
            <ExpenseForm onDone={() => setEditing(null)} />
          </div>
        )}
        {act.error && <Alert>{act.error.message}</Alert>}
        {data?.expenses.length === 0 && editing !== 'new' ? (
          <p className="text-sm text-stone-500">No expenses recorded this month.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Date</th>
                <th className={th}>Category</th>
                <th className={th}>What for</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {shown(data?.expenses, 'expenses').map((e) =>
                editing !== 'new' && editing?.id === e.id ? (
                  <tr key={e.id}>
                    <td colSpan={5} className="py-2">
                      <ExpenseForm expense={e} onDone={() => setEditing(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={e.id} className={e.status === 'pending' ? 'bg-amber-50/50' : ''}>
                    <td className={td}>{longDate(e.date)}</td>
                    <td className={td}>{catName(e.categoryId)}</td>
                    <td className={td}>
                      {e.description} {e.status === 'pending' && <Badge tone="amber">Not confirmed</Badge>}
                      {e.recurringExpenseId && <span className="ml-1 text-xs text-stone-500">monthly</span>}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{peso(e.amount)}</td>
                    <td className={`${td} text-right`}>
                      {e.royaltyMonth ? (
                        <span className="text-xs text-stone-500">see Royalty</span>
                      ) : (
                        <div className="flex justify-end gap-3 text-sm">
                          {e.status === 'pending' && (
                            <button type="button" className="font-medium text-teal-800 underline" onClick={() => act.mutate({ path: `/expenses/${e.id}/confirm` })}>
                              Paid
                            </button>
                          )}
                          <button type="button" className="text-stone-600 underline" onClick={() => setEditing(e)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-stone-500 underline"
                            onClick={() => confirm(`Delete “${e.description}”?`) && act.mutate({ path: `/expenses/${e.id}`, method: 'DELETE' })}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        <ShowAll total={data?.expenses.length ?? 0} all={all.expenses} onShowAll={() => showEvery('expenses')} />
      </Card>

      <div className="grid grid-cols-2 gap-6">
        <Card title="Cash-outs">
          <p className="mb-2 text-xs text-stone-500">Recorded at the Front Desk. On-call pay and Cash Advances are under Payroll.</p>
          {data?.cashOuts.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {shown(data.cashOuts, 'cashOuts').map((c) => (
                <li key={c.id} className="flex justify-between gap-3 py-1.5">
                  <span>
                    {c.purpose}
                    <span className="text-xs text-stone-500">
                      {' '}
                      · {CASH_OUT_CATEGORIES[c.category]} · {longDate(c.businessDay)} · from {FUND[c.source]}
                    </span>
                    {c.breakdown && <span className="block text-xs text-stone-500">{c.breakdown.map((d) => `${longDate(d.day)} ${peso(d.amount)}`).join(' · ')}</span>}
                  </span>
                  <span className="tabular-nums">{peso(c.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-500">None.</p>
          )}
          <ShowAll total={data?.cashOuts.length ?? 0} all={all.cashOuts} onShowAll={() => showEvery('cashOuts')} />
        </Card>
        <Card title="Inventory purchases">
          <p className="mb-2 text-xs text-stone-500">From Inventory deliveries and purchases, including those paid at the Front Desk.</p>
          {data?.purchases.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {shown(data.purchases, 'purchases').map((p) => (
                <li key={p.id} className="flex justify-between gap-3 py-1.5">
                  <span>
                    {p.qty} × {p.itemName} ({p.unit})
                    <span className="text-xs text-stone-500">
                      {' '}
                      {p.vendorName && `· ${p.vendorName} `}· {longDate(p.date)}
                      {p.paidFrom && ` · from ${FUND[p.paidFrom]}`}
                    </span>
                  </span>
                  <span className="tabular-nums">{peso(p.total)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-500">None.</p>
          )}
          <ShowAll total={data?.purchases.length ?? 0} all={all.purchases} onShowAll={() => showEvery('purchases')} />
        </Card>
      </div>

      {byCategory.size > 0 && (
        <Card title="By category">
          <ul className="divide-y divide-stone-100 text-sm">
            {[...byCategory]
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <li key={k} className="flex justify-between py-1.5">
                  <span>{k}</span>
                  <span className="tabular-nums">{peso(v)}</span>
                </li>
              ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">Includes drafts not yet confirmed.</p>
        </Card>
      )}
    </div>
  );
}
