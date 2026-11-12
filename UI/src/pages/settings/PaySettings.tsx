import { useState, type FormEvent } from 'react';
import { withDefaultRates, type ContributionRates } from '@spa/domain';
import { Alert, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { useCommissionRates, usePayRules, useSave } from '../../lib/catalogue';
import { longDate, parsePesos, percent, pesosText, todayManila } from '../../lib/format';
import { TimeInput } from '../../components/TimeInput';

const CLASS_LABEL = { regular: 'Regular Therapist', lmt: 'Licensed Massage Therapist' } as const;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Shift = { start: string; end: string; mealBreakMin: number };
type Premium = { workedPct: number; otPct: number };
type Premiums = Record<'ordinary' | 'restDay' | 'special' | 'specialOnRestDay' | 'regular' | 'regularOnRestDay', Premium> & {
  regularUnworkedPct: number;
};
type GovShares = { sss: number; phic: number; pagibig: number };
type GovDefaults = { therapist: GovShares; receptionist: GovShares };

const PREMIUM_ROWS: [keyof Omit<Premiums, 'regularUnworkedPct'>, string][] = [
  ['ordinary', 'Ordinary day'],
  ['restDay', 'Rest Day'],
  ['special', 'Special Day'],
  ['specialOnRestDay', 'Special Day on Rest Day'],
  ['regular', 'Regular Holiday'],
  ['regularOnRestDay', 'Regular Holiday on Rest Day'],
];

function CommissionRates() {
  const { data } = useCommissionRates();
  const [adding, setAdding] = useState(false);
  const [d, setD] = useState({ therapistClass: 'regular' as 'regular' | 'lmt', normal: '', holiday: '', effectiveFrom: todayManila() });
  const save = useSave((body: Record<string, unknown>) => ({ path: '/settings/commission-rates', body }), 'settings');
  const today = todayManila();

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      {
        therapistClass: d.therapistClass,
        normalBp: Math.round(Number(d.normal) * 100),
        holidayBp: Math.round(Number(d.holiday) * 100),
        effectiveFrom: d.effectiveFrom,
      },
      { onSuccess: () => setAdding(false) },
    );
  }

  return (
    <Card title="Commission rates" actions={!adding && <Button onClick={() => setAdding(true)}>Change a rate</Button>}>
      <p className="mb-3 text-sm text-stone-500">Always on the Regular Price, including FOCs and vouchers.</p>
      {adding && (
        <div className="mb-4">
          <FormPanel onSubmit={submit}>
            {save.error && <Alert>{save.error.message}</Alert>}
            <div className="grid grid-cols-4 gap-3">
              <Field label="Therapist">
                <Select value={d.therapistClass} onChange={(e) => setD({ ...d, therapistClass: e.target.value as 'regular' | 'lmt' })}>
                  <option value="regular">{CLASS_LABEL.regular}</option>
                  <option value="lmt">{CLASS_LABEL.lmt}</option>
                </Select>
              </Field>
              <Field label="Normal (%)">
                <Input type="number" min={0} max={100} step={0.01} required value={d.normal} onChange={(e) => setD({ ...d, normal: e.target.value })} />
              </Field>
              <Field label="Holiday (%)">
                <Input type="number" min={0} max={100} step={0.01} required value={d.holiday} onChange={(e) => setD({ ...d, holiday: e.target.value })} />
              </Field>
              <Field label="Takes effect on">
                <Input type="date" min={today} required value={d.effectiveFrom} onChange={(e) => setD({ ...d, effectiveFrom: e.target.value })} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending}>Save rate</Button>
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </FormPanel>
        </div>
      )}
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-200">
            <th className={th}>Therapist</th>
            <th className={th}>Normal</th>
            <th className={th}>Holiday</th>
            <th className={th}>From</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {data?.commissionRates.map((r) => (
            <tr key={r.id} className={r.effectiveFrom > today ? 'text-amber-700' : ''}>
              <td className={td}>{CLASS_LABEL[r.therapistClass]}</td>
              <td className={td}>{percent(r.normalBp)}</td>
              <td className={td}>{percent(r.holidayBp)}</td>
              <td className={td}>{r.effectiveFrom > today ? `Upcoming: ${longDate(r.effectiveFrom)}` : longDate(r.effectiveFrom)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function usePayRule<T>(key: string) {
  const save = useSave((value: T) => ({ path: `/settings/pay-rules/${key}`, method: 'PUT', body: { value } }), 'settings');
  return save;
}

function ReceptionistRules({ rules }: { rules: Record<string, unknown> }) {
  const [shift, setShift] = useState(rules.receptionist_shift as Shift);
  const [restDay, setRestDay] = useState(rules.receptionist_rest_weekday as number);
  const [premiums, setPremiums] = useState(rules.receptionist_premiums as Premiums);
  const [saved, setSaved] = useState(false);
  const saveShift = usePayRule<Shift>('receptionist_shift');
  const saveRest = usePayRule<number>('receptionist_rest_weekday');
  const savePremiums = usePayRule<Premiums>('receptionist_premiums');
  const error = saveShift.error ?? saveRest.error ?? savePremiums.error;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    await Promise.all([saveShift.mutateAsync(shift), saveRest.mutateAsync(restDay), savePremiums.mutateAsync(premiums)]).catch(() => {});
    setSaved(true);
  }

  const setPremium = (row: keyof Omit<Premiums, 'regularUnworkedPct'>, field: keyof Premium, v: string) =>
    setPremiums((p) => ({ ...p, [row]: { ...p[row], [field]: Number(v) } }));

  return (
    <Card title="Receptionist pay rules">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error.message}</Alert>}
        {saved && !error && <Alert tone="success">Saved.</Alert>}
        <div className="grid grid-cols-4 gap-3">
          <Field label="Shift starts" hint="Arriving later is Undertime">
            <TimeInput required value={shift.start} onChange={(v) => setShift({ ...shift, start: v })} />
          </Field>
          <Field label="Shift ends" hint="Time after this is Overtime">
            <TimeInput required value={shift.end} onChange={(v) => setShift({ ...shift, end: v })} />
          </Field>
          <Field label="Unpaid meal break (min)">
            <Input type="number" min={0} max={240} required value={shift.mealBreakMin} onChange={(e) => setShift({ ...shift, mealBreakMin: Number(e.target.value) })} />
          </Field>
          <Field label="Rest Day">
            <Select value={restDay} onChange={(e) => setRestDay(Number(e.target.value))}>
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Day worked</th>
              <th className={th}>Pay (% of daily rate)</th>
              <th className={th}>Overtime (% of hourly rate)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {PREMIUM_ROWS.map(([key, label]) => (
              <tr key={key}>
                <td className={td}>{label}</td>
                <td className={td}>
                  <div className="w-28">
                    <Input type="number" min={0} max={1000} required value={premiums[key].workedPct} onChange={(e) => setPremium(key, 'workedPct', e.target.value)} />
                  </div>
                </td>
                <td className={td}>
                  <div className="w-28">
                    <Input type="number" min={0} max={1000} required value={premiums[key].otPct} onChange={(e) => setPremium(key, 'otPct', e.target.value)} />
                  </div>
                </td>
              </tr>
            ))}
            <tr>
              <td className={td}>Regular Holiday, not worked</td>
              <td className={td}>
                <div className="w-28">
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    required
                    value={premiums.regularUnworkedPct}
                    onChange={(e) => setPremiums({ ...premiums, regularUnworkedPct: Number(e.target.value) })}
                  />
                </div>
              </td>
              <td className={td} />
            </tr>
          </tbody>
        </table>
        <Button type="submit" disabled={saveShift.isPending || saveRest.isPending || savePremiums.isPending}>
          Save receptionist rules
        </Button>
      </form>
    </Card>
  );
}

function GovDefaultsCard({ value }: { value: GovDefaults }) {
  const toText = (g: GovShares) => ({ sss: pesosText(g.sss), phic: pesosText(g.phic), pagibig: pesosText(g.pagibig) });
  const [d, setD] = useState({ therapist: toText(value.therapist), receptionist: toText(value.receptionist) });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = usePayRule<GovDefaults>('gov_deduction_defaults');
  const edit = (next: typeof d) => {
    setD(next);
    setSaved(false);
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const parse = (g: typeof d.therapist): GovShares | null => {
      const sss = parsePesos(g.sss), phic = parsePesos(g.phic), pagibig = parsePesos(g.pagibig);
      return sss === null || phic === null || pagibig === null ? null : { sss, phic, pagibig };
    };
    const therapist = parse(d.therapist), receptionist = parse(d.receptionist);
    if (!therapist || !receptionist) return setError('All amounts must be pesos.');
    setError(null);
    save.mutate({ therapist, receptionist }, { onSuccess: () => setSaved(true) });
  }

  return (
    <Card title="Default fixed weekly deductions (older records)">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-stone-500">Used only for staff without a monthly salary basis. Set a salary basis under Staff to use the brackets instead.</p>
        {(error || save.error) && <Alert>{error ?? save.error?.message}</Alert>}
        {saved && <Alert tone="success">Saved.</Alert>}
        {(['therapist', 'receptionist'] as const).map((who) => (
          <div key={who} className="grid grid-cols-4 items-end gap-3">
            <p className="pb-2 text-sm font-medium capitalize">{who}</p>
            {(['sss', 'phic', 'pagibig'] as const).map((k) => (
              <Field key={k} label={{ sss: 'SSS', phic: 'PhilHealth', pagibig: 'Pag-IBIG' }[k]}>
                <Input inputMode="decimal" required value={d[who][k]} onChange={(e) => edit({ ...d, [who]: { ...d[who], [k]: e.target.value } })} />
              </Field>
            ))}
          </div>
        ))}
        <Button type="submit" disabled={save.isPending}>Save defaults</Button>
      </form>
    </Card>
  );
}

type Rates = ContributionRates;

/** Percent text for basis points, and back. */
const bpText = (bp: number) => String(bp / 100);
const parseBp = (t: string) => (Number.isFinite(Number(t)) && t.trim() !== '' ? Math.round(Number(t) * 100) : null);

/** SSS, PhilHealth and Pag-IBIG rates: change them when the agencies issue new circulars. */
function ContributionRatesCard({ value }: { value: Rates }) {
  const fields = [
    ['sss', 'eeBp', 'SSS employee %', 'bp'],
    ['sss', 'erBp', 'SSS employer %', 'bp'],
    ['sss', 'mscMin', 'SSS lowest salary credit', 'peso'],
    ['sss', 'mscMax', 'SSS highest salary credit', 'peso'],
    ['sss', 'ecLow', 'EC below ₱15,000 credit', 'peso'],
    ['sss', 'ecHigh', 'EC from ₱15,000 credit', 'peso'],
    ['phic', 'bp', 'PhilHealth % (split equally)', 'bp'],
    ['phic', 'floor', 'PhilHealth salary floor', 'peso'],
    ['phic', 'ceiling', 'PhilHealth salary ceiling', 'peso'],
    ['pagibig', 'eeBp', 'Pag-IBIG employee %', 'bp'],
    ['pagibig', 'erBp', 'Pag-IBIG employer %', 'bp'],
    ['pagibig', 'fundSalaryMax', 'Pag-IBIG maximum fund salary', 'peso'],
  ] as const;
  const read = (agency: keyof Rates, key: string, kind: 'bp' | 'peso') => {
    const v = (value[agency] as Record<string, number>)[key]!;
    return kind === 'bp' ? bpText(v) : pesosText(v);
  };
  const [d, setD] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(([a, k, , kind]) => [`${a}.${k}`, read(a, k, kind)])));
  const [atMaximum, setAtMaximum] = useState(value.pagibig.atMaximum ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = usePayRule<Rates>('contribution_rates');

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = structuredClone(value);
    for (const [a, k, , kind] of fields) {
      const v = kind === 'bp' ? parseBp(d[`${a}.${k}`]!) : parsePesos(d[`${a}.${k}`]!);
      if (v === null) return setError('Every rate must be a number.');
      (next[a] as Record<string, number>)[k] = v;
    }
    next.pagibig.atMaximum = atMaximum;
    setError(null);
    save.mutate(next, { onSuccess: () => setSaved(true) });
  }

  return (
    <Card title="SSS, PhilHealth and Pag-IBIG rates">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-stone-500">
          Used with each person's monthly salary basis (under Staff) for their deductions and your employer share. Set from SSS Circular 2024-006, PhilHealth
          Advisory 2025-0002 and HDMF Circular 460; update them when the agencies change their rates.
        </p>
        {(error || save.error) && <Alert>{error ?? save.error?.message}</Alert>}
        {saved && <Alert tone="success">Saved. Recompute this month's employer contributions on the Finance page.</Alert>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {fields.map(([a, k, label]) => (
            <Field key={`${a}.${k}`} label={label}>
              <Input
                inputMode="decimal"
                required
                value={d[`${a}.${k}`]}
                onChange={(e) => {
                  setD({ ...d, [`${a}.${k}`]: e.target.value });
                  setSaved(false);
                }}
              />
            </Field>
          ))}
        </div>
        <Checkbox
          label="Remit Pag-IBIG on the maximum fund salary for everyone, whatever their salary basis"
          checked={atMaximum}
          onChange={(e) => {
            setAtMaximum(e.target.checked);
            setSaved(false);
          }}
        />
        <Button type="submit" disabled={save.isPending}>Save rates</Button>
      </form>
    </Card>
  );
}

/** What a Reliever earns for a Relief Shift; the Receptionist's own rate is on her Staff record. */
function TakeHomeFloorCard({ value }: { value: number }) {
  const [text, setText] = useState(pesosText(value));
  const [saved, setSaved] = useState(false);
  const save = usePayRule<number>('take_home_floor');
  const amount = parsePesos(text);
  return (
    <Card title="Take-home Floor">
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount !== null) save.mutate(amount, { onSuccess: () => setSaved(true) });
        }}
      >
        <Field label="Least a therapist takes home in a week" hint="Government Deductions stop here. The rest is held over and collected from later weeks.">
          <Input
            inputMode="decimal"
            required
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            className="w-36"
          />
        </Field>
        <Button type="submit" disabled={amount === null || save.isPending}>Save</Button>
        {save.error && <span className="text-sm text-red-700">{save.error.message}</span>}
        {saved && !save.error && <span className="text-sm text-teal-700">Saved.</span>}
      </form>
    </Card>
  );
}

function MinimumWageCard({ value }: { value: number }) {
  const [text, setText] = useState(pesosText(value));
  const [saved, setSaved] = useState(false);
  const save = usePayRule<number>('minimum_wage_daily');
  const amount = parsePesos(text);
  return (
    <Card title="Minimum Wage Rate">
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount) save.mutate(amount, { onSuccess: () => setSaved(true) });
        }}
      >
        <Field label="Daily minimum wage (Cebu)" hint="Paid to Relievers. The Receptionist’s daily rate is set on her Staff record.">
          <Input
            inputMode="decimal"
            required
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            className="w-36"
          />
        </Field>
        <Button type="submit" disabled={!amount || save.isPending}>Save</Button>
        {save.error && <span className="text-sm text-red-700">{save.error.message}</span>}
        {saved && !save.error && <span className="text-sm text-teal-700">Saved.</span>}
      </form>
    </Card>
  );
}

export function PaySettings() {
  const { data, error } = usePayRules();
  return (
    <div className="space-y-6">
      <CommissionRates />
      {error && <Alert>{error.message}</Alert>}
      {data && (
        <>
          <ReceptionistRules rules={data.payRules} />
          <MinimumWageCard value={(data.payRules.minimum_wage_daily as number | undefined) ?? 58_200} />
          <TakeHomeFloorCard value={(data.payRules.take_home_floor as number | undefined) ?? 100_000} />
          <ContributionRatesCard value={withDefaultRates(data.payRules.contribution_rates as Partial<Rates> | undefined)} />
          <GovDefaultsCard value={data.payRules.gov_deduction_defaults as GovDefaults} />
        </>
      )}
    </div>
  );
}
