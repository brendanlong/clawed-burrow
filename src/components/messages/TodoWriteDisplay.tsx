'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson, buildToolMessages } from './types';
import type { ToolCall, TodoItem } from './types';

interface TodoWriteDisplayProps {
  tool: ToolCall;
  /** Whether this is the latest/most recent TodoWrite in the conversation */
  isLatest?: boolean;
  /** Whether the user has manually toggled this TodoWrite's expand/collapse state */
  wasManuallyToggled?: boolean;
  /** Callback when the user manually toggles expand/collapse */
  onManualToggle?: () => void;
}

/**
 * Specialized display for TodoWrite tool calls.
 * Shows a checklist-style view with status indicators.
 *
 * Auto-collapse behavior:
 * - Latest TodoWrite is expanded by default
 * - Older TodoWrites are collapsed automatically when a new one arrives
 * - User's manual expand/collapse overrides auto-collapse behavior
 */
export function TodoWriteDisplay({
  tool,
  isLatest = true,
  wasManuallyToggled = false,
  onManualToggle,
}: TodoWriteDisplayProps) {
  // Compute expanded state: if user hasn't manually toggled, follow isLatest
  // If user has manually toggled, we need local state to track their choice
  const [manualExpandedState, setManualExpandedState] = useState(true);

  // Determine actual expanded state based on whether user has manually toggled
  const expanded = wasManuallyToggled ? manualExpandedState : isLatest;

  const inputObj = tool.input as { todos?: TodoItem[] } | undefined;
  const todos = inputObj?.todos ?? [];

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const totalCount = todos.length;

  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return (
          <svg
            className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        );
      case 'in_progress':
        return (
          <svg
            className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        );
      case 'pending':
        return (
          <svg
            className="w-4 h-4 text-muted-foreground flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="12" cy="12" r="9" />
          </svg>
        );
    }
  };

  // Handle user toggle - mark as manually toggled and update local state
  const handleOpenChange = (open: boolean) => {
    onManualToggle?.();
    setManualExpandedState(open);
  };

  // Build copy text with both tool call and result as an array of messages
  const getCopyText = useCallback(() => {
    const messages = buildToolMessages(tool);
    return formatAsJson(messages);
  }, [tool]);

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        <Card className="mt-2 border-blue-200 dark:border-blue-800">
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex items-center gap-2">
              <span className="font-mono text-primary">TodoWrite</span>
              <Badge
                variant="outline"
                className="text-xs border-blue-500 text-blue-700 dark:text-blue-400"
              >
                {completedCount}/{totalCount} done
              </Badge>
              {inProgressCount > 0 && (
                <Badge
                  variant="outline"
                  className="text-xs border-amber-500 text-amber-700 dark:text-amber-400"
                >
                  {inProgressCount} active
                </Badge>
              )}
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 pt-0">
              <ul className="space-y-1.5">
                {todos.map((todo, index) => (
                  <li
                    key={index}
                    className={cn('flex items-start gap-2 py-1 px-2 rounded text-sm', {
                      'text-muted-foreground line-through': todo.status === 'completed',
                      'bg-blue-50 dark:bg-blue-950/50 font-medium': todo.status === 'in_progress',
                    })}
                  >
                    {getStatusIcon(todo.status)}
                    <span className="flex-1">
                      {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
      <div className="mt-1">
        <CopyButton getText={getCopyText} />
      </div>
    </div>
  );
}
