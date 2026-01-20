'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';

// Map of tool_use_id -> result content
export type ToolResultMap = Map<string, { content?: string; is_error?: boolean }>;

interface ToolCall {
  name: string;
  id?: string;
  input: unknown;
  output?: unknown;
  is_error?: boolean;
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
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

/**
 * Display component for raw/unrecognized JSON messages.
 * Shows collapsed by default to avoid cluttering the UI.
 */
function RawJsonDisplay({ content, label }: { content: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);

  const formatJson = (data: unknown): string => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card className="border-dashed border-amber-300 dark:border-amber-700">
        <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-xs border-amber-500 text-amber-700 dark:text-amber-400"
            >
              {label || 'Raw Message'}
            </Badge>
            <span className="text-muted-foreground text-xs">Click to expand JSON</span>
          </div>
          <span className="text-muted-foreground">{expanded ? '−' : '+'}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="p-3">
            <pre className="bg-muted p-2 rounded overflow-x-auto max-h-96 overflow-y-auto text-xs font-mono">
              {formatJson(content)}
            </pre>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card
        className={cn(
          'mt-2',
          tool.is_error && 'border-red-300 dark:border-red-700',
          isPending && 'border-yellow-300 dark:border-yellow-700'
        )}
      >
        <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
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
  );
}

function ToolResultDisplay({ results }: { results: ContentBlock[] }) {
  const [expanded, setExpanded] = useState(false);

  // Check if any result is an error
  const hasError = results.some((r) => r.is_error);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <Card className={cn('border', hasError && 'border-red-300 dark:border-red-700')}>
        <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
          <div className="flex items-center gap-2">
            <Badge variant={hasError ? 'destructive' : 'secondary'}>
              Tool Result{results.length > 1 ? 's' : ''}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {results.length} result{results.length > 1 ? 's' : ''}
            </span>
          </div>
          <span className="text-muted-foreground">{expanded ? '−' : '+'}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="p-3 space-y-2 text-xs">
            {results.map((result, index) => (
              <div key={result.tool_use_id || index}>
                {result.tool_use_id && (
                  <div className="text-muted-foreground mb-1 font-mono text-xs">
                    {result.tool_use_id}
                  </div>
                )}
                <pre
                  className={cn(
                    'p-2 rounded overflow-x-auto max-h-48 overflow-y-auto',
                    result.is_error
                      ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                      : 'bg-muted'
                  )}
                >
                  {typeof result.content === 'string'
                    ? result.content
                    : JSON.stringify(result.content, null, 2)}
                </pre>
              </div>
            ))}
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

function renderContentBlocks(blocks: ContentBlock[], toolResults?: ToolResultMap): React.ReactNode {
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
          {toolUseBlocks.map((block) => {
            // Look up the result for this tool_use
            const result = block.id ? toolResults?.get(block.id) : undefined;
            return (
              <ToolCallDisplay
                key={block.id}
                tool={{
                  name: block.name || 'Unknown',
                  id: block.id,
                  input: block.input,
                  output: result?.content,
                  is_error: result?.is_error,
                }}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function renderContent(content: unknown, toolResults?: ToolResultMap): React.ReactNode {
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }

  if (Array.isArray(content)) {
    return renderContentBlocks(content as ContentBlock[], toolResults);
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
}: {
  message: { type: string; content: unknown };
  toolResults?: ToolResultMap;
}) {
  const { type } = message;
  const content = (message.content || {}) as MessageContent;

  // Check if we can properly display this message
  const recognition = isRecognizedMessage(type, content);

  // Unrecognized messages get the raw JSON display (collapsed by default)
  if (!recognition.recognized) {
    return (
      <div className="w-full max-w-[85%]">
        <RawJsonDisplay content={message.content} label={`Unknown: ${type}`} />
      </div>
    );
  }

  const { category } = recognition;

  // System init messages get their own compact display
  if (category === 'systemInit') {
    return (
      <div className="w-full max-w-[85%]">
        <SystemInitDisplay content={content} />
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
  const isUser = category === 'user';
  const isAssistant = category === 'assistant';
  const isSystem = category === 'system';
  const isError = category === 'systemError';

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
      {renderContent(displayContent, toolResults)}

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
