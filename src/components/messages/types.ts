// Shared types for message display components

// Map of tool_use_id -> result content
export type ToolResultMap = Map<string, { content?: string; is_error?: boolean }>;

export interface ToolCall {
  name: string;
  id?: string;
  input: unknown;
  output?: unknown;
  is_error?: boolean;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface AssistantMessage {
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

export interface MessageContent {
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

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/**
 * Format content as JSON string for copying.
 */
export function formatAsJson(content: unknown): string {
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Build an array of messages representing a tool call and its result.
 * Creates a format suitable for copying to clipboard with both
 * the assistant's tool_use and the user's tool_result.
 */
export function buildToolMessages(tool: ToolCall): unknown[] {
  const messages: unknown[] = [];

  // Add the assistant message with the tool_use
  messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: tool.input,
      },
    ],
  });

  // Add the user message with the tool_result if we have output
  if (tool.output !== undefined) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool.id,
          content: tool.output,
          ...(tool.is_error && { is_error: true }),
        },
      ],
    });
  }

  return messages;
}
