import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { useSave, useStaff, type StaffMember } from '../../lib/catalogue';
import { parsePesos, peso, pesosText } from '../../lib/format';

type Role = 'regular' | 'lmt' | 'receptionist';

const ROLE_LABEL: Record<Role, string> = {
  regular: 'Regular Therapist',
  lmt: 'Licensed Massage Therapist',
  receptionist: 'Receptionist',
};

const roleOf = (s: StaffMember): Role => (s.kind === 'receptionist' ? 'receptionist' : (s.therapistClass ?? 'regular'));

type Draft = {
  firstName: string;
  lastName: string;
  displayName: string;
  role: Role;
  isOnCall: boolean;
  dailyRate: string;
  govSss: string;
  govPhic: string;
  govPagibig: string;
  active: boolean;
};

function StaffForm({ member, onDone }: { member?: StaffMember; onDone: () => void }) {
  const [d, setD] = useState<Draft>({
    firstName: member?.firstName ?? '',
    lastName: member?.lastName ?? '',
    displayName: member?.displayName ?? '',
    role: member ? roleOf(member) : 'regular',
    isOnCall: member?.isOnCall ?? false,
    dailyRate: member?.dailyRate != null ? pesosText(member.dailyRate) : '',
    govSss: member ? pesosText(member.govSss) : '',
    govPhic: member ? pesosText(member.govPhic) : '',
    govPagibig: member ? pesosText(member.govPagibig) : '',
    active: member?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (body: Record<string, unknown>) =>
      member ? { path: `/settings/staff/${member.id}`, method: 'PATCH', body } : { path: '/settings/staff', body },
    'settings',
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const isReceptionist = d.role === 'receptionist';

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      firstName: d.firstName,
      lastName: d.lastName,
      displayName: d.displayName || d.firstName,
      active: d.active,
      isOnCall: isReceptionist ? false : d.isOnCall,
      therapistClass: isReceptionist ? null : d.role,
    };
    if (!member) body.kind = isReceptionist ? 'receptionist' : 'therapist';
    if (isReceptionist) {
      const rate = parsePesos(d.dailyRate);
      if (rate === null) return setError('Enter the daily rate in pesos.');
      body.dailyRate = rate;
    }
    // Blank deduction fields on a new record use the defaults from Commission & Pay.
    for (const k of ['govSss', 'govPhic', 'govPagibig'] as const) {
      if (d.isOnCall && !isReceptionist) body[k] = 0;
      else if (d[k] !== '') {
        const v = parsePesos(d[k]);
        if (v === null) return setError('Deductions must be peso amounts.');
        body[k] = v;
      }
    }
    setError(null);
    save.mutate(body, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {(error || save.error) && <Alert>{error ?? save.error?.message}</Alert>}
      <div className="grid grid-cols-4 gap-3">
        <Field label="First name">
          <Input required value={d.firstName} onChange={(e) => set('firstName', e.target.value)} />
        </Field>
        <Field label="Last name">
          <Input required value={d.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </Field>
        <Field label="Shown as" hint="On the Clock-in Screen and Rotation">
          <Input value={d.displayName} placeholder={d.firstName} onChange={(e) => set('displayName', e.target.value)} />
        </Field>
        <Field label="Role">
          <Select
            value={d.role}
            disabled={!!member && (member.kind === 'receptionist') !== isReceptionist}
            onChange={(e) => set('role', e.target.value as Role)}
          >
            {(member ? (member.kind === 'receptionist' ? ['receptionist'] : ['regular', 'lmt']) : ['regular', 'lmt', 'receptionist']).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r as Role]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {isReceptionist && (
          <Field label="Daily rate (₱)">
            <Input inputMode="decimal" required value={d.dailyRate} onChange={(e) => set('dailyRate', e.target.value)} />
          </Field>
        )}
        {!(d.isOnCall && !isReceptionist) && (
          <>
            <Field label="SSS / week (₱)" hint={member ? undefined : 'Blank = default'}>
              <Input inputMode="decimal" value={d.govSss} onChange={(e) => set('govSss', e.target.value)} />
            </Field>
            <Field label="PhilHealth / week (₱)">
              <Input inputMode="decimal" value={d.govPhic} onChange={(e) => set('govPhic', e.target.value)} />
            </Field>
            <Field label="Pag-IBIG / week (₱)">
              <Input inputMode="decimal" value={d.govPagibig} onChange={(e) => set('govPagibig', e.target.value)} />
            </Field>
          </>
        )}
      </div>
      <div className="flex gap-6">
        {!isReceptionist && (
          <Checkbox
            label="On-call (paid end of day, no deductions or cash advances)"
            checked={d.isOnCall}
            onChange={(e) => set('isOnCall', e.target.checked)}
          />
        )}
        <Checkbox label="Currently working here" checked={d.active} onChange={(e) => set('active', e.target.checked)} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>{member ? 'Save changes' : 'Add staff member'}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

function PinForm({ member, onDone }: { member: StaffMember; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const save = useSave((body: { pin: string }) => ({ path: `/settings/staff/${member.id}/pin`, body }), 'settings');
  return (
    <FormPanel onSubmit={(e) => { e.preventDefault(); save.mutate({ pin }, { onSuccess: onDone }); }}>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="flex items-end gap-3">
        <div className="w-40">
          <Field label={`New PIN for ${member.displayName}`} hint="4 digits, used on the Clock-in Screen">
            <Input inputMode="numeric" pattern="\d{4}" maxLength={4} required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
        <Button type="submit" disabled={save.isPending}>Set PIN</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

function StaffRow({ member }: { member: StaffMember }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'pin'>('view');
  const role = roleOf(member);
  return (
    <>
      <tr className={member.active ? '' : 'opacity-50'}>
        <td className={td}>
          <p className="font-medium">{member.displayName}</p>
          <p className="text-xs text-stone-500">
            {member.firstName} {member.lastName}
          </p>
        </td>
        <td className={td}>
          {ROLE_LABEL[role]}
          <div className="mt-1 flex gap-1">
            {member.isOnCall && <Badge tone="amber">On-call</Badge>}
            {!member.active && <Badge tone="red">Inactive</Badge>}
          </div>
        </td>
        <td className={`${td} tabular-nums`}>{member.dailyRate != null ? `${peso(member.dailyRate)}/day` : 'Commission'}</td>
        <td className={`${td} text-xs tabular-nums text-stone-600`}>
          {member.isOnCall ? '—' : `SSS ${peso(member.govSss)} · PHIC ${peso(member.govPhic)} · Pag-IBIG ${peso(member.govPagibig)}`}
        </td>
        <td className={td}>{member.hasPin ? <Badge tone="teal">Set</Badge> : <Badge tone="amber">Not set</Badge>}</td>
        <td className={`${td} whitespace-nowrap text-right`}>
          <Button variant="secondary" className="h-8 px-3" onClick={() => setMode('pin')}>PIN</Button>{' '}
          <Button variant="secondary" className="h-8 px-3" onClick={() => setMode('edit')}>Edit</Button>
        </td>
      </tr>
      {mode !== 'view' && (
        <tr>
          <td colSpan={6} className="px-3 pb-3">
            {mode === 'edit' ? (
              <StaffForm member={member} onDone={() => setMode('view')} />
            ) : (
              <PinForm member={member} onDone={() => setMode('view')} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function StaffSettings() {
  const { data, error } = useStaff();
  const [adding, setAdding] = useState(false);
  return (
    <Card title="Staff" actions={!adding && <Button onClick={() => setAdding(true)}>Add staff member</Button>}>
      <p className="mb-4 text-sm text-stone-500">
        Everyone who works at the shop. Staff are separate from login accounts: therapists only need a PIN for the Clock-in Screen.
      </p>
      {error && <Alert>{error.message}</Alert>}
      {adding && (
        <div className="mb-4">
          <StaffForm onDone={() => setAdding(false)} />
        </div>
      )}
      {data?.staff.length === 0 && !adding && <p className="text-sm text-stone-500">No staff yet. Add your therapists and receptionist.</p>}
      {!!data?.staff.length && (
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Name</th>
              <th className={th}>Role</th>
              <th className={th}>Pay</th>
              <th className={th}>Weekly deductions</th>
              <th className={th}>PIN</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {data.staff.map((s) => <StaffRow key={s.id} member={s} />)}
          </tbody>
        </table>
      )}
    </Card>
  );
}
