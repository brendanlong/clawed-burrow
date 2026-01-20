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

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AssistantMessage {
  id?: string;
  model?: string;
  role?: string;
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface MessageContent {
  type?: string;
  subtype?: string; // 'init' | 'error' | 'success' etc.
  content?: string | ContentBlock[];
  // Assistant message wrapper
  message?: AssistantMessage;
  tool_calls?: ToolCall[];
  result?: unknown;
  // System init fields
  model?: string;
  claude_code_version?: string;
  cwd?: string;
  session_id?: string;
  tools?: string[];
  // Result fields
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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

function SystemInitDisplay({ content }: { content: MessageContent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger className="w-full text-left flex items-center gap-2 text-sm hover:bg-muted/50 rounded p-2">
        <Badge variant="secondary">Session Started</Badge>
        <span className="text-muted-foreground text-xs">
          {content.model} · v{content.claude_code_version}
        </span>
        <span className="text-muted-foreground ml-auto">{expanded ? '−' : '+'}</span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="p-3 space-y-2 text-xs bg-muted/50 rounded mt-1">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-muted-foreground">Session ID:</span>
              <span className="ml-2 font-mono">{content.session_id}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Working Dir:</span>
              <span className="ml-2 font-mono">{content.cwd}</span>
            </div>
          </div>
          {content.tools && content.tools.length > 0 && (
            <div>
              <span className="text-muted-foreground">Tools:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {content.tools.map((tool) => (
                  <Badge key={tool} variant="outline" className="text-xs">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ResultDisplay({ content }: { content: MessageContent }) {
  const [expanded, setExpanded] = useState(false);

  const formatCost = (cost?: number) => {
    if (cost === undefined) return 'N/A';
    return `$${cost.toFixed(4)}`;
  };

  const formatTokens = (tokens?: number) => {
    if (tokens === undefined) return 'N/A';
    return tokens.toLocaleString();
  };

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger className="w-full text-left flex items-center gap-2 text-sm hover:bg-muted/50 rounded p-2">
        <Badge
          variant="outline"
          className={cn(
            content.subtype === 'success'
              ? 'border-green-500 text-green-700 dark:text-green-400'
              : 'border-red-500 text-red-700 dark:text-red-400'
          )}
        >
          {content.subtype === 'success' ? 'Turn Complete' : 'Error'}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {formatCost(content.total_cost_usd)} · {content.num_turns} turn
          {content.num_turns !== 1 ? 's' : ''}
        </span>
        <span className="text-muted-foreground ml-auto">{expanded ? '−' : '+'}</span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="p-3 space-y-2 text-xs bg-muted/50 rounded mt-1">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-muted-foreground">Duration:</span>
              <span className="ml-2">
                {content.duration_ms ? `${(content.duration_ms / 1000).toFixed(1)}s` : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Cost:</span>
              <span className="ml-2">{formatCost(content.total_cost_usd)}</span>
            </div>
          </div>
          {content.usage && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-muted-foreground">Input tokens:</span>
                <span className="ml-2">{formatTokens(content.usage.input_tokens)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Output tokens:</span>
                <span className="ml-2">{formatTokens(content.usage.output_tokens)}</span>
              </div>
              {content.usage.cache_read_input_tokens !== undefined &&
                content.usage.cache_read_input_tokens > 0 && (
                  <div>
                    <span className="text-muted-foreground">Cache read:</span>
                    <span className="ml-2">
                      {formatTokens(content.usage.cache_read_input_tokens)}
                    </span>
                  </div>
                )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function renderContentBlocks(blocks: ContentBlock[]): React.ReactNode {
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
      {textBlocks.length > 0 && <div className="whitespace-pre-wrap">{textBlocks.join('\n')}</div>}
      {toolUseBlocks.length > 0 && (
        <div className="mt-2 space-y-2">
          {toolUseBlocks.map((block) => (
            <ToolCallDisplay
              key={block.id}
              tool={{
                name: block.name || 'Unknown',
                input: block.input,
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function renderContent(content: unknown): React.ReactNode {
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }

  if (Array.isArray(content)) {
    return renderContentBlocks(content as ContentBlock[]);
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
  const isSystemInit = isSystem && content.subtype === 'init';
  const isError = isSystem && content.subtype === 'error';

  // System init messages get their own compact display
  if (isSystemInit) {
    return (
      <div className="w-full max-w-[85%]">
        <SystemInitDisplay content={content} />
      </div>
    );
  }

  // Result messages get their own compact display
  if (isResult) {
    return (
      <div className="w-full max-w-[85%]">
        <ResultDisplay content={content} />
      </div>
    );
  }

  // Get the actual content to render
  // For assistant messages, content is in content.message.content
  // For user/system messages, content is in content.content
  const getDisplayContent = (): unknown => {
    if (isAssistant && content.message?.content) {
      return content.message.content;
    }
    return content.content;
  };

  const displayContent = getDisplayContent();

  return (
    <div
      className={cn('max-w-[85%] rounded-lg p-4', {
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
      {renderContent(displayContent)}

      {content.tool_calls && content.tool_calls.length > 0 && (
        <div className="mt-2 space-y-2">
          {content.tool_calls.map((tool, index) => (
            <ToolCallDisplay key={index} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}
