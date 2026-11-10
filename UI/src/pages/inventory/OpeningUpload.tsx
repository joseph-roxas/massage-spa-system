import { useState } from 'react';
import { matchOpeningRows, readOpeningSheet, type OpeningMatch, type OpeningRow } from '@spa/domain';
import { Alert, Badge, Button, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { readWorkbook } from '../../lib/backfill';
import { todayManila } from '../../lib/format';
import { ITEM_KIND_LABELS, useInventoryAction, type Item } from '../../lib/inventory';

type Place = 'shop' | 'storage';
const PLACE_LABELS: Record<Place, string> = {
  shop: 'At the shop',
  storage: 'In my storage',
};

/** A ready file to fill in: every active Item with its Unit and Kind, Quantity left blank. */
async function downloadTemplate(items: Item[], place: Place) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Opening count');
  sheet.columns = [
    { header: 'Item', key: 'item', width: 32 },
    { header: 'Quantity', key: 'qty', width: 10 },
    { header: 'Unit', key: 'unit', width: 14 },
    { header: 'Kind', key: 'kind', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const i of items.filter((x) => x.active))
    sheet.addRow({
      item: i.name,
      qty: null,
      unit: i.unit,
      kind: ITEM_KIND_LABELS[i.kind],
    });
  const blob = new Blob([await book.xlsx.writeBuffer()], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Opening count - ${place === 'shop' ? 'shop' : 'storage'}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The Opening Count from an Excel file: one file for the shop, another for storage. Checked line by line before saving. */
export function OpeningUpload({ items, onDone }: { items: Item[]; onDone: () => void }) {
  const act = useInventoryAction();
  const [place, setPlace] = useState<Place>('shop');
  const [date, setDate] = useState(todayManila());
  const [file, setFile] = useState<{
    name: string;
    rows: OpeningRow[];
    problems: string[];
  } | null>(null);
  const [reading, setReading] = useState(false);
  const matches: OpeningMatch[] = file ? matchOpeningRows(file.rows, items) : [];
  const problems = [...(file?.problems ?? []), ...matches.flatMap((m) => (m.status === 'problem' ? [`Line ${m.line}: ${m.message}`] : []))];
  const counted = matches.filter((m): m is Exclude<OpeningMatch, { status: 'problem' }> => m.status !== 'problem');
  const ready = !!file && counted.length > 0 && problems.length === 0;

  async function read(f: File | undefined) {
    if (!f) return;
    setReading(true);
    try {
      const book = await readWorkbook(f);
      const first = Object.values(book)[0] ?? [];
      setFile({ name: f.name, ...readOpeningSheet(first) });
    } catch {
      setFile({
        name: f.name,
        rows: [],
        problems: ['This file could not be read. Save it as an Excel workbook (.xlsx) and try again.'],
      });
    } finally {
      setReading(false);
    }
  }

  return (
    <FormPanel
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate(
          {
            path: '/inventory/opening/import',
            method: 'PUT',
            body: { date, location: place, rows: file!.rows },
          },
          { onSuccess: onDone },
        );
      }}
    >
      {act.error && <Alert>{act.error.message}</Alert>}
      <p className="text-sm text-stone-600">
        Upload what you counted, one file for the shop and another for your storage. The file needs columns <b>Item</b> and <b>Quantity</b>; give <b>Unit</b>{' '}
        and <b>Kind</b> (Consumable, Reusable supply or Equipment) for items not in the list yet, and they are added. No turnover or receiving is needed.
        Uploading again replaces the count of the items in the file.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Where">
          <Select value={place} onChange={(e) => setPlace(e.target.value as Place)}>
            {Object.entries(PLACE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Counted on">
          <Input type="date" required max={todayManila()} value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </Field>
        <Field label="Excel file">
          <Input type="file" accept=".xlsx" onChange={(e) => void read(e.target.files?.[0])} />
        </Field>
        <Button type="button" variant="secondary" onClick={() => void downloadTemplate(items, place)}>
          Download a template
        </Button>
      </div>

      {reading && <p className="text-sm text-stone-500">Reading the file…</p>}
      {file && problems.length > 0 && (
        <Alert>
          <p className="font-medium">Fix these lines in {file.name}, then choose the file again. Nothing has been saved.</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.slice(0, 12).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {problems.length > 12 && <p className="mt-1">And {problems.length - 12} more.</p>}
        </Alert>
      )}
      {counted.length > 0 && (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Line</th>
                <th className={th}>Item</th>
                <th className={th}>Unit</th>
                <th className={`${th} text-right`}>Quantity</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {counted.map((m) => (
                <tr key={m.line}>
                  <td className={`${td} tabular-nums text-stone-500`}>{m.line}</td>
                  <td className={td}>{m.name}</td>
                  <td className={td}>{m.unit}</td>
                  <td className={`${td} text-right tabular-nums`}>{m.qty}</td>
                  <td className={td}>{m.status === 'new' ? <Badge tone="teal">New item · {ITEM_KIND_LABELS[m.kind]}</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready || act.isPending}>
          Save {PLACE_LABELS[place].toLowerCase()} count ({counted.length} items
          {counted.some((m) => m.status === 'new') ? `, ${counted.filter((m) => m.status === 'new').length} new` : ''})
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </FormPanel>
  );
}
