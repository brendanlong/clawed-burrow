'use client';

import { useState, useCallback } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

interface HookResponseContent extends MessageContent {
  hook_name?: string;
  hook_event?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

/**
 * Display for hook response messages showing hook execution results.
 */
export function HookResponseDisplay({ content }: { content: HookResponseContent }) {
  const [expanded, setExpanded] = useState(false);
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  const hasError = content.exit_code !== 0;
  const hasOutput = content.stdout || content.stderr;

  // Extract a readable hook name (e.g., "SessionStart:resume" -> "Session Start (resume)")
  const formatHookName = (name?: string) => {
    if (!name) return 'Unknown Hook';
    // Split on colon for event:action format
    const [event, action] = name.split(':');
    // Add spaces before capitals (e.g., SessionStart -> Session Start)
    const formattedEvent = event.replace(/([a-z])([A-Z])/g, '$1 $2');
    return action ? `${formattedEvent} (${action})` : formattedEvent;
  };

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="w-full text-left flex items-center gap-2 text-sm hover:bg-muted/50 rounded p-2">
          <Badge variant={hasError ? 'destructive' : 'secondary'}>
            {hasError ? 'Hook Failed' : 'Hook'}
          </Badge>
          <span className="text-muted-foreground text-xs">{formatHookName(content.hook_name)}</span>
          {hasError && (
            <span className="text-xs text-red-500 dark:text-red-400">
              Exit code: {content.exit_code}
            </span>
          )}
          {hasOutput && (
            <span className="text-muted-foreground ml-auto">{expanded ? '−' : '+'}</span>
          )}
        </CollapsibleTrigger>

        {hasOutput && (
          <CollapsibleContent>
            <div className="p-3 space-y-2 text-xs bg-muted/50 rounded mt-1">
              {content.stdout && (
                <div>
                  <span className="text-muted-foreground font-medium">stdout:</span>
                  <pre className="mt-1 p-2 bg-background rounded font-mono text-xs whitespace-pre-wrap break-all">
                    {content.stdout}
                  </pre>
                </div>
              )}
              {content.stderr && (
                <div>
                  <span className="text-red-500 dark:text-red-400 font-medium">stderr:</span>
                  <pre className="mt-1 p-2 bg-red-50 dark:bg-red-950 rounded font-mono text-xs whitespace-pre-wrap break-all text-red-700 dark:text-red-300">
                    {content.stderr}
                  </pre>
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
