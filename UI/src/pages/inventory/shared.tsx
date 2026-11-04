import { Select } from '../../components/ui';
import { useInventoryAction, useVendors } from '../../lib/inventory';

const NEW = '__new__';

/** Vendor dropdown with a "new vendor" choice that adds one on the spot. */
export function VendorPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data } = useVendors();
  const add = useInventoryAction();
  return (
    <>
      <Select
        required
        value={value}
        onChange={(e) => {
          if (e.target.value !== NEW) return onChange(e.target.value);
          const name = prompt('Vendor name');
          if (name?.trim()) add.mutate({ path: '/inventory/vendors', body: { name: name.trim() } }, { onSuccess: (r) => r.id && onChange(r.id) });
        }}
      >
        <option value="">Choose…</option>
        {(data?.vendors ?? [])
          .filter((v) => v.active || v.id === value)
          .map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        <option value={NEW}>+ New vendor…</option>
      </Select>
      {add.error && <span className="mt-1 block text-xs text-red-700">{add.error.message}</span>}
    </>
  );
}
