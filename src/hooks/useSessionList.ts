'use client';

import { trpc } from '@/lib/trpc';

export interface Session {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  status: string;
  updatedAt: Date;
}

export interface UseSessionListOptions {
  includeArchived?: boolean;
}

export interface UseSessionListResult {
  sessions: Session[];
  isLoading: boolean;
  refetch: () => void;
}

/**
 * Hook for fetching the list of sessions.
 * Separates data fetching logic from presentation.
 *
 * @param options.includeArchived - Whether to include archived sessions in the result
 */
export function useSessionList(options: UseSessionListOptions = {}): UseSessionListResult {
  const { includeArchived = false } = options;

  const { data, isLoading, refetch } = trpc.sessions.list.useQuery({
    includeArchived,
  });

  return {
    sessions: data?.sessions ?? [],
    isLoading,
    refetch,
  };
}
