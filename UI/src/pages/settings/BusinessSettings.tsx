import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input } from '../../components/ui';
import { shrinkLogo, useBranding, useSaveBranding, type Branding } from '../../lib/branding';

function BusinessForm({ saved }: { saved: Branding }) {
  const save = useSaveBranding();
  const [businessName, setName] = useState(saved.businessName ?? '');
  const [logo, setLogo] = useState(saved.logo);
  const [problem, setProblem] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    save.reset();
    try {
      setLogo(await shrinkLogo(file));
    } catch {
      setProblem('That file could not be read as an image. Try a PNG or JPG.');
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ businessName: businessName.trim() || null, logo });
  }

  return (
    <form className="max-w-lg space-y-4" onSubmit={submit}>
      <p className="text-sm text-stone-600">Shown in the side menu, the login page, the Clock-in Screen and printed Payslips. The logo is also the browser tab icon.</p>
      {(problem || save.error) && <Alert>{problem ?? save.error!.message}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved.</Alert>}
      <Field label="Business name">
        <Input maxLength={120} value={businessName} onChange={(e) => setName(e.target.value)} placeholder="E.g. Nuat Thai Lawaan" />
      </Field>
      <Field label="Logo" hint="A PNG, JPG or WebP image; it is shrunk automatically">
        <div className="flex items-center gap-4">
          {logo && <img src={logo} alt="Logo preview" className="h-16 w-16 rounded border border-stone-200 object-contain" />}
          <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose logo" className="text-sm" onChange={(e) => pick(e.target.files?.[0])} />
          {logo && (
            <button type="button" className="text-xs text-stone-500 underline" onClick={() => setLogo(null)}>
              Remove
            </button>
          )}
        </div>
      </Field>
      <Button type="submit" disabled={save.isPending}>Save</Button>
    </form>
  );
}

/** The business's own name and logo, set by the Super Admin. */
export function BusinessSettings() {
  const { data, error } = useBranding();
  return (
    <Card title="Business">
      {error && <Alert>{error.message}</Alert>}
      {data && <BusinessForm saved={data} />}
    </Card>
  );
}
