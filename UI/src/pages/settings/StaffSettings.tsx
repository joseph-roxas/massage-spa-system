import { useState, type FormEvent } from 'react';
import { certificateStatus, DEFAULT_CONTRIBUTION_RATES, govIdWarning, monthlyContributions, type ContributionRates, type GovId } from '@spa/domain';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { usePayRules, useSave, useStaff, type Certificate, type Qualification, type StaffMember } from '../../lib/catalogue';
import { longDate, parsePesos, peso, pesosText, todayManila } from '../../lib/format';

type Role = 'regular' | 'lmt' | 'receptionist';

const ROLE_LABEL: Record<Role, string> = {
  regular: 'Regular Therapist',
  lmt: 'Licensed Massage Therapist',
  receptionist: 'Receptionist',
};

const QUALIFICATION_LABEL: Record<Qualification, string> = {
  doh: 'DOH-licensed',
  nc2: 'NC-II holder',
  nuat_thai_trained: 'Nuat Thai trained only',
  experience: 'Experience only',
};

const CERT_LABEL = { nc2: 'TESDA NC-II', doh: 'DOH licence' } as const;

const roleOf = (s: StaffMember): Role => (s.kind === 'receptionist' ? 'receptionist' : (s.therapistClass ?? 'regular'));

type Draft = {
  lastName: string;
  firstName: string;
  middleName: string;
  displayName: string;
  role: Role;
  qualification: Qualification | '';
  gender: 'female' | 'male' | '';
  birthdate: string;
  birthplace: string;
  civilStatus: StaffMember['civilStatus'] | '';
  religion: string;
  address: string;
  email: string;
  sssNo: string;
  phicNo: string;
  tin: string;
  pagibigNo: string;
  hireDate: string;
  isOnCall: boolean;
  dailyRate: string;
  contributionBase: string;
  govSss: string;
  govPhic: string;
  govPagibig: string;
  active: boolean;
};

const GOV_FIELDS: [GovId, 'sssNo' | 'phicNo' | 'tin' | 'pagibigNo', string][] = [
  ['sss', 'sssNo', 'SSS no.'],
  ['phic', 'phicNo', 'PhilHealth (PHIC) no.'],
  ['pagibig', 'pagibigNo', 'Pag-IBIG no.'],
  ['tin', 'tin', 'TIN'],
];

/** What a salary basis means each month, given which ID numbers are on file. */
function basisHint(d: Draft, rates: ContributionRates): string {
  const base = parsePesos(d.contributionBase);
  if (base === null) return 'Leave blank to keep fixed weekly amounts';
  const c = monthlyContributions(base, rates, { sss: !!d.sssNo.trim(), phic: !!d.phicNo.trim(), pagibig: !!d.pagibigNo.trim() });
  const missing = [!d.sssNo.trim() && 'SSS', !d.phicNo.trim() && 'PhilHealth', !d.pagibigNo.trim() && 'Pag-IBIG'].filter(Boolean);
  return `Monthly: employee ${peso(c.ee)}, employer ${peso(c.er)}${missing.length ? ` (no ${missing.join(', ')} number yet)` : ''}`;
}

function StaffForm({ member, onDone }: { member?: StaffMember; onDone: () => void }) {
  const [d, setD] = useState<Draft>({
    lastName: member?.lastName ?? '',
    firstName: member?.firstName ?? '',
    middleName: member?.middleName ?? '',
    displayName: member?.displayName ?? '',
    role: member ? roleOf(member) : 'regular',
    qualification: member?.qualification ?? '',
    gender: member?.gender ?? '',
    birthdate: member?.birthdate ?? '',
    birthplace: member?.birthplace ?? '',
    civilStatus: member?.civilStatus ?? '',
    religion: member?.religion ?? '',
    address: member?.address ?? '',
    email: member?.email ?? '',
    sssNo: member?.sssNo ?? '',
    phicNo: member?.phicNo ?? '',
    tin: member?.tin ?? '',
    pagibigNo: member?.pagibigNo ?? '',
    hireDate: member?.hireDate ?? '',
    isOnCall: member?.isOnCall ?? false,
    dailyRate: member?.dailyRate != null ? pesosText(member.dailyRate) : '',
    contributionBase: member?.contributionBase != null ? pesosText(member.contributionBase) : '',
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
  const rules = usePayRules();
  const rates = (rules.data?.payRules.contribution_rates as ContributionRates | undefined) ?? DEFAULT_CONTRIBUTION_RATES;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (d.role === 'lmt' && d.qualification !== 'doh') return setError('Only a DOH-licensed therapist can be a Licensed Massage Therapist.');
    const body: Record<string, unknown> = {
      lastName: d.lastName,
      firstName: d.firstName,
      middleName: d.middleName,
      displayName: d.displayName || d.firstName,
      gender: d.gender || null,
      birthdate: d.birthdate || null,
      birthplace: d.birthplace,
      civilStatus: d.civilStatus || null,
      religion: d.religion,
      address: d.address,
      email: d.email,
      sssNo: d.sssNo,
      phicNo: d.phicNo,
      tin: d.tin,
      pagibigNo: d.pagibigNo,
      hireDate: d.hireDate || null,
      qualification: isReceptionist ? null : d.qualification || null,
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
    if (d.isOnCall && !isReceptionist) body.contributionBase = null;
    else if (d.contributionBase.trim() === '') body.contributionBase = null;
    else {
      const base = parsePesos(d.contributionBase);
      if (base === null) return setError('Enter the monthly salary basis in pesos.');
      body.contributionBase = base;
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Surname">
          <Input required value={d.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </Field>
        <Field label="First name">
          <Input required value={d.firstName} onChange={(e) => set('firstName', e.target.value)} />
        </Field>
        <Field label="Middle name">
          <Input value={d.middleName} onChange={(e) => set('middleName', e.target.value)} />
        </Field>
        <Field label="Shown as" hint="On the Clock-in Screen and Rotation">
          <Input value={d.displayName} placeholder={d.firstName} onChange={(e) => set('displayName', e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Role">
          <Select
            value={d.role}
            disabled={!!member && (member.kind === 'receptionist') !== isReceptionist}
            onChange={(e) => {
              const role = e.target.value as Role;
              setD((x) => ({ ...x, role, qualification: role === 'lmt' ? 'doh' : x.qualification }));
            }}
          >
            {(member ? (member.kind === 'receptionist' ? ['receptionist'] : ['regular', 'lmt']) : ['regular', 'lmt', 'receptionist']).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r as Role]}
              </option>
            ))}
          </Select>
        </Field>
        {!isReceptionist && (
          <Field label="Qualification" hint={d.role === 'lmt' ? 'An LMT must be DOH-licensed' : undefined}>
            <Select value={d.qualification} onChange={(e) => set('qualification', e.target.value as Qualification | '')}>
              <option value="">—</option>
              {Object.entries(QUALIFICATION_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Hire date">
          <Input type="date" required value={d.hireDate} onChange={(e) => set('hireDate', e.target.value)} />
        </Field>
      </div>

      <h4 className="pt-2 text-sm font-semibold text-stone-700">Personal record</h4>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Gender">
          <Select required value={d.gender} onChange={(e) => set('gender', e.target.value as Draft['gender'])}>
            <option value="">Choose…</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </Select>
        </Field>
        <Field label="Birthdate">
          <Input type="date" required max={todayManila()} value={d.birthdate} onChange={(e) => set('birthdate', e.target.value)} />
        </Field>
        <Field label="Birthplace">
          <Input value={d.birthplace} onChange={(e) => set('birthplace', e.target.value)} />
        </Field>
        <Field label="Civil status">
          <Select value={d.civilStatus ?? ''} onChange={(e) => set('civilStatus', e.target.value as Draft['civilStatus'])}>
            <option value="">—</option>
            <option value="single">Single</option>
            <option value="married">Married</option>
            <option value="widowed">Widowed</option>
            <option value="separated">Separated</option>
          </Select>
        </Field>
        <Field label="Religion">
          <Input value={d.religion} onChange={(e) => set('religion', e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={d.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="Address">
            <Input value={d.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
        </div>
      </div>

      <h4 className="pt-2 text-sm font-semibold text-stone-700">Government IDs</h4>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {GOV_FIELDS.map(([id, key, label]) => (
          <Field key={key} label={label} hint={govIdWarning(id, d[key]) ?? undefined}>
            <Input value={d[key]} onChange={(e) => set(key, e.target.value)} />
          </Field>
        ))}
      </div>

      <h4 className="pt-2 text-sm font-semibold text-stone-700">Pay</h4>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {isReceptionist && (
          <Field label="Daily rate (₱)">
            <Input inputMode="decimal" required value={d.dailyRate} onChange={(e) => set('dailyRate', e.target.value)} />
          </Field>
        )}
        {!(d.isOnCall && !isReceptionist) && (
          <div className="col-span-2">
            <Field label="Monthly salary basis for SSS, PhilHealth, Pag-IBIG (₱)" hint={basisHint(d, rates)}>
              <Input inputMode="decimal" value={d.contributionBase} onChange={(e) => set('contributionBase', e.target.value)} placeholder="E.g. 8000" />
            </Field>
          </div>
        )}
        {!(d.isOnCall && !isReceptionist) && d.contributionBase.trim() === '' && (
          <>
            <Field label="SSS / week (₱)" hint={member ? 'Fixed amount, without a salary basis' : 'Blank = default'}>
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
      <div className="flex flex-wrap gap-6">
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

function CertificateBadge({ cert }: { cert: Certificate }) {
  const { status, daysLeft } = certificateStatus(cert.expiresOn, todayManila());
  const tone = status === 'expired' ? 'red' : status === 'expiring' ? 'amber' : 'teal';
  const when =
    status === 'expired' ? 'expired' : status === 'expiring' ? `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : cert.expiresOn ? `to ${longDate(cert.expiresOn)}` : '';
  return (
    <Badge tone={tone}>
      {cert.type === 'doh' ? 'DOH' : 'NC-II'} {when}
    </Badge>
  );
}

/** A Therapist's NC-II and DOH Certificates, with their expiry dates. */
function Certificates({ member, onDone }: { member: StaffMember; onDone: () => void }) {
  const add = useSave((body: Record<string, unknown>) => ({ path: `/settings/staff/${member.id}/certificates`, body }), 'settings');
  const remove = useSave((id: string) => ({ path: `/settings/certificates/${id}`, method: 'DELETE' }), 'settings');
  const [d, setD] = useState({ type: 'doh' as 'doh' | 'nc2', number: '', issuedOn: '', expiresOn: '' });

  return (
    <FormPanel
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ type: d.type, number: d.number, issuedOn: d.issuedOn || null, expiresOn: d.expiresOn || null }, { onSuccess: () => setD({ ...d, number: '', issuedOn: '', expiresOn: '' }) });
      }}
    >
      {(add.error || remove.error) && <Alert>{(add.error ?? remove.error)!.message}</Alert>}
      {member.certificates.length === 0 ? (
        <p className="text-sm text-stone-500">No certificates on file.</p>
      ) : (
        <ul className="divide-y divide-stone-100 text-sm">
          {member.certificates.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="w-28 font-medium">{CERT_LABEL[c.type]}</span>
              <span className="flex-1 text-stone-600">
                {c.number ?? 'No number'}
                {c.issuedOn && ` · issued ${longDate(c.issuedOn)}`}
                {c.expiresOn ? ` · expires ${longDate(c.expiresOn)}` : ' · no expiry date'}
              </span>
              <CertificateBadge cert={c} />
              <button type="button" className="text-xs text-stone-500 underline" onClick={() => confirm(`Remove this ${CERT_LABEL[c.type]}?`) && remove.mutate(c.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Certificate">
          <Select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as 'doh' | 'nc2' })}>
            <option value="doh">DOH licence</option>
            <option value="nc2">TESDA NC-II</option>
          </Select>
        </Field>
        <Field label="Number">
          <Input value={d.number} onChange={(e) => setD({ ...d, number: e.target.value })} />
        </Field>
        <Field label="Issued on">
          <Input type="date" value={d.issuedOn} onChange={(e) => setD({ ...d, issuedOn: e.target.value })} />
        </Field>
        <Field label="Expires on">
          <Input type="date" value={d.expiresOn} onChange={(e) => setD({ ...d, expiresOn: e.target.value })} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={add.isPending}>Add certificate</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Done</Button>
      </div>
    </FormPanel>
  );
}

function StaffRow({ member }: { member: StaffMember }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'pin' | 'certs'>('view');
  const role = roleOf(member);
  const isTherapist = member.kind === 'therapist';
  const incomplete = !member.gender || !member.birthdate || !member.hireDate;
  const doh = member.certificates.filter((c) => c.type === 'doh');
  const lmtLapsed = role === 'lmt' && doh.length > 0 && doh.every((c) => certificateStatus(c.expiresOn, todayManila()).status === 'expired');
  return (
    <>
      <tr className={member.active ? '' : 'opacity-50'}>
        <td className={td}>
          <p className="font-medium">{member.displayName}</p>
          <p className="text-xs text-stone-500">
            {member.lastName}, {member.firstName} {member.middleName ?? ''}
          </p>
          {incomplete && <Badge tone="amber">Personal record incomplete</Badge>}
        </td>
        <td className={td}>
          {ROLE_LABEL[role]}
          {member.qualification && <span className="block text-xs text-stone-500">{QUALIFICATION_LABEL[member.qualification]}</span>}
          <div className="mt-1 flex flex-wrap gap-1">
            {member.isOnCall && <Badge tone="amber">On-call</Badge>}
            {!member.active && <Badge tone="red">Inactive</Badge>}
            {lmtLapsed && <Badge tone="red">LMT – licence expired</Badge>}
            {member.certificates.map((c) => (
              <CertificateBadge key={c.id} cert={c} />
            ))}
          </div>
        </td>
        <td className={`${td} tabular-nums`}>{member.dailyRate != null ? `${peso(member.dailyRate)}/day` : 'Commission'}</td>
        <td className={`${td} text-xs tabular-nums text-stone-600`}>
          {member.isOnCall
            ? '—'
            : member.contributionBase != null
              ? `Basis ${peso(member.contributionBase)}/month`
              : `SSS ${peso(member.govSss)} · PHIC ${peso(member.govPhic)} · Pag-IBIG ${peso(member.govPagibig)} / week`}
        </td>
        <td className={td}>{member.hasPin ? <Badge tone="teal">Set</Badge> : <Badge tone="amber">Not set</Badge>}</td>
        <td className={`${td} whitespace-nowrap text-right`}>
          <Button variant="secondary" className="h-8 px-3" onClick={() => setMode('pin')}>PIN</Button>{' '}
          {isTherapist && (
            <>
              <Button variant="secondary" className="h-8 px-3" onClick={() => setMode('certs')}>Certificates</Button>{' '}
            </>
          )}
          <Button variant="secondary" className="h-8 px-3" onClick={() => setMode('edit')}>Edit</Button>
        </td>
      </tr>
      {mode !== 'view' && (
        <tr>
          <td colSpan={6} className="px-3 pb-3">
            {mode === 'edit' ? (
              <StaffForm member={member} onDone={() => setMode('view')} />
            ) : mode === 'certs' ? (
              <Certificates member={member} onDone={() => setMode('view')} />
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
        Everyone who works at the shop. Staff are separate from login accounts: therapists only need a PIN for the Clock-in Screen. Personal records and
        government IDs are visible to the owner only.
      </p>
      {error && <Alert>{error.message}</Alert>}
      {adding && (
        <div className="mb-4">
          <StaffForm onDone={() => setAdding(false)} />
        </div>
      )}
      {data?.staff.length === 0 && !adding && <p className="text-sm text-stone-500">No staff yet. Add your therapists and receptionist.</p>}
      {!!data?.staff.length && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200">
                <th className={th}>Name</th>
                <th className={th}>Role</th>
                <th className={th}>Pay</th>
                <th className={th}>Contributions</th>
                <th className={th}>PIN</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.staff.map((s) => <StaffRow key={s.id} member={s} />)}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
