'use client';

import { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';

import { CopyButton } from './CopyButton';
import { RawJsonDisplay } from './RawJsonDisplay';
import { TodoWriteDisplay } from './TodoWriteDisplay';
import { ToolCallDisplay } from './ToolCallDisplay';
import { ToolResultDisplay } from './ToolResultDisplay';
import { SystemInitDisplay } from './SystemInitDisplay';
import { ResultDisplay } from './ResultDisplay';
import { HookResponseDisplay } from './HookResponseDisplay';
import { formatAsJson } from './types';
import type { ToolResultMap, ContentBlock, MessageContent } from './types';

/**
 * Extract text content from message content blocks.
 * For user/assistant messages, returns the raw markdown text.
 */
function extractTextContent(content: MessageContent): string | null {
  // For assistant messages, extract text from content.message.content
  if (content.message?.content && Array.isArray(content.message.content)) {
    const textBlocks = content.message.content
      .filter(
        (block): block is ContentBlock => block.type === 'text' && typeof block.text === 'string'
      )
      .map((block) => block.text!);
    if (textBlocks.length > 0) {
      return textBlocks.join('\n');
    }
  }
  // For simple content strings
  if (typeof content.content === 'string') {
    return content.content;
  }
  return null;
}

interface TodoWriteTrackingProps {
  latestTodoWriteId: string | null;
  manuallyToggledTodoIds: Set<string>;
  onTodoManualToggle: (toolId: string) => void;
}

function renderContentBlocks(
  blocks: ContentBlock[],
  toolResults?: ToolResultMap,
  todoTracking?: TodoWriteTrackingProps
): React.ReactNode {
  const textBlocks: string[] = [];
  const toolUseBlocks: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      textBlocks.push(block.text);
    } else if (block.type === 'tool_use') {
      toolUseBlocks.push(block);
    }
  }

  return (
    <>
      {textBlocks.length > 0 && <MarkdownContent content={textBlocks.join('\n')} />}
      {toolUseBlocks.length > 0 && (
        <div className="mt-2 space-y-2">
          {toolUseBlocks.map((block) => {
            // Look up the result for this tool_use
            const result = block.id ? toolResults?.get(block.id) : undefined;
            const tool = {
              name: block.name || 'Unknown',
              id: block.id,
              input: block.input,
              output: result?.content,
              is_error: result?.is_error,
            };

            // Use specialized display for specific tools
            if (block.name === 'TodoWrite') {
              const isLatest = todoTracking && block.id === todoTracking.latestTodoWriteId;
              const wasManuallyToggled =
                todoTracking && block.id
                  ? todoTracking.manuallyToggledTodoIds.has(block.id)
                  : false;
              return (
                <TodoWriteDisplay
                  key={block.id}
                  tool={tool}
                  isLatest={isLatest ?? false}
                  wasManuallyToggled={wasManuallyToggled}
                  onManualToggle={() => {
                    if (block.id && todoTracking) {
                      todoTracking.onTodoManualToggle(block.id);
                    }
                  }}
                />
              );
            }

            return <ToolCallDisplay key={block.id} tool={tool} />;
          })}
        </div>
      )}
    </>
  );
}

function renderContent(
  content: unknown,
  toolResults?: ToolResultMap,
  todoTracking?: TodoWriteTrackingProps
): React.ReactNode {
  if (typeof content === 'string') {
    return <MarkdownContent content={content} />;
  }

  if (Array.isArray(content)) {
    return renderContentBlocks(content as ContentBlock[], toolResults, todoTracking);
  }

  return null;
}

// Check if a message is a tool result (comes as type "user" but contains tool_result content)
function isToolResultMessage(content: MessageContent): boolean {
  const innerContent = content.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.some((block) => block.type === 'tool_result');
  }
  return false;
}

// Extract tool results from a message
function getToolResults(content: MessageContent): ContentBlock[] {
  const innerContent = content.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.filter((block) => block.type === 'tool_result');
  }
  return [];
}

/**
 * Check if a message can be recognized and displayed with our typed components.
 * Returns false if we should fall back to raw JSON display.
 */
function isRecognizedMessage(
  type: string,
  content: MessageContent
):
  | {
      recognized: true;
      category:
        | 'assistant'
        | 'user'
        | 'toolResult'
        | 'system'
        | 'systemInit'
        | 'systemError'
        | 'hookResponse'
        | 'result';
    }
  | { recognized: false } {
  // Assistant messages must have a valid message.content array
  if (type === 'assistant') {
    if (!content.message || !Array.isArray(content.message.content)) {
      return { recognized: false };
    }
    return { recognized: true, category: 'assistant' };
  }

  // User messages that are tool results
  if (type === 'user' && isToolResultMessage(content)) {
    return { recognized: true, category: 'toolResult' };
  }

  // Regular user messages (prompts) must have text content
  if (type === 'user') {
    // User prompts typically have message.content with text blocks
    if (content.message?.content && Array.isArray(content.message.content)) {
      return { recognized: true, category: 'user' };
    }
    // Or simple content string
    if (typeof content.content === 'string') {
      return { recognized: true, category: 'user' };
    }
    return { recognized: false };
  }

  // System init messages
  if (type === 'system' && content.subtype === 'init') {
    if (content.model && content.session_id) {
      return { recognized: true, category: 'systemInit' };
    }
    return { recognized: false };
  }

  // System error messages
  if (type === 'system' && content.subtype === 'error') {
    if (Array.isArray(content.content)) {
      return { recognized: true, category: 'systemError' };
    }
    return { recognized: false };
  }

  // Hook response messages
  if (type === 'system' && content.subtype === 'hook_response') {
    return { recognized: true, category: 'hookResponse' };
  }

  // Other system messages
  if (type === 'system') {
    return { recognized: true, category: 'system' };
  }

  // Result messages
  if (type === 'result') {
    if (content.subtype && typeof content.session_id === 'string') {
      return { recognized: true, category: 'result' };
    }
    return { recognized: false };
  }

  // Unknown type
  return { recognized: false };
}

export function MessageBubble({
  message,
  toolResults,
  latestTodoWriteId,
  manuallyToggledTodoIds,
  onTodoManualToggle,
}: {
  message: { type: string; content: unknown };
  toolResults?: ToolResultMap;
  latestTodoWriteId?: string | null;
  manuallyToggledTodoIds?: Set<string>;
  onTodoManualToggle?: (toolId: string) => void;
}) {
  // Build todoTracking prop if all required values are provided
  const todoTracking: TodoWriteTrackingProps | undefined = useMemo(() => {
    if (latestTodoWriteId !== undefined && manuallyToggledTodoIds && onTodoManualToggle) {
      return {
        latestTodoWriteId,
        manuallyToggledTodoIds,
        onTodoManualToggle,
      };
    }
    return undefined;
  }, [latestTodoWriteId, manuallyToggledTodoIds, onTodoManualToggle]);
  const { type } = message;
  const content = useMemo(() => (message.content || {}) as MessageContent, [message.content]);

  // Check if we can properly display this message
  const recognition = useMemo(() => isRecognizedMessage(type, content), [type, content]);

  const category = recognition.recognized ? recognition.category : null;
  const isUser = category === 'user';
  const isAssistant = category === 'assistant';

  // Compute copy text - for user/assistant, copy raw text; for others, copy JSON
  const getCopyText = useCallback(() => {
    if (isUser || isAssistant) {
      const text = extractTextContent(content);
      return text ?? formatAsJson(content);
    }
    return formatAsJson(content);
  }, [content, isUser, isAssistant]);

  // Unrecognized messages get the raw JSON display (collapsed by default)
  if (!recognition.recognized) {
    return (
      <div className="w-full max-w-[85%]">
        <RawJsonDisplay content={message.content} label={`Unknown: ${type}`} />
      </div>
    );
  }

  // System init messages get their own compact display
  if (category === 'systemInit') {
    return (
      <div className="w-full max-w-[85%]">
        <SystemInitDisplay content={content} />
      </div>
    );
  }

  // Hook response messages get their own compact display
  if (category === 'hookResponse') {
    return (
      <div className="w-full max-w-[85%]">
        <HookResponseDisplay content={content} />
      </div>
    );
  }

  // Result messages get their own compact display
  if (category === 'result') {
    return (
      <div className="w-full max-w-[85%]">
        <ResultDisplay content={content} />
      </div>
    );
  }

  // Tool result messages get their own compact display
  if (category === 'toolResult') {
    const toolResultBlocks = getToolResults(content);
    return (
      <div className="w-full max-w-[85%]">
        <ToolResultDisplay results={toolResultBlocks} />
      </div>
    );
  }

  // Get the actual content to render
  // For assistant messages, content is in content.message.content
  // For user/system messages, content is in content.content
  const getDisplayContent = (): unknown => {
    if (category === 'assistant' && content.message?.content) {
      return content.message.content;
    }
    return content.content;
  };

  const displayContent = getDisplayContent();
  const isSystem = category === 'system';
  const isError = category === 'systemError';

  return (
    <div className="group max-w-[85%]">
      <div
        className={cn('rounded-lg p-4', {
          'bg-primary text-primary-foreground ml-auto': isUser,
          'bg-card border': isAssistant,
          'bg-muted text-muted-foreground text-sm': isSystem && !isError,
          'bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 text-sm':
            isError,
        })}
      >
        {isSystem && !isError && (
          <Badge variant="secondary" className="mb-2">
            System
          </Badge>
        )}
        {isError && (
          <Badge variant="destructive" className="mb-2">
            Error
          </Badge>
        )}

        {/* Render content (works for both regular messages and errors now) */}
        {renderContent(displayContent, toolResults, todoTracking)}

        {content.tool_calls && content.tool_calls.length > 0 && (
          <div className="mt-2 space-y-2">
            {content.tool_calls.map((tool, index) => (
              <ToolCallDisplay key={index} tool={tool} />
            ))}
          </div>
        )}
      </div>
      <div className="mt-1">
        <CopyButton getText={getCopyText} />
      </div>
    </div>
  );
}
