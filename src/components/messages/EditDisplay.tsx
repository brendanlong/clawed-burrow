'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import type { ToolCall } from './types';

interface EditInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

/**
 * Specialized display for Edit tool calls.
 * Shows file path and a diff-like view of old vs new content.
 */
export function EditDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;

  const input = tool.input as EditInput | undefined;
  const filePath = input?.file_path ?? 'Unknown file';
  const oldString = input?.old_string ?? '';
  const newString = input?.new_string ?? '';
  const replaceAll = input?.replace_all ?? false;

  // Extract just the filename for the header
  const fileName = filePath.split('/').pop() ?? filePath;

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
                <span className="font-mono text-primary">Edit</span>
                <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
                {replaceAll && (
                  <Badge variant="outline" className="text-xs">
                    replace all
                  </Badge>
                )}
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
              <div className="text-muted-foreground text-xs mt-1 truncate">{filePath}</div>
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-3 text-xs">
              {/* Old string (removed) */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-red-600 dark:text-red-400 font-medium">Removed</span>
                  <span className="text-muted-foreground">
                    ({oldString.split('\n').length} lines)
                  </span>
                </div>
                <pre className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto">
                  <code className="text-red-800 dark:text-red-200 whitespace-pre-wrap break-words">
                    {oldString || '(empty)'}
                  </code>
                </pre>
              </div>

              {/* New string (added) */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-green-600 dark:text-green-400 font-medium">Added</span>
                  <span className="text-muted-foreground">
                    ({newString.split('\n').length} lines)
                  </span>
                </div>
                <pre className="bg-green-50 dark:bg-green-950/50 border border-green-200 dark:border-green-800 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto">
                  <code className="text-green-800 dark:text-green-200 whitespace-pre-wrap break-words">
                    {newString || '(empty)'}
                  </code>
                </pre>
              </div>

              {/* Output/Result if available */}
              {hasOutput && (
                <div>
                  <div className="text-muted-foreground mb-1">Result:</div>
                  <pre
                    className={cn(
                      'p-2 rounded overflow-x-auto max-h-32 overflow-y-auto',
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
    </div>
  );
}
