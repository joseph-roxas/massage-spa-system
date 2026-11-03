import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, AuthShell, Button, Field, Input } from '../components/ui';
import { useChangePassword, useCurrentUser, useLogout } from '../lib/auth';

export function ChangePasswordPage() {
  const { data: user } = useCurrentUser();
  const change = useChangePassword();
  const logout = useLogout();
  const navigate = useNavigate();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [mismatch, setMismatch] = useState(false);
  const forced = user?.mustChangePassword ?? false;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return setMismatch(true);
    setMismatch(false);
    change.mutate(
      { currentPassword: form.currentPassword, newPassword: form.newPassword },
      { onSuccess: () => navigate('/', { replace: true }) },
    );
  }

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <AuthShell
      title="Change password"
      subtitle={forced ? 'Your password was reset. Choose a new one to continue.' : undefined}
    >
      <form onSubmit={submit} className="space-y-4">
        {change.error && <Alert>{change.error.message}</Alert>}
        {mismatch && <Alert>The two new passwords don&apos;t match.</Alert>}
        <Field label={forced ? 'Temporary password' : 'Current password'}>
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={set('currentPassword')}
          />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.newPassword}
            onChange={set('newPassword')}
          />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" required autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
        </Field>
        <Button type="submit" className="w-full" disabled={change.isPending}>
          Save new password
        </Button>
        {forced ? (
          <Button type="button" variant="secondary" className="w-full" onClick={() => logout.mutate()}>
            Log out
          </Button>
        ) : (
          <Button type="button" variant="secondary" className="w-full" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        )}
      </form>
    </AuthShell>
  );
}
