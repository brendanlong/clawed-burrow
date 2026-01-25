'use client';

import { useCallback, useMemo, useEffect, useRef, use, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { SessionHeader } from '@/components/SessionHeader';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
import { ClaudeStatusIndicator } from '@/components/ClaudeStatusIndicator';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useNotification } from '@/hooks/useNotification';

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

const MESSAGE_PAGE_SIZE = 20;

/**
 * Hook to refetch data when the app regains visibility or network reconnects.
 * This handles cases where SSE connection was lost and the UI shows stale state.
 */
function useRefetchOnReconnect(refetch: () => void) {
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refetch();
      }
    };

    const handleOnline = () => {
      refetch();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [refetch]);
}

/**
 * Hook for managing session state: fetching session data, SSE updates, and start/stop mutations.
 */
function useSessionState(sessionId: string) {
  const utils = trpc.useUtils();

  // Fetch session details
  const { data: sessionData, isLoading, refetch } = trpc.sessions.get.useQuery({ sessionId });

  // Refetch session data when app regains visibility or network reconnects
  useRefetchOnReconnect(refetch);

  // Subscribe to session updates via SSE - update cache directly
  trpc.sse.onSessionUpdate.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        const session = trackedData.data.session as NonNullable<typeof sessionData>['session'];
        utils.sessions.get.setData({ sessionId }, { session });
      },
      onError: (err) => {
        console.error('Session SSE error:', err);
      },
    }
  );

  // Mutations - update cache directly from returned data
  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: (data) => {
      utils.sessions.get.setData({ sessionId }, { session: data.session });
    },
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: (data) => {
      utils.sessions.get.setData({ sessionId }, { session: data.session });
    },
  });

  // The API endpoint is "delete" but it now archives instead of permanently deleting
  // Session update comes via SSE subscription (lines 64-75), so no onSuccess handler needed
  const archiveMutation = trpc.sessions.delete.useMutation();

  const start = useCallback(() => {
    startMutation.mutate({ sessionId });
  }, [sessionId, startMutation]);

  const stop = useCallback(() => {
    stopMutation.mutate({ sessionId });
  }, [sessionId, stopMutation]);

  const archive = useCallback(() => {
    archiveMutation.mutate({ sessionId });
  }, [sessionId, archiveMutation]);

  return {
    session: sessionData?.session,
    isLoading,
    start,
    stop,
    archive,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isArchiving: archiveMutation.isPending,
  };
}

/**
 * Hook for managing message state: history pagination, SSE updates for new messages, and token usage.
 */
function useSessionMessages(sessionId: string) {
  const utils = trpc.useUtils();

  // Bidirectional infinite query for message history
  // - fetchNextPage: loads older messages (backward) when user scrolls up
  // - New messages arrive via SSE and are added directly to the cache
  const {
    data: historyData,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = trpc.claude.getHistory.useInfiniteQuery(
    { sessionId, limit: MESSAGE_PAGE_SIZE },
    {
      // Limit stored pages to prevent memory growth
      // With MESSAGE_PAGE_SIZE messages per page, this keeps up to 10000 messages in memory
      maxPages: 500,
      // Message data is immutable - never refetch automatically
      staleTime: Infinity,
      initialCursor: {
        direction: 'backward',
        sequence: undefined,
      },
      // For loading OLDER messages (user scrolls up)
      getNextPageParam: (lastPage, allPages) => {
        if (!lastPage.hasMore) return undefined;
        // Find the oldest sequence across ALL pages (not just lastPage, which might be empty)
        let oldestSequence: number | undefined;
        for (const page of allPages) {
          for (const msg of page.messages) {
            if (oldestSequence === undefined || msg.sequence < oldestSequence) {
              oldestSequence = msg.sequence;
            }
          }
        }
        return { sequence: oldestSequence, direction: 'backward' as const };
      },
    }
  );

  // Fetch token usage stats (computed server-side from all messages)
  const { data: tokenUsageData, refetch: refetchTokenUsage } = trpc.claude.getTokenUsage.useQuery(
    { sessionId },
    {
      // Refetch less frequently since it's just for display
      refetchOnWindowFocus: false,
    }
  );

  // Compute newest sequence from cache for SSE catch-up cursor
  const newestSequence = useMemo(() => {
    if (!historyData?.pages) return undefined;
    let newest: number | undefined;
    for (const page of historyData.pages) {
      for (const msg of page.messages) {
        if (newest === undefined || msg.sequence > newest) {
          newest = msg.sequence;
        }
      }
    }
    return newest;
  }, [historyData]);

  // Subscribe to new messages via SSE - update cache directly
  // Pass cursor to catch up on missed messages when connecting/reconnecting
  trpc.sse.onNewMessage.useSubscription(
    { sessionId, afterSequence: newestSequence },
    {
      onData: (trackedData) => {
        const newMessage = trackedData.data.message;

        // Add message directly to the infinite query cache
        utils.claude.getHistory.setInfiniteData({ sessionId, limit: MESSAGE_PAGE_SIZE }, (old) => {
          if (!old) {
            // No existing data - create initial page
            return {
              pages: [{ messages: [newMessage], hasMore: false }],
              pageParams: [{ direction: 'backward' as const, sequence: undefined }],
            };
          }

          // Check if message already exists - if so, replace it (for partial message updates)
          let messageReplaced = false;
          const newPages = old.pages.map((page) => {
            const existingIndex = page.messages.findIndex((m) => m.id === newMessage.id);
            if (existingIndex !== -1) {
              // Replace existing message with updated content
              messageReplaced = true;
              const updatedMessages = [...page.messages];
              updatedMessages[existingIndex] = newMessage;
              return { ...page, messages: updatedMessages };
            }
            return page;
          });

          if (messageReplaced) {
            return { ...old, pages: newPages };
          }

          // New message - append to the first page (newest messages)
          newPages[0] = {
            ...newPages[0],
            messages: [...newPages[0].messages, newMessage],
          };

          return { ...old, pages: newPages };
        });

        // Refetch token usage since new messages affect the total
        // Only refetch if this is not a partial message (sequence >= 0 means it's saved to DB)
        if (newMessage.sequence >= 0) {
          refetchTokenUsage();
        }
      },
      onError: (err) => {
        console.error('Message SSE error:', err);
      },
    }
  );

  // Flatten bidirectional pages into chronological order
  // Pages array structure:
  // - pages[0] = newest (from fetchPreviousPage, or initial if no previous fetched)
  // - pages[n-1] = oldest (from fetchNextPage)
  // Each page's messages are already in chronological order
  const messages = useMemo(() => {
    if (!historyData?.pages) return [];

    const result: Message[] = [];
    // Reverse pages to get oldest-first, then flatten
    for (const page of [...historyData.pages].reverse()) {
      for (const msg of page.messages) {
        result.push({
          id: msg.id,
          type: msg.type,
          content: msg.content,
          sequence: msg.sequence,
        });
      }
    }
    return result;
  }, [historyData]);

  return {
    messages,
    isLoading,
    isFetchingMore: isFetchingNextPage,
    hasMore: hasNextPage ?? false,
    fetchMore: fetchNextPage,
    tokenUsage: tokenUsageData,
  };
}

/**
 * Hook for managing working indicator state: page title and favicon based on Claude running status.
 * Includes cleanup to reset title and favicon when the component unmounts.
 */
function useWorkingIndicator(sessionName: string | undefined, isWorking: boolean) {
  // Dynamic page title based on Claude running state
  useEffect(() => {
    if (!sessionName) return;
    const baseTitle = `${sessionName} - Clawed Burrow`;
    document.title = isWorking ? `Working - ${baseTitle}` : baseTitle;

    return () => {
      document.title = 'Clawed Burrow';
    };
  }, [sessionName, isWorking]);

  // Dynamic favicon based on Claude running state
  useEffect(() => {
    const faviconPath = isWorking ? '/favicon-working.svg' : '/favicon.svg';
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      document.head.appendChild(link);
    }
    link.href = faviconPath;

    return () => {
      const linkEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (linkEl) {
        linkEl.href = '/favicon.svg';
      }
    };
  }, [isWorking]);
}

/**
 * Hook for managing Claude process state: running status, send prompts, and interrupt.
 */
function useClaudeState(sessionId: string) {
  // Local state for Claude running status (overridden by SSE, initialized from query)
  const [runningOverride, setRunningOverride] = useState<boolean | null>(null);

  // Initial fetch of Claude running state
  const { data: runningData, refetch } = trpc.claude.isRunning.useQuery({ sessionId });

  // Refetch and reset override when app regains visibility or network reconnects
  const refetchAndReset = useCallback(() => {
    // Reset override so we use fresh data from the query
    setRunningOverride(null);
    refetch();
  }, [refetch]);
  useRefetchOnReconnect(refetchAndReset);

  // Subscribe to Claude running state via SSE
  trpc.sse.onClaudeRunning.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        setRunningOverride(trackedData.data.running);
      },
      onError: (err) => {
        console.error('Claude running SSE error:', err);
      },
    }
  );

  const sendMutation = trpc.claude.send.useMutation();
  const interruptMutation = trpc.claude.interrupt.useMutation();

  const send = useCallback(
    (prompt: string) => {
      sendMutation.mutate({ sessionId, prompt });
    },
    [sessionId, sendMutation]
  );

  const interrupt = useCallback(() => {
    interruptMutation.mutate({ sessionId });
  }, [sessionId, interruptMutation]);

  // Use SSE override if available, otherwise use query data
  const isRunning = runningOverride ?? runningData?.running ?? false;

  return {
    isRunning,
    send,
    interrupt,
    isInterrupting: interruptMutation.isPending,
  };
}

function SessionView({ sessionId }: { sessionId: string }) {
  // Session state: data, start/stop/archive
  const {
    session,
    isLoading: sessionLoading,
    start,
    stop,
    archive,
    isStarting,
    isStopping,
    isArchiving,
  } = useSessionState(sessionId);

  // Message state: history, pagination, token usage
  const {
    messages,
    isLoading: messagesLoading,
    isFetchingMore,
    hasMore,
    fetchMore,
    tokenUsage,
  } = useSessionMessages(sessionId);

  // Claude state: running, send, interrupt
  const {
    isRunning: isClaudeRunning,
    send: sendPrompt,
    interrupt,
    isInterrupting,
  } = useClaudeState(sessionId);

  // Working indicator: page title and favicon
  useWorkingIndicator(session?.name, isClaudeRunning);

  // Request notification permission on mount
  const { requestPermission, permission } = useNotification();
  useEffect(() => {
    // Request permission if not yet decided
    if (permission === 'default') {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const handleSendPrompt = useCallback(
    (prompt: string) => {
      if (!session || session.status !== 'running') {
        return;
      }
      sendPrompt(prompt);
    },
    [session, sendPrompt]
  );

  // Track whether we've already sent the initial prompt
  const initialPromptSentRef = useRef(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  // Send the initial prompt when session transitions to running for the first time
  useEffect(() => {
    if (!session) return;

    const wasCreating = prevStatusRef.current === 'creating';
    const isNowRunning = session.status === 'running';
    const hasInitialPrompt = !!session.initialPrompt;
    const noMessagesSent = messages.length === 0;

    // Update previous status
    prevStatusRef.current = session.status;

    // Only send initial prompt on transition from creating to running,
    // when there's a prompt, no messages have been sent yet, and we haven't already sent it
    if (
      wasCreating &&
      isNowRunning &&
      hasInitialPrompt &&
      noMessagesSent &&
      !initialPromptSentRef.current &&
      session.initialPrompt // TypeScript narrowing
    ) {
      initialPromptSentRef.current = true;
      sendPrompt(session.initialPrompt);
    }
  }, [session, messages.length, sendPrompt]);

  if (sessionLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <p className="text-muted-foreground">Session not found</p>
        <Button variant="link" asChild className="mt-4">
          <Link href="/">Back to sessions</Link>
        </Button>
      </div>
    );
  }

  // Show creation progress, error state, or archived state
  if (
    session.status === 'creating' ||
    session.status === 'error' ||
    session.status === 'archived'
  ) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <SessionHeader
          session={session}
          onStart={() => {}}
          onStop={() => {}}
          isStarting={false}
          isStopping={false}
        />
        {session.status === 'creating' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <Spinner size="lg" />
            <p className="text-muted-foreground">
              {session.statusMessage || 'Setting up session...'}
            </p>
          </div>
        )}
        {session.status === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="text-destructive text-lg">Setup Failed</div>
            <p className="text-muted-foreground max-w-md text-center">
              {session.statusMessage || 'An unknown error occurred'}
            </p>
            <Button variant="outline" asChild className="mt-4">
              <Link href="/">Back to sessions</Link>
            </Button>
          </div>
        )}
        {session.status === 'archived' && (
          <>
            <MessageList
              messages={messages}
              isLoading={messagesLoading || isFetchingMore}
              hasMore={hasMore}
              onLoadMore={fetchMore}
              tokenUsage={tokenUsage}
              onSendResponse={() => {}}
              isClaudeRunning={false}
            />
            <div className="border-t bg-muted/50 px-4 py-3 text-center text-sm text-muted-foreground">
              This session has been archived. You can view the message history but cannot send new
              prompts.
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SessionHeader
        session={session}
        onStart={start}
        onStop={stop}
        onArchive={archive}
        isStarting={isStarting}
        isStopping={isStopping}
        isArchiving={isArchiving}
      />

      <MessageList
        messages={messages}
        isLoading={messagesLoading || isFetchingMore}
        hasMore={hasMore}
        onLoadMore={fetchMore}
        tokenUsage={tokenUsage}
        onSendResponse={handleSendPrompt}
        isClaudeRunning={isClaudeRunning}
      />

      <ClaudeStatusIndicator isRunning={isClaudeRunning} containerStatus={session.status} />

      <PromptInput
        onSubmit={handleSendPrompt}
        onInterrupt={interrupt}
        isRunning={isClaudeRunning}
        isInterrupting={isInterrupting}
        disabled={session.status !== 'running'}
      />
    </div>
  );
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);

  return (
    <AuthGuard>
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <Header />
        <SessionView sessionId={resolvedParams.id} />
      </div>
    </AuthGuard>
  );
}
