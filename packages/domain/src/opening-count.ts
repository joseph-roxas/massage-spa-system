import type { Grid } from './backfill';
import type { ItemKind } from './inventory';

/** One line of an Opening Count file as typed: Item and Quantity, and Unit and Kind for Items not in the catalog yet. */
export type OpeningRow = { line: number; name: string; qty: number; unit?: string; kind?: ItemKind };

/** What a line of the file becomes: a count for an Item already in the catalog, or a new Item with its count. */
export type OpeningMatch =
  | { line: number; status: 'matched'; itemId: string; name: string; unit: string; qty: number }
  | { line: number; status: 'new'; name: string; unit: string; kind: ItemKind; qty: number }
  | { line: number; status: 'problem'; name: string; message: string };

const KIND_WORDS: Record<string, ItemKind> = {
  consumable: 'consumable',
  consumables: 'consumable',
  reusable: 'reusable',
  'reusable supply': 'reusable',
  'reusable supplies': 'reusable',
  equipment: 'equipment',
};

/** Spaces tidied and case ignored, so "Bath  towel" finds "Bath Towel". */
export const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim().replace(/\s+/g, ' ');

/**
 * Reads the first sheet of an Opening Count file. The header row is the first one with "Item" and "Quantity";
 * "Unit" and "Kind" are optional columns. Blank lines are skipped. Line numbers are as Excel shows them.
 */
export function readOpeningSheet(grid: Grid): { rows: OpeningRow[]; problems: string[] } {
  const headerAt = grid.findIndex((r) => r?.some((c) => /^items?$/i.test(text(c))) && r.some((c) => /^(quantity|qty)$/i.test(text(c))));
  if (headerAt < 0) return { rows: [], problems: ['No header row found. The first sheet needs columns named Item and Quantity.'] };
  const header = grid[headerAt]!.map((c) => text(c).toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const [iItem, iQty, iUnit, iKind] = [col('item', 'items'), col('quantity', 'qty'), col('unit'), col('kind', 'type')];

  const rows: OpeningRow[] = [];
  const problems: string[] = [];
  grid.slice(headerAt + 1).forEach((r, k) => {
    const line = headerAt + 2 + k;
    const name = text(r?.[iItem]);
    const rawQty = text(r?.[iQty]);
    if (!name && !rawQty) return;
    if (!name) return void problems.push(`Line ${line}: the Item is blank.`);
    const qty = Number(rawQty);
    if (rawQty === '' || !Number.isInteger(qty) || qty < 0) return void problems.push(`Line ${line} (${name}): the Quantity must be a whole number, 0 or more.`);
    const unit = iUnit >= 0 ? text(r?.[iUnit]) : '';
    const kindText = iKind >= 0 ? text(r?.[iKind]).toLowerCase() : '';
    const kind = KIND_WORDS[kindText];
    if (kindText && !kind) return void problems.push(`Line ${line} (${name}): Kind must be Consumable, Reusable supply or Equipment.`);
    rows.push({ line, name, qty, ...(unit ? { unit } : {}), ...(kind ? { kind } : {}) });
  });
  return { rows, problems };
}

/**
 * Matches each line to the catalog by name, ignoring case and spacing, and by Unit too when given.
 * A name not in the catalog becomes a new Item, which needs its Unit and Kind. The same Item on two lines is one count, added up.
 */
export function matchOpeningRows(rows: readonly OpeningRow[], catalog: readonly { id: string; name: string; unit: string }[]): OpeningMatch[] {
  const out: OpeningMatch[] = [];
  for (const r of rows) {
    const named = catalog.filter((i) => sameName(i.name, r.name) && (!r.unit || sameName(i.unit, r.unit)));
    if (named.length > 1) {
      out.push({ line: r.line, status: 'problem', name: r.name, message: `Several items are called ${r.name}. Add the Unit to say which.` });
      continue;
    }
    const item = named[0];
    if (item) {
      const earlier = out.find((m): m is Extract<OpeningMatch, { status: 'matched' }> => m.status === 'matched' && m.itemId === item.id);
      if (earlier) earlier.qty += r.qty;
      else out.push({ line: r.line, status: 'matched', itemId: item.id, name: item.name, unit: item.unit, qty: r.qty });
      continue;
    }
    if (!r.unit || !r.kind) {
      out.push({ line: r.line, status: 'problem', name: r.name, message: `${r.name} is not in the catalog yet. Give its Unit and Kind to add it.` });
      continue;
    }
    const earlier = out.find((m): m is Extract<OpeningMatch, { status: 'new' }> => m.status === 'new' && sameName(m.name, r.name) && sameName(m.unit, r.unit!));
    if (earlier) earlier.qty += r.qty;
    else out.push({ line: r.line, status: 'new', name: r.name, unit: r.unit, kind: r.kind, qty: r.qty });
  }
  return out;
}
