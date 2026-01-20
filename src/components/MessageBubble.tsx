'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';

interface ToolCall {
  name: string;
  input: unknown;
  output?: unknown;
}

interface MessageContent {
  type?: string;
  content?: string | unknown[];
  tool_calls?: ToolCall[];
  result?: unknown;
  error?: boolean;
  message?: string;
  [key: string]: unknown;
}

function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card className="mt-2">
        <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
          <span className="font-mono text-primary">{tool.name}</span>
          <span className="text-muted-foreground">{expanded ? '−' : '+'}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="p-3 space-y-2 text-xs">
            <div>
              <div className="text-muted-foreground mb-1">Input:</div>
              <pre className="bg-muted p-2 rounded overflow-x-auto">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
            {tool.output !== undefined && (
              <div>
                <div className="text-muted-foreground mb-1">Output:</div>
                <pre className="bg-muted p-2 rounded overflow-x-auto max-h-48 overflow-y-auto">
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
  );
}

function renderContent(content: unknown): React.ReactNode {
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }

  if (Array.isArray(content)) {
    return content.map((item, index) => {
      if (typeof item === 'string') {
        return (
          <p key={index} className="whitespace-pre-wrap">
            {item}
          </p>
        );
      }
      if (item && typeof item === 'object' && 'text' in item) {
        return (
          <p key={index} className="whitespace-pre-wrap">
            {String(item.text)}
          </p>
        );
      }
      return null;
    });
  }

  return null;
}

export function MessageBubble({ message }: { message: { type: string; content: unknown } }) {
  const { type } = message;
  const content = (message.content || {}) as MessageContent;

  const isUser = type === 'user';
  const isAssistant = type === 'assistant';
  const isSystem = type === 'system';
  const isResult = type === 'result';
  const isError = isSystem && content.error === true;

  return (
    <div
      className={cn('max-w-[85%] rounded-lg p-4', {
        'bg-primary text-primary-foreground ml-auto': isUser,
        'bg-card border': isAssistant,
        'bg-muted text-muted-foreground text-sm': isSystem && !isError,
        'bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 text-sm':
          isError,
        'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200 text-sm':
          isResult,
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
      {isResult && (
        <Badge className="mb-2 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 hover:bg-green-100">
          Result
        </Badge>
      )}

      {/* Render error message if present */}
      {isError && content.message && (
        <p className="whitespace-pre-wrap font-mono text-xs">{content.message}</p>
      )}

      {/* Render regular content */}
      {!isError && renderContent(content.content)}

      {content.tool_calls && content.tool_calls.length > 0 && (
        <div className="mt-2 space-y-2">
          {content.tool_calls.map((tool, index) => (
            <ToolCallDisplay key={index} tool={tool} />
          ))}
        </div>
      )}

      {isResult && content.result !== undefined && (
        <pre className="mt-2 bg-background p-2 rounded text-xs overflow-x-auto">
          {String(
            typeof content.result === 'string'
              ? content.result
              : JSON.stringify(content.result, null, 2)
          )}
        </pre>
      )}
    </div>
  );
}
