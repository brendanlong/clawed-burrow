'use client';

import { trpc } from '@/lib/trpc';

export interface AuthSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  lastActivityAt: Date;
  revokedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

export interface UseAuthSessionsResult {
  sessions: AuthSession[];
  isLoading: boolean;
  refetch: () => void;
}

/**
 * Hook for fetching the list of auth sessions.
 * Separates data fetching logic from presentation.
 */
export function useAuthSessions(): UseAuthSessionsResult {
  const { data, isLoading, refetch } = trpc.auth.listSessions.useQuery();

  return {
    sessions: data?.sessions ?? [],
    isLoading,
    refetch,
  };
}
