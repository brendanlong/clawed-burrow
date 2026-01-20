'use client';

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { MessageBubble, type ToolResultMap } from './messages';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface ContentBlock {
  type: string;
  id?: string;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface MessageContent {
  message?: {
    content?: ContentBlock[];
  };
}

interface Message {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

// Extract tool_use IDs from an assistant message
function getToolUseIds(message: Message): string[] {
  const content = message.content as MessageContent | undefined;
  const blocks = content?.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b.type === 'tool_use' && b.id).map((b) => b.id!);
}

// Extract tool_result blocks from a tool result message
function getToolResultBlocks(message: Message): ContentBlock[] {
  const content = message.content as MessageContent | undefined;
  const blocks = content?.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b.type === 'tool_result');
}

// Check if a message is a tool result (comes as type "user" but contains tool_result content)
function isToolResultMessage(message: Message): boolean {
  const content = message.content as MessageContent | undefined;
  const innerContent = content?.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.some((block) => block.type === 'tool_result');
  }
  return false;
}

// Build a map of tool_use_id -> tool_result content, and track which messages are fully paired
function buildToolResultMap(messages: Message[]): {
  resultMap: ToolResultMap;
  pairedMessageIds: Set<string>;
} {
  const resultMap: ToolResultMap = new Map();
  const pairedMessageIds = new Set<string>();

  // First pass: collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      for (const id of getToolUseIds(msg)) {
        toolUseIds.add(id);
      }
    }
  }

  // Second pass: map tool results to their tool_use IDs
  for (const msg of messages) {
    if (msg.type === 'user' && isToolResultMessage(msg)) {
      const resultBlocks = getToolResultBlocks(msg);
      let allPaired = true;

      for (const block of resultBlocks) {
        if (block.tool_use_id && toolUseIds.has(block.tool_use_id)) {
          resultMap.set(block.tool_use_id, {
            content: block.content,
            is_error: block.is_error,
          });
        } else {
          // This result doesn't have a matching tool_use
          allPaired = false;
        }
      }

      // Only mark message as paired if ALL its results were paired
      if (allPaired && resultBlocks.length > 0) {
        pairedMessageIds.add(msg.id);
      }
    }
  }

  return { resultMap, pairedMessageIds };
}

// Extract TodoWrite tool call IDs from messages, ordered by sequence
function getTodoWriteIds(messages: Message[]): string[] {
  const ids: string[] = [];
  // Sort by sequence to ensure correct ordering
  const sortedMessages = [...messages].sort((a, b) => a.sequence - b.sequence);
  for (const msg of sortedMessages) {
    if (msg.type === 'assistant') {
      const content = msg.content as MessageContent | undefined;
      const blocks = content?.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (
            block.type === 'tool_use' &&
            (block as ContentBlock & { name?: string }).name === 'TodoWrite' &&
            block.id
          ) {
            ids.push(block.id);
          }
        }
      }
    }
  }
  return ids;
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

  // Track which TodoWrite components have been manually toggled by the user
  const [manuallyToggledTodoIds, setManuallyToggledTodoIds] = useState<Set<string>>(new Set());

  // Build the tool result map and determine which messages to hide
  const { resultMap, pairedMessageIds } = useMemo(() => buildToolResultMap(messages), [messages]);

  // Find the latest TodoWrite ID (last one by sequence)
  const latestTodoWriteId = useMemo(() => {
    const todoIds = getTodoWriteIds(messages);
    return todoIds.length > 0 ? todoIds[todoIds.length - 1] : null;
  }, [messages]);

  // Callback for when a TodoWrite is manually toggled
  const handleTodoManualToggle = useCallback((toolId: string) => {
    setManuallyToggledTodoIds((prev) => new Set([...prev, toolId]));
  }, []);

  // Filter out messages that have been fully paired with their tool_use
  const visibleMessages = useMemo(
    () => messages.filter((msg) => !pairedMessageIds.has(msg.id)),
    [messages, pairedMessageIds]
  );

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

      {visibleMessages.length === 0 && !isLoading && (
        <div className="text-center text-muted-foreground py-12">
          No messages yet. Start a conversation with Claude!
        </div>
      )}

      {visibleMessages.map((message) => {
        // Only right-align actual user messages, not tool results
        const isUserMessage = message.type === 'user' && !isToolResultMessage(message);
        return (
          <div
            key={message.id}
            className={`flex ${isUserMessage ? 'justify-end' : 'justify-start'}`}
          >
            <MessageBubble
              message={{
                type: message.type,
                content: message.content,
              }}
              toolResults={resultMap}
              latestTodoWriteId={latestTodoWriteId}
              manuallyToggledTodoIds={manuallyToggledTodoIds}
              onTodoManualToggle={handleTodoManualToggle}
            />
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
