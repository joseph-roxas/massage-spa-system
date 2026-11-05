import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can, type Capability, type Role } from '@spa/domain';
import { api, ApiError } from './api';

export type CurrentUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  /** Under the Reliever Login: who is on the Relief Shift now. */
  actingAs?: { staffId: string; displayName: string };
  mustChangePassword: boolean;
};

const ME_KEY = ['auth', 'me'] as const;

/** The logged-in user, or null when logged out. */
export function useCurrentUser() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await api<{ user: CurrentUser }>('/auth/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useCan(capability: Capability): boolean {
  const { data } = useCurrentUser();
  return can(data?.role, capability);
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<{ user: CurrentUser }>('/auth/login', { body: input }),
    onSuccess: ({ user }) => qc.setQueryData(ME_KEY, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await api('/auth/logout', { body: {} });
      } catch (e) {
        // Already logged out is still logged out; anything else (e.g. an open Business Day) is shown.
        if (!(e instanceof ApiError && e.status === 401)) throw e;
      }
    },
    onSuccess: () => {
      // Setting (not clearing) the user keeps RequireAuth subscribed, so it redirects to /login.
      qc.setQueryData(ME_KEY, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    },
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api('/auth/change-password', { body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  });
}

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  receptionist: 'Receptionist',
  reliever: 'Reliever Login',
};
