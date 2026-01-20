'use client';

import { useCallback, useMemo, useEffect, useRef, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
import { ClaudeStatusIndicator } from '@/components/ClaudeStatusIndicator';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

type SessionStatus = 'running' | 'stopped' | 'creating' | 'error';

function SessionHeader({
  session,
  onStart,
  onStop,
  isStarting,
  isStopping,
}: {
  session: {
    id: string;
    name: string;
    repoUrl: string;
    branch: string;
    status: string;
    statusMessage?: string | null;
    initialPrompt?: string | null;
  };
  onStart: () => void;
  onStop: () => void;
  isStarting: boolean;
  isStopping: boolean;
}) {
  const repoName = session.repoUrl.replace('https://github.com/', '').replace('.git', '');

  const statusVariants: Record<SessionStatus, 'default' | 'secondary' | 'destructive' | 'outline'> =
    {
      running: 'default',
      stopped: 'secondary',
      creating: 'outline',
      error: 'destructive',
    };

  return (
    <div className="border-b bg-background px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Link>
          </Button>
          <div>
            <h1 className="font-semibold">{session.name}</h1>
            <p className="text-sm text-muted-foreground">
              {repoName} · {session.branch}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Container:</span>
          <Badge variant={statusVariants[session.status as SessionStatus] || 'secondary'}>
            {session.status}
          </Badge>

          {session.status === 'stopped' && (
            <Button size="sm" onClick={onStart} disabled={isStarting}>
              {isStarting ? 'Starting...' : 'Start'}
            </Button>
          )}
          {session.status === 'running' && (
            <Button variant="secondary" size="sm" onClick={onStop} disabled={isStopping}>
              {isStopping ? 'Stopping...' : 'Stop'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionView({ sessionId }: { sessionId: string }) {
  // Fetch session details (poll while creating)
  const {
    data: sessionData,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = trpc.sessions.get.useQuery(
    { sessionId },
    {
      // Poll every second while session is being created
      refetchInterval: (query) => {
        const status = query.state.data?.session?.status;
        return status === 'creating' ? 1000 : false;
      },
    }
  );

  // Infinite query for message history (paginating backwards)
  const {
    data: historyData,
    isLoading: historyLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = trpc.claude.getHistory.useInfiniteQuery(
    { sessionId, limit: 50 },
    {
      getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    }
  );

  // Check if Claude is running
  const { data: runningData } = trpc.claude.isRunning.useQuery(
    { sessionId },
    { refetchInterval: 2000 }
  );

  // Compute cursor for polling new messages from history data
  const historyCursor = useMemo(() => {
    const firstPage = historyData?.pages?.[0];
    if (!firstPage || firstPage.messages.length === 0) return undefined;
    return Math.max(...firstPage.messages.map((m) => m.sequence));
  }, [historyData?.pages]);

  // Poll for new messages (forward from history cursor)
  const { data: newMessagesData } = trpc.claude.getHistory.useQuery(
    historyCursor !== undefined
      ? { sessionId, cursor: historyCursor, direction: 'forward', limit: 100 }
      : { sessionId, direction: 'backward', limit: 100 },
    {
      // Poll faster when Claude is running
      refetchInterval: runningData?.running ? 500 : 5000,
      // Don't start polling until history has loaded
      enabled: !historyLoading,
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

  // Merge history + polled new messages, with deduplication
  const allMessages = useMemo(() => {
    const fromHistory: Message[] = [];
    if (historyData?.pages) {
      // Pages are in reverse order (newest page first), but messages within each page are chronological
      // We need to reverse pages to get oldest-first, then flatten
      for (const page of [...historyData.pages].reverse()) {
        for (const msg of page.messages) {
          fromHistory.push({
            id: msg.id,
            type: msg.type,
            content: msg.content,
            sequence: msg.sequence,
          });
        }
      }
    }

    // Add new messages from polling
    const historyIds = new Set(fromHistory.map((m) => m.id));
    const newMessages = (newMessagesData?.messages ?? [])
      .filter((m) => !historyIds.has(m.id))
      .map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        sequence: m.sequence,
      }));

    return [...fromHistory, ...newMessages];
  }, [historyData, newMessagesData]);

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

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const session = sessionData?.session;
  const isClaudeRunning = runningData?.running ?? false;

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
        onLoadMore={handleLoadMore}
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
