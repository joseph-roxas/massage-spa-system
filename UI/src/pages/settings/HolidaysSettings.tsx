import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { useHolidays, useSave, type Holiday } from '../../lib/catalogue';
import { longDate, todayManila } from '../../lib/format';

function HolidayForm({ holiday, onDone }: { holiday?: Holiday; onDone: () => void }) {
  const [d, setD] = useState<Holiday>(holiday ?? { date: todayManila(), name: '', type: 'regular', raisesCommission: true });
  const save = useSave(({ date, ...body }: Holiday) => ({ path: `/catalogue/holidays/${date}`, method: 'PUT', body }), 'catalogue');
  const set = <K extends keyof Holiday>(k: K, v: Holiday[K]) => setD((x) => ({ ...x, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(d, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="grid grid-cols-4 items-end gap-3">
        <Field label="Date">
          <Input type="date" required disabled={!!holiday} value={d.date} onChange={(e) => set('date', e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Name">
            <Input required value={d.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
        </div>
        <Field label="Type" hint="Sets the receptionist's holiday pay">
          <Select value={d.type} onChange={(e) => set('type', e.target.value as Holiday['type'])}>
            <option value="regular">Regular Holiday</option>
            <option value="special">Special Day</option>
          </Select>
        </Field>
      </div>
      <Checkbox
        label="Therapists earn holiday commission (50% / 60%) on this day"
        checked={d.raisesCommission}
        onChange={(e) => set('raisesCommission', e.target.checked)}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>Save holiday</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

export function HolidaysSettings() {
  const [year, setYear] = useState(todayManila().slice(0, 4));
  const { data, error } = useHolidays(year);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const remove = useSave((date: string) => ({ path: `/catalogue/holidays/${date}`, method: 'DELETE' }), 'catalogue');
  const thisYear = Number(todayManila().slice(0, 4));

  return (
    <Card
      title="Holidays"
      actions={
        <div className="flex items-center gap-2">
          <div className="w-28">
            <Select aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <option key={y}>{y}</option>
              ))}
            </Select>
          </div>
          {editing !== 'new' && <Button onClick={() => setEditing('new')}>Add holiday</Button>}
        </div>
      }
    >
      {error && <Alert>{error.message}</Alert>}
      {editing === 'new' && (
        <div className="mb-4">
          <HolidayForm onDone={() => setEditing(null)} />
        </div>
      )}
      {data?.holidays.length === 0 && <p className="text-sm text-stone-500">No holidays entered for {year}.</p>}
      {!!data?.holidays.length && (
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Date</th>
              <th className={th}>Holiday</th>
              <th className={th}>Type</th>
              <th className={th}>Holiday commission</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {data.holidays.map((h) =>
              editing === h.date ? (
                <tr key={h.date}>
                  <td colSpan={5} className="py-2">
                    <HolidayForm holiday={h} onDone={() => setEditing(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={h.date}>
                  <td className={td}>{longDate(h.date)}</td>
                  <td className={td}>{h.name}</td>
                  <td className={td}>{h.type === 'regular' ? 'Regular Holiday' : 'Special Day'}</td>
                  <td className={td}>{h.raisesCommission ? <Badge tone="teal">Yes</Badge> : <Badge>No</Badge>}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    <Button variant="secondary" className="h-8 px-3" onClick={() => setEditing(h.date)}>Edit</Button>{' '}
                    <Button
                      variant="danger"
                      className="h-8 px-3"
                      onClick={() => confirm(`Remove ${h.name}?`) && remove.mutate(h.date)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}
