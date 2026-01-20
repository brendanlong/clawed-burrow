'use client';

import { skipToken } from '@tanstack/react-query';
import { useState, useCallback, useMemo, useEffect, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
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
  // Fetch session details
  const {
    data: sessionData,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = trpc.sessions.get.useQuery({ sessionId });

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

  // Stable cursor for subscription - set once when history first loads, never changes after
  const [subscriptionCursor, setSubscriptionCursor] = useState<number | null>(null);

  // Set subscription cursor once when history first loads (intentional one-time state update)
  useEffect(() => {
    if (subscriptionCursor !== null || historyLoading) {
      return; // Already set or still loading
    }
    const firstPage = historyData?.pages?.[0];
    if (firstPage && firstPage.messages.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time initialization
      setSubscriptionCursor(Math.max(...firstPage.messages.map((m) => m.sequence)));
    } else {
      setSubscriptionCursor(-1); // No messages, start from beginning
    }
  }, [subscriptionCursor, historyLoading, historyData?.pages]);

  // Local state for messages received via subscription
  const [newMessages, setNewMessages] = useState<Message[]>([]);

  // Subscribe to new messages
  trpc.claude.subscribe.useSubscription(
    subscriptionCursor !== null ? { sessionId, afterCursor: subscriptionCursor } : skipToken,
    {
      onData: (message) => {
        setNewMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return [
            ...prev,
            {
              id: message.id,
              type: message.type,
              content: message.content,
              sequence: message.sequence,
            },
          ];
        });
      },
      onError: (err) => {
        console.error('Subscription error:', err);
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

  // Merge history + new messages from subscription, with deduplication
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

    // Filter out any new messages that already appear in history
    const historyIds = new Set(fromHistory.map((m) => m.id));
    const uniqueNew = newMessages.filter((m) => !historyIds.has(m.id));

    return [...fromHistory, ...uniqueNew];
  }, [historyData, newMessages]);

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

  if (sessionLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!sessionData?.session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <p className="text-muted-foreground">Session not found</p>
        <Button variant="link" asChild className="mt-4">
          <Link href="/">Back to sessions</Link>
        </Button>
      </div>
    );
  }

  const session = sessionData.session;
  const isClaudeRunning = runningData?.running ?? false;

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
