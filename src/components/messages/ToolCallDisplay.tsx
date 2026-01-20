'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson, buildToolMessages } from './types';
import type { ToolCall } from './types';

/**
 * Generic display for tool calls.
 * Shows tool name, optional description, and collapsible input/output.
 */
export function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;

  // Extract description from input if present (e.g., Bash tool)
  const inputObj = tool.input as Record<string, unknown> | undefined;
  const description = inputObj?.description as string | undefined;

  // Build copy text with both tool call and result as an array of messages
  const getCopyText = useCallback(() => {
    const messages = buildToolMessages(tool);
    return formatAsJson(messages);
  }, [tool]);

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card
          className={cn(
            'mt-2',
            tool.is_error && 'border-red-300 dark:border-red-700',
            isPending && 'border-yellow-300 dark:border-yellow-700'
          )}
        >
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-primary">{tool.name}</span>
                {isPending && (
                  <Badge
                    variant="outline"
                    className="text-xs border-yellow-500 text-yellow-700 dark:text-yellow-400"
                  >
                    Running...
                  </Badge>
                )}
                {tool.is_error && (
                  <Badge variant="destructive" className="text-xs">
                    Error
                  </Badge>
                )}
              </div>
              {description && (
                <div className="text-muted-foreground text-xs mt-1 truncate">{description}</div>
              )}
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-2 text-xs">
              <div>
                <div className="text-muted-foreground mb-1">Input:</div>
                <pre className="bg-muted p-2 rounded overflow-x-auto">
                  {tool.name === 'Bash' && inputObj?.command
                    ? String(inputObj.command)
                    : JSON.stringify(tool.input, null, 2)}
                </pre>
              </div>
              {hasOutput && (
                <div>
                  <div className="text-muted-foreground mb-1">Output:</div>
                  <pre
                    className={cn(
                      'p-2 rounded overflow-x-auto max-h-48 overflow-y-auto',
                      tool.is_error
                        ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                        : 'bg-muted'
                    )}
                  >
                    {typeof tool.output === 'string'
                      ? tool.output
                      : JSON.stringify(tool.output, null, 2)}
                  </pre>
                </div>
              )}
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
