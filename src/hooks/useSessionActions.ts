'use client';

import { trpc } from '@/lib/trpc';

export interface SessionActions {
  start: (sessionId: string) => void;
  stop: (sessionId: string) => void;
  archive: (sessionId: string) => void;
  isStarting: (sessionId: string) => boolean;
  isStopping: (sessionId: string) => boolean;
  isArchiving: (sessionId: string) => boolean;
}

/**
 * Hook for session mutation actions (start, stop, archive).
 * Separates mutation logic from presentation.
 *
 * @param onSuccess - Callback to run after any successful mutation (e.g., refetch list)
 */
export function useSessionActions(onSuccess?: () => void): SessionActions {
  const startMutation = trpc.sessions.start.useMutation({
    onSuccess,
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess,
  });

  // The API endpoint is "delete" but it now archives instead of permanently deleting
  const archiveMutation = trpc.sessions.delete.useMutation({
    onSuccess,
  });

  return {
    start: (sessionId: string) => startMutation.mutate({ sessionId }),
    stop: (sessionId: string) => stopMutation.mutate({ sessionId }),
    archive: (sessionId: string) => archiveMutation.mutate({ sessionId }),
    isStarting: (sessionId: string) =>
      startMutation.isPending && startMutation.variables?.sessionId === sessionId,
    isStopping: (sessionId: string) =>
      stopMutation.isPending && stopMutation.variables?.sessionId === sessionId,
    isArchiving: (sessionId: string) =>
      archiveMutation.isPending && archiveMutation.variables?.sessionId === sessionId,
  };
}
