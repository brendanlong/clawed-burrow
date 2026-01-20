'use client';

import { useRef, useEffect, useCallback } from 'react';
import { MessageBubble } from './MessageBubble';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}

export function MessageList({ messages, isLoading, hasMore, onLoadMore }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Auto-scroll to bottom when new messages arrive, if user was at bottom
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  // Track if user is at bottom
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;

    // Load more when scrolled near top
    if (scrollTop < 100 && hasMore && !isLoading) {
      onLoadMore();
    }
  }, [hasMore, isLoading, onLoadMore]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4"
    >
      {hasMore && (
        <div className="text-center py-2">
          {isLoading ? (
            <Spinner size="sm" className="mx-auto" />
          ) : (
            <Button variant="link" onClick={onLoadMore}>
              Load older messages
            </Button>
          )}
        </div>
      )}

      {messages.length === 0 && !isLoading && (
        <div className="text-center text-muted-foreground py-12">
          No messages yet. Start a conversation with Claude!
        </div>
      )}

      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <MessageBubble
            message={{
              type: message.type,
              content: message.content,
            }}
          />
        </div>
      ))}

      <div ref={bottomRef} />
    </div>
  );
}
