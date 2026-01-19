'use client';

import { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { MessageList } from '@/components/MessageList';
import { PromptInput } from '@/components/PromptInput';
import { trpc } from '@/lib/trpc';

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

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

  const statusColors: Record<string, string> = {
    running: 'bg-green-100 text-green-800',
    stopped: 'bg-gray-100 text-gray-800',
    creating: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <div className="border-b bg-white px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Link href="/" className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </Link>
          <div>
            <h1 className="font-semibold text-gray-900">{session.name}</h1>
            <p className="text-sm text-gray-500">
              {repoName} • {session.branch}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              statusColors[session.status] || statusColors.stopped
            }`}
          >
            {session.status}
          </span>

          {session.status === 'stopped' && (
            <button
              onClick={onStart}
              disabled={isStarting}
              className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
            >
              {isStarting ? 'Starting...' : 'Start'}
            </button>
          )}
          {session.status === 'running' && (
            <button
              onClick={onStop}
              disabled={isStopping}
              className="px-3 py-1 text-sm bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
            >
              {isStopping ? 'Stopping...' : 'Stop'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionView({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isClaudeRunning, setIsClaudeRunning] = useState(false);
  const [oldestCursor, setOldestCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Fetch session details
  const {
    data: sessionData,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = trpc.sessions.get.useQuery({ sessionId });

  // Fetch initial message history
  const { data: historyData, isLoading: historyLoading } = trpc.claude.getHistory.useQuery({
    sessionId,
    limit: 50,
    direction: 'before',
  });

  // Check if Claude is running
  const { data: runningData } = trpc.claude.isRunning.useQuery(
    { sessionId },
    { refetchInterval: 2000 }
  );

  // Mutations
  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: () => refetchSession(),
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: () => refetchSession(),
  });

  const interruptMutation = trpc.claude.interrupt.useMutation();

  // Update messages from initial history
  useEffect(() => {
    if (historyData?.messages) {
      const newMessages = historyData.messages.map((msg) => ({
        id: msg.id,
        type: msg.type,
        content: msg.content,
        sequence: msg.sequence,
      }));
      setMessages(newMessages);
      setHasMore(historyData.hasMore);
      if (newMessages.length > 0) {
        setOldestCursor(newMessages[0].sequence);
      }
    }
  }, [historyData]);

  // Update running state
  useEffect(() => {
    setIsClaudeRunning(runningData?.running ?? false);
  }, [runningData]);

  const handleSendPrompt = useCallback(
    async (prompt: string) => {
      if (!sessionData?.session || sessionData.session.status !== 'running') {
        return;
      }

      setIsClaudeRunning(true);

      // Note: In a full implementation, you would use tRPC subscription here
      // For now, we'll use a polling approach after sending
      try {
        // The actual streaming would happen via subscription
        // This is a simplified version that just polls for updates
        const response = await fetch('/api/trpc/claude.send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
          },
          body: JSON.stringify({
            json: { sessionId, prompt },
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to send message');
        }

        // Poll for new messages
        const pollForMessages = async () => {
          const latestSeq = messages.length > 0 ? messages[messages.length - 1].sequence : 0;

          const newMessagesResponse = await fetch(
            `/api/trpc/claude.getHistory?batch=1&input=${encodeURIComponent(
              JSON.stringify({
                '0': {
                  json: {
                    sessionId,
                    cursor: latestSeq,
                    direction: 'after',
                    limit: 100,
                  },
                },
              })
            )}`,
            {
              headers: {
                Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
              },
            }
          );

          if (newMessagesResponse.ok) {
            const data = await newMessagesResponse.json();
            const newMessages = data[0]?.result?.data?.json?.messages || [];

            if (newMessages.length > 0) {
              setMessages((prev) => {
                const combined = [...prev];
                for (const msg of newMessages) {
                  if (!combined.find((m) => m.id === msg.id)) {
                    combined.push({
                      id: msg.id,
                      type: msg.type,
                      content: msg.content,
                      sequence: msg.sequence,
                    });
                  }
                }
                return combined.sort((a, b) => a.sequence - b.sequence);
              });
            }
          }
        };

        // Poll every second for 60 seconds
        const interval = setInterval(pollForMessages, 1000);
        setTimeout(() => {
          clearInterval(interval);
          setIsClaudeRunning(false);
        }, 60000);

        // Also check immediately
        await pollForMessages();
      } catch (error) {
        console.error('Error sending message:', error);
        setIsClaudeRunning(false);
      }
    },
    [sessionId, sessionData, messages]
  );

  const handleInterrupt = useCallback(() => {
    interruptMutation.mutate({ sessionId });
  }, [sessionId, interruptMutation]);

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || !oldestCursor) return;

    setIsLoadingMore(true);
    try {
      const response = await fetch(
        `/api/trpc/claude.getHistory?batch=1&input=${encodeURIComponent(
          JSON.stringify({
            '0': {
              json: {
                sessionId,
                cursor: oldestCursor,
                direction: 'before',
                limit: 50,
              },
            },
          })
        )}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        const olderMessages = data[0]?.result?.data?.json?.messages || [];
        const moreAvailable = data[0]?.result?.data?.json?.hasMore ?? false;

        if (olderMessages.length > 0) {
          setMessages((prev) => {
            const combined = [...olderMessages, ...prev];
            // Dedupe by id
            const seen = new Set<string>();
            return combined.filter((msg) => {
              if (seen.has(msg.id)) return false;
              seen.add(msg.id);
              return true;
            });
          });
          setOldestCursor(olderMessages[0].sequence);
        }
        setHasMore(moreAvailable);
      }
    } catch (error) {
      console.error('Error loading more messages:', error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [sessionId, oldestCursor, hasMore, isLoadingMore]);

  if (sessionLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!sessionData?.session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <p className="text-gray-500">Session not found</p>
        <Link href="/" className="mt-4 text-blue-600 hover:underline">
          Back to sessions
        </Link>
      </div>
    );
  }

  const session = sessionData.session;

  return (
    <div className="flex-1 flex flex-col">
      <SessionHeader
        session={session}
        onStart={() => startMutation.mutate({ sessionId })}
        onStop={() => stopMutation.mutate({ sessionId })}
        isStarting={startMutation.isPending}
        isStopping={stopMutation.isPending}
      />

      <MessageList
        messages={messages}
        isLoading={historyLoading || isLoadingMore}
        hasMore={hasMore}
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
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <Header />
        <SessionView sessionId={resolvedParams.id} />
      </div>
    </AuthGuard>
  );
}
