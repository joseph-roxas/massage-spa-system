import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { Alert, AuthShell, Button, Field, Input } from '../components/ui';
import { api } from '../lib/api';

export function SignupPage() {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '', confirm: '' });
  const [mismatch, setMismatch] = useState(false);
  const signup = useMutation({
    mutationFn: (input: Omit<typeof form, 'confirm'>) => api('/auth/signup', { body: input }),
  });

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) return setMismatch(true);
    setMismatch(false);
    const { confirm: _confirm, ...input } = form;
    signup.mutate(input);
  }

  if (signup.isSuccess) {
    return (
      <AuthShell title="Request sent">
        <Alert tone="success">
          Your request is waiting for the owner&apos;s approval. You can log in once it&apos;s approved.
        </Alert>
        <Link to="/login" className="mt-6 block text-center text-sm font-medium text-teal-700 hover:underline">
          Back to log in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create New User" subtitle="The owner approves every new account.">
      <form onSubmit={submit} className="space-y-4">
        {signup.error && <Alert>{signup.error.message}</Alert>}
        {mismatch && <Alert>The two passwords don&apos;t match.</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input required autoComplete="given-name" value={form.firstName} onChange={set('firstName')} />
          </Field>
          <Field label="Last name">
            <Input required autoComplete="family-name" value={form.lastName} onChange={set('lastName')} />
          </Field>
        </div>
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.password}
            onChange={set('password')}
          />
        </Field>
        <Field label="Confirm password">
          <Input type="password" required autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
        </Field>
        <Button type="submit" className="w-full" disabled={signup.isPending}>
          {signup.isPending ? 'Sending…' : 'Send request'}
        </Button>
      </form>
      <Link to="/login" className="mt-6 block text-center text-sm text-stone-600 hover:underline">
        Already have an account? Log in
      </Link>
    </AuthShell>
  );
}
