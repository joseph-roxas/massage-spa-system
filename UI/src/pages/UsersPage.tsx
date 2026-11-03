import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@spa/domain';
import { Alert, Button, Card, Field, Input, Select } from '../components/ui';
import { api } from '../lib/api';
import { ROLE_LABELS, useCurrentUser } from '../lib/auth';

type UserStatus = 'pending' | 'active' | 'rejected' | 'disabled';

type UserRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role | null;
  status: UserStatus;
  mustChangePassword: boolean;
  createdAt: string;
};

const STATUS_STYLES: Record<UserStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-stone-200 text-stone-600',
  disabled: 'bg-red-100 text-red-700',
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });

function useUserAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api(`/users/${id}/${action}`, { body: body ?? {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

function PendingRequest({ user }: { user: UserRow }) {
  const [role, setRole] = useState<Role>('receptionist');
  const action = useUserAction();
  return (
    <li className="flex items-center gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {user.firstName} {user.lastName}
        </p>
        <p className="truncate text-sm text-stone-500">
          {user.email} · requested {fmtDate(user.createdAt)}
        </p>
      </div>
      <div className="w-44">
        <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="receptionist">{ROLE_LABELS.receptionist}</option>
          <option value="super_admin">{ROLE_LABELS.super_admin}</option>
        </Select>
      </div>
      <Button disabled={action.isPending} onClick={() => action.mutate({ id: user.id, action: 'approve', body: { role } })}>
        Approve
      </Button>
      <Button
        variant="danger"
        disabled={action.isPending}
        onClick={() => {
          if (confirm(`Reject ${user.firstName} ${user.lastName}'s request?`)) action.mutate({ id: user.id, action: 'reject' });
        }}
      >
        Reject
      </Button>
    </li>
  );
}

function ResetPasswordForm({ user, onDone }: { user: UserRow; onDone: () => void }) {
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const action = useUserAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    action.mutate({ id: user.id, action: 'reset-password', body: { temporaryPassword } }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} className="mt-3 flex items-end gap-3 rounded-md bg-stone-50 p-3">
      <div className="flex-1">
        <Field
          label={`Temporary password for ${user.firstName}`}
          hint="Tell them in person. They must choose their own at next login."
        >
          <Input required minLength={8} value={temporaryPassword} onChange={(e) => setTemporaryPassword(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" disabled={action.isPending}>
        Reset
      </Button>
      <Button type="button" variant="secondary" onClick={onDone}>
        Cancel
      </Button>
      {action.error && <Alert>{action.error.message}</Alert>}
    </form>
  );
}

function UserLine({ user, isMe }: { user: UserRow; isMe: boolean }) {
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useUserAction();
  return (
    <li className="py-3">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {user.firstName} {user.lastName} {isMe && <span className="text-sm text-stone-500">(you)</span>}
          </p>
          <p className="truncate text-sm text-stone-500">{user.email}</p>
        </div>
        <span className="w-28 text-sm text-stone-600">{user.role ? ROLE_LABELS[user.role] : '—'}</span>
        <span className={`w-24 rounded-full px-2 py-0.5 text-center text-xs font-medium ${STATUS_STYLES[user.status]}`}>
          {user.status}
        </span>
        <div className="flex w-64 justify-end gap-2">
          {!isMe && user.status === 'active' && (
            <>
              <Button variant="secondary" onClick={() => setResetting(true)}>
                Reset password
              </Button>
              <Button
                variant="danger"
                disabled={action.isPending}
                onClick={() => {
                  if (confirm(`Disable ${user.firstName}? They will be logged out immediately.`)) {
                    action.mutate({ id: user.id, action: 'disable' });
                  }
                }}
              >
                Disable
              </Button>
            </>
          )}
          {user.status === 'disabled' && (
            <Button variant="secondary" disabled={action.isPending} onClick={() => action.mutate({ id: user.id, action: 'enable' })}>
              Enable
            </Button>
          )}
        </div>
      </div>
      {notice && (
        <div className="mt-2">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {resetting && (
        <ResetPasswordForm
          user={user}
          onDone={() => {
            setResetting(false);
            setNotice(`${user.firstName}'s password was reset.`);
          }}
        />
      )}
    </li>
  );
}

export function UsersPage() {
  const { data: me } = useCurrentUser();
  const { data, isPending, error } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: UserRow[] }>('/users'),
  });
  const pending = data?.users.filter((u) => u.status === 'pending') ?? [];
  const others = data?.users.filter((u) => u.status !== 'pending') ?? [];

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      {error && <Alert>{error.message}</Alert>}
      <Card title={`Pending requests${pending.length ? ` (${pending.length})` : ''}`}>
        {isPending ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-stone-500">No one is waiting for approval.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {pending.map((u) => (
              <PendingRequest key={u.id} user={u} />
            ))}
          </ul>
        )}
      </Card>
      <Card title="All users">
        <ul className="divide-y divide-stone-100">
          {others.map((u) => (
            <UserLine key={u.id} user={u} isMe={u.id === me?.id} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
