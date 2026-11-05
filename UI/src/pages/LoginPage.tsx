import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { Alert, AuthShell, Button, Field, Input } from '../components/ui';
import { useDevice } from '../lib/attendance';
import { useCurrentUser, useLogin } from '../lib/auth';

export function LoginPage() {
  const { data: user } = useCurrentUser();
  const login = useLogin();
  const device = useDevice();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (user) return <Navigate to="/" replace />;

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate('/', { replace: true }) });
  }

  return (
    <AuthShell title="Log in">
      {device.data?.frontDesk && (
        <Link
          to="/clock"
          className="mb-6 flex h-14 w-full items-center justify-center rounded-lg bg-teal-700 text-lg font-semibold text-white hover:bg-teal-800"
        >
          Clock in or out
        </Link>
      )}
      <form onSubmit={submit} className="space-y-4">
        {login.error && <Alert>{login.error.message}</Alert>}
        <Field label="Email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      <p className="mt-6 border-t border-stone-200 pt-4 text-center text-sm text-stone-600">
        New staff member?{' '}
        <Link to="/signup" className="font-medium text-teal-700 hover:underline">
          Create New User
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-stone-500">Forgot your password? Ask the owner to reset it.</p>
    </AuthShell>
  );
}
