import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type AttentionItem = {
  key: string;
  /** Overdue or expired. */
  tone: 'urgent' | 'normal';
  title: string;
  detail: string | null;
  link: string;
};

/** What waits on the Super Admin; refreshed every minute and whenever the window regains focus. */
export const useAttention = (enabled: boolean) =>
  useQuery({
    queryKey: ['attention'],
    queryFn: () => api<{ items: AttentionItem[] }>('/attention'),
    enabled,
    refetchInterval: 60_000,
  });
