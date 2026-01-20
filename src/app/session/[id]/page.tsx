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

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

function SessionView({ sessionId }: { sessionId: string }) {
  // Local state for Claude running status (overridden by SSE, initialized from query)
  const [claudeRunningOverride, setClaudeRunningOverride] = useState<boolean | null>(null);

  // Fetch session details
  const {
    data: sessionData,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = trpc.sessions.get.useQuery({ sessionId });

  // Bidirectional infinite query for message history
  // - fetchNextPage: loads older messages (backward) when user scrolls up
  // - fetchPreviousPage: loads newer messages (forward) triggered by SSE
  const {
    data: historyData,
    isLoading: historyLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    fetchPreviousPage,
  } = trpc.claude.getHistory.useInfiniteQuery(
    { sessionId, limit: 10 },
    {
      // Limit stored pages to prevent memory growth
      // With 10 messages per page, this keeps up to 5000 messages in memory
      maxPages: 500,
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
      // For loading NEWER messages (triggered by SSE)
      getPreviousPageParam: (_firstPage, allPages) => {
        // Find the newest sequence across ALL pages (not just firstPage, which might be empty)
        // This prevents refetching everything if an empty page was prepended
        let newestSequence: number | undefined;
        for (const page of allPages) {
          for (const msg of page.messages) {
            if (newestSequence === undefined || msg.sequence > newestSequence) {
              newestSequence = msg.sequence;
            }
          }
        }
        return { sequence: newestSequence, direction: 'forward' as const };
      },
    }
  );

  // Initial fetch of Claude running state
  const { data: runningData } = trpc.claude.isRunning.useQuery({ sessionId });

  // Use SSE override if available, otherwise use query data
  const isClaudeRunning = claudeRunningOverride ?? runningData?.running ?? false;

  // Subscribe to session updates via SSE
  trpc.sse.onSessionUpdate.useSubscription(
    { sessionId },
    {
      onData: () => {
        // Refetch session when we get an update event
        refetchSession();
      },
      onError: (err) => {
        console.error('Session SSE error:', err);
      },
    }
  );

  // Subscribe to new messages via SSE
  trpc.sse.onNewMessage.useSubscription(
    { sessionId },
    {
      onData: () => {
        // Fetch new messages when we get a new message event
        fetchPreviousPage();
      },
      onError: (err) => {
        console.error('Message SSE error:', err);
      },
    }
  );

  // Subscribe to Claude running state via SSE
  trpc.sse.onClaudeRunning.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        // Update local state directly from SSE
        // trackedData is wrapped by tracked() - access the data property
        const data = trackedData.data;
        setClaudeRunningOverride(data.running);
      },
      onError: (err) => {
        console.error('Claude running SSE error:', err);
      },
    }
  );

  // Mutations
  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: () => refetchSession(),
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: () => refetchSession(),
  });

  const interruptMutation = trpc.claude.interrupt.useMutation();
  const sendMutation = trpc.claude.send.useMutation();

  // Flatten bidirectional pages into chronological order
  // Pages array structure:
  // - pages[0] = newest (from fetchPreviousPage, or initial if no previous fetched)
  // - pages[n-1] = oldest (from fetchNextPage)
  // Each page's messages are already in chronological order
  const allMessages = useMemo(() => {
    if (!historyData?.pages) return [];

    const messages: Message[] = [];
    // Reverse pages to get oldest-first, then flatten
    for (const page of [...historyData.pages].reverse()) {
      for (const msg of page.messages) {
        messages.push({
          id: msg.id,
          type: msg.type,
          content: msg.content,
          sequence: msg.sequence,
        });
      }
    }
    return messages;
  }, [historyData]);

  const handleSendPrompt = useCallback(
    (prompt: string) => {
      if (!sessionData?.session || sessionData.session.status !== 'running') {
        return;
      }
      sendMutation.mutate({ sessionId, prompt });
    },
    [sessionId, sessionData, sendMutation]
  );

  const handleInterrupt = useCallback(() => {
    interruptMutation.mutate({ sessionId });
  }, [sessionId, interruptMutation]);

  const session = sessionData?.session;

  // Track whether we've already sent the initial prompt
  const initialPromptSentRef = useRef(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  // Send the initial prompt when session transitions to running for the first time
  useEffect(() => {
    if (!session) return;

    const wasCreating = prevStatusRef.current === 'creating';
    const isNowRunning = session.status === 'running';
    const hasInitialPrompt = !!session.initialPrompt;
    const noMessagesSent = allMessages.length === 0;

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
      sendMutation.mutate({ sessionId, prompt: session.initialPrompt });
    }
  }, [session, allMessages.length, sessionId, sendMutation]);

  // Dynamic page title based on Claude running state
  useEffect(() => {
    if (!session) return;
    const baseTitle = `${session.name} - Claude Code Local Web`;
    document.title = isClaudeRunning ? `Working - ${baseTitle}` : baseTitle;
  }, [session, isClaudeRunning]);

  // Dynamic favicon based on Claude running state
  useEffect(() => {
    const faviconPath = isClaudeRunning ? '/favicon-working.svg' : '/favicon.svg';
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      document.head.appendChild(link);
    }
    link.href = faviconPath;
  }, [isClaudeRunning]);

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

  // Show creation progress or error state
  if (session.status === 'creating' || session.status === 'error') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <SessionHeader
          session={session}
          onStart={() => {}}
          onStop={() => {}}
          isStarting={false}
          isStopping={false}
        />
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          {session.status === 'creating' && (
            <>
              <Spinner size="lg" />
              <p className="text-muted-foreground">
                {session.statusMessage || 'Setting up session...'}
              </p>
            </>
          )}
          {session.status === 'error' && (
            <>
              <div className="text-destructive text-lg">Setup Failed</div>
              <p className="text-muted-foreground max-w-md text-center">
                {session.statusMessage || 'An unknown error occurred'}
              </p>
              <Button variant="outline" asChild className="mt-4">
                <Link href="/">Back to sessions</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SessionHeader
        session={session}
        onStart={() => startMutation.mutate({ sessionId })}
        onStop={() => stopMutation.mutate({ sessionId })}
        isStarting={startMutation.isPending}
        isStopping={stopMutation.isPending}
      />

      <MessageList
        messages={allMessages}
        isLoading={historyLoading || isFetchingNextPage}
        hasMore={hasNextPage ?? false}
        onLoadMore={fetchNextPage}
      />

      <ClaudeStatusIndicator isRunning={isClaudeRunning} containerStatus={session.status} />

      <PromptInput
        onSubmit={handleSendPrompt}
        onInterrupt={handleInterrupt}
        isRunning={isClaudeRunning}
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
