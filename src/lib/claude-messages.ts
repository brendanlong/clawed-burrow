/**
 * Claude Code Message Types
 *
 * This module provides typed parsing for all message types from Claude Code's
 * stream-json output format. Uses Zod for runtime validation.
 */

import { z } from 'zod';

// =============================================================================
// Content Block Schemas
// =============================================================================

/**
 * Text content block in an assistant message
 */
export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

/**
 * Tool use content block - represents a tool call by the assistant
 */
export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

/**
 * Tool result content block - represents the result of a tool call
 */
export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string().optional(),
  is_error: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

/**
 * Union of all content block types
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// =============================================================================
// Usage Schemas
// =============================================================================

/**
 * Cache creation info
 */
export const CacheCreationSchema = z.object({
  ephemeral_5m_input_tokens: z.number().optional(),
  ephemeral_1h_input_tokens: z.number().optional(),
});
export type CacheCreation = z.infer<typeof CacheCreationSchema>;

/**
 * Usage statistics for a single message
 */
export const MessageUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation: CacheCreationSchema.optional(),
  service_tier: z.string().optional(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

/**
 * Usage stats for a specific model in result messages
 */
export const ModelUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  webSearchRequests: z.number().optional(),
  costUSD: z.number().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/**
 * Server tool use stats
 */
export const ServerToolUseSchema = z.object({
  web_search_requests: z.number().optional(),
  web_fetch_requests: z.number().optional(),
});
export type ServerToolUse = z.infer<typeof ServerToolUseSchema>;

/**
 * Aggregated usage for result messages
 */
export const ResultUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  server_tool_use: ServerToolUseSchema.optional(),
  service_tier: z.string().optional(),
  cache_creation: CacheCreationSchema.optional(),
});
export type ResultUsage = z.infer<typeof ResultUsageSchema>;

// =============================================================================
// Inner Message Schemas
// =============================================================================

/**
 * The inner message object from the API response
 */
export const ApiMessageSchema = z.object({
  model: z.string().optional(),
  id: z.string().optional(),
  type: z.literal('message').optional(),
  role: z.enum(['assistant', 'user']),
  content: z.array(ContentBlockSchema),
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: MessageUsageSchema.optional(),
  context_management: z.unknown().nullable().optional(),
});
export type ApiMessage = z.infer<typeof ApiMessageSchema>;

// =============================================================================
// Message Content Schemas (outer wrapper)
// =============================================================================

/**
 * Assistant message content
 */
export const AssistantContentSchema = z.object({
  type: z.literal('assistant'),
  message: ApiMessageSchema,
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string(),
  uuid: z.string(),
});
export type AssistantContent = z.infer<typeof AssistantContentSchema>;

/**
 * User message content (can contain tool results)
 */
export const UserContentSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.array(ContentBlockSchema),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string(),
  uuid: z.string(),
  tool_use_result: z.unknown().optional(),
});
export type UserContent = z.infer<typeof UserContentSchema>;

/**
 * System init message content
 */
export const SystemInitContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  cwd: z.string(),
  session_id: z.string(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  model: z.string(),
  permissionMode: z.string().optional(),
  slash_commands: z.array(z.string()).optional(),
  apiKeySource: z.string().optional(),
  claude_code_version: z.string().optional(),
  output_style: z.string().optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.unknown()).optional(),
  plugins: z.array(z.unknown()).optional(),
  uuid: z.string().optional(),
});
export type SystemInitContent = z.infer<typeof SystemInitContentSchema>;

/**
 * System error message content - can contain embedded JSON with tool results
 */
export const SystemErrorContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('error'),
  content: z.array(
    z.object({
      type: z.literal('text'),
      text: z.string(),
    })
  ),
});
export type SystemErrorContent = z.infer<typeof SystemErrorContentSchema>;

/**
 * Generic system content (for other subtypes)
 */
export const SystemGenericContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(),
  content: z.unknown().optional(),
});
export type SystemGenericContent = z.infer<typeof SystemGenericContentSchema>;

/**
 * Result message content (session completion)
 */
export const ResultContentSchema = z.object({
  type: z.literal('result'),
  subtype: z.enum(['success', 'error']),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  num_turns: z.number().optional(),
  result: z.string().optional(),
  session_id: z.string(),
  total_cost_usd: z.number().optional(),
  usage: ResultUsageSchema.optional(),
  modelUsage: z.record(z.string(), ModelUsageSchema).optional(),
  permission_denials: z.array(z.unknown()).optional(),
  uuid: z.string().optional(),
});
export type ResultContent = z.infer<typeof ResultContentSchema>;

// =============================================================================
// Database Message Schemas (what we store and retrieve)
// =============================================================================

/**
 * Schema for messages as stored in the database
 */
export const StoredMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sequence: z.number(),
  type: z.enum(['system', 'user', 'assistant', 'result']),
  content: z.unknown(), // JSON content varies by type
  createdAt: z.date().or(z.string().transform((s) => new Date(s))),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

// =============================================================================
// Parsed Message Classes
// =============================================================================

/**
 * Base class for all parsed messages
 */
export abstract class ParsedMessage {
  constructor(
    public readonly id: string,
    public readonly sessionId: string,
    public readonly sequence: number,
    public readonly createdAt: Date
  ) {}

  abstract get messageType(): 'system' | 'user' | 'assistant' | 'result';
}

/**
 * Parsed assistant message
 */
export class AssistantMessage extends ParsedMessage {
  readonly messageType = 'assistant' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content: AssistantContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Get all text content concatenated */
  getText(): string {
    return this.content.message.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /** Get all tool use blocks */
  getToolUses(): ToolUseBlock[] {
    return this.content.message.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    );
  }

  /** Get the model used */
  get model(): string | undefined {
    return this.content.message.model;
  }

  /** Get token usage */
  get usage(): MessageUsage | undefined {
    return this.content.message.usage;
  }
}

/**
 * Parsed user message (often contains tool results)
 */
export class UserMessage extends ParsedMessage {
  readonly messageType = 'user' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content: UserContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Check if this is a tool result message */
  isToolResult(): boolean {
    return this.content.message.content.some((block) => block.type === 'tool_result');
  }

  /** Get all tool result blocks */
  getToolResults(): ToolResultBlock[] {
    return this.content.message.content.filter(
      (block): block is ToolResultBlock => block.type === 'tool_result'
    );
  }

  /** Build a map of tool_use_id -> result for matching with tool uses */
  getToolResultMap(): Map<string, { content?: string; is_error?: boolean }> {
    const map = new Map<string, { content?: string; is_error?: boolean }>();
    for (const result of this.getToolResults()) {
      map.set(result.tool_use_id, {
        content: result.content,
        is_error: result.is_error,
      });
    }
    return map;
  }
}

/**
 * Parsed system message
 */
export class SystemMessage extends ParsedMessage {
  readonly messageType = 'system' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content: SystemInitContent | SystemErrorContent | SystemGenericContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Check if this is an init message */
  isInit(): this is SystemMessage & { content: SystemInitContent } {
    return this.content.subtype === 'init';
  }

  /** Check if this is an error message */
  isError(): this is SystemMessage & { content: SystemErrorContent } {
    return this.content.subtype === 'error';
  }

  /** Get error text if this is an error message */
  getErrorText(): string | undefined {
    if (!this.isError()) return undefined;
    const errorContent = this.content as SystemErrorContent;
    return errorContent.content.map((c) => c.text).join('\n');
  }

  /** Get session info if this is an init message */
  getInitInfo():
    | {
        model: string;
        cwd: string;
        tools?: string[];
        version?: string;
      }
    | undefined {
    if (!this.isInit()) return undefined;
    const initContent = this.content as SystemInitContent;
    return {
      model: initContent.model,
      cwd: initContent.cwd,
      tools: initContent.tools,
      version: initContent.claude_code_version,
    };
  }
}

/**
 * Parsed result message (session completion)
 */
export class ResultMessage extends ParsedMessage {
  readonly messageType = 'result' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content: ResultContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Check if the session completed successfully */
  get isSuccess(): boolean {
    return this.content.subtype === 'success' && !this.content.is_error;
  }

  /** Get the result text */
  get resultText(): string | undefined {
    return this.content.result;
  }

  /** Get total cost in USD */
  get costUsd(): number | undefined {
    return this.content.total_cost_usd;
  }

  /** Get duration in milliseconds */
  get durationMs(): number | undefined {
    return this.content.duration_ms;
  }

  /** Get number of turns */
  get numTurns(): number | undefined {
    return this.content.num_turns;
  }

  /** Get aggregated usage stats */
  get usage(): ResultUsage | undefined {
    return this.content.usage;
  }
}

/**
 * Raw/unknown message - used for messages that fail validation or are unknown types
 * These should be displayed as collapsed JSON in the UI
 */
export class RawMessage extends ParsedMessage {
  readonly messageType = 'system' as const; // Treat as system for display purposes

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly rawContent: unknown,
    public readonly parseError?: string
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Get the raw content as a formatted JSON string */
  getFormattedJson(): string {
    try {
      return JSON.stringify(this.rawContent, null, 2);
    } catch {
      return String(this.rawContent);
    }
  }

  /** Check if this was a parse error vs just unknown type */
  get isParseError(): boolean {
    return this.parseError !== undefined;
  }
}

// Union type for all parsed messages
export type AnyParsedMessage =
  | AssistantMessage
  | UserMessage
  | SystemMessage
  | ResultMessage
  | RawMessage;

// =============================================================================
// Parsing Functions
// =============================================================================

/**
 * Parse a stored message into a typed ParsedMessage
 * Returns RawMessage for unknown types or validation failures
 */
export function parseStoredMessage(stored: StoredMessage): AnyParsedMessage {
  const { id, sessionId, sequence, type, content, createdAt } = stored;
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);

  switch (type) {
    case 'assistant': {
      const parsed = AssistantContentSchema.safeParse(content);
      if (!parsed.success) {
        console.warn('Failed to parse assistant message:', parsed.error);
        return new RawMessage(
          id,
          sessionId,
          sequence,
          date,
          content,
          `Failed to parse assistant message: ${parsed.error.message}`
        );
      }
      return new AssistantMessage(id, sessionId, sequence, date, parsed.data);
    }

    case 'user': {
      const parsed = UserContentSchema.safeParse(content);
      if (!parsed.success) {
        console.warn('Failed to parse user message:', parsed.error);
        return new RawMessage(
          id,
          sessionId,
          sequence,
          date,
          content,
          `Failed to parse user message: ${parsed.error.message}`
        );
      }
      return new UserMessage(id, sessionId, sequence, date, parsed.data);
    }

    case 'system': {
      // Try init first, then error, then generic
      const initParsed = SystemInitContentSchema.safeParse(content);
      if (initParsed.success) {
        return new SystemMessage(id, sessionId, sequence, date, initParsed.data);
      }

      const errorParsed = SystemErrorContentSchema.safeParse(content);
      if (errorParsed.success) {
        return new SystemMessage(id, sessionId, sequence, date, errorParsed.data);
      }

      // Fall back to generic
      const genericParsed = SystemGenericContentSchema.safeParse(content);
      if (genericParsed.success) {
        return new SystemMessage(id, sessionId, sequence, date, genericParsed.data);
      }

      // All system parsers failed - return raw
      console.warn('Failed to parse system message:', content);
      return new RawMessage(
        id,
        sessionId,
        sequence,
        date,
        content,
        'Failed to parse system message'
      );
    }

    case 'result': {
      const parsed = ResultContentSchema.safeParse(content);
      if (!parsed.success) {
        console.warn('Failed to parse result message:', parsed.error);
        return new RawMessage(
          id,
          sessionId,
          sequence,
          date,
          content,
          `Failed to parse result message: ${parsed.error.message}`
        );
      }
      return new ResultMessage(id, sessionId, sequence, date, parsed.data);
    }

    default: {
      // Unknown type - return raw message
      console.warn('Unknown message type:', type);
      return new RawMessage(
        id,
        sessionId,
        sequence,
        date,
        content,
        `Unknown message type: ${type}`
      );
    }
  }
}

/**
 * Result of parsing a Claude stream line
 */
export type StreamLineParseResult =
  | {
      success: true;
      data: AssistantContent | UserContent | SystemInitContent | SystemErrorContent | ResultContent;
    }
  | { success: false; raw: unknown; error: string };

/**
 * Parse raw JSON content from Claude Code stream
 * Returns the parsed content or the raw content with an error message
 */
export function parseClaudeStreamLine(json: unknown): StreamLineParseResult {
  if (!json || typeof json !== 'object') {
    return { success: false, raw: json, error: 'Invalid JSON: expected object' };
  }

  const obj = json as Record<string, unknown>;
  const type = obj.type as string;

  switch (type) {
    case 'assistant': {
      const parsed = AssistantContentSchema.safeParse(json);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        raw: json,
        error: `Failed to parse assistant: ${parsed.error.message}`,
      };
    }
    case 'user': {
      const parsed = UserContentSchema.safeParse(json);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return { success: false, raw: json, error: `Failed to parse user: ${parsed.error.message}` };
    }
    case 'system': {
      const initParsed = SystemInitContentSchema.safeParse(json);
      if (initParsed.success) {
        return { success: true, data: initParsed.data };
      }

      const errorParsed = SystemErrorContentSchema.safeParse(json);
      if (errorParsed.success) {
        return { success: true, data: errorParsed.data };
      }

      return { success: false, raw: json, error: 'Failed to parse system message' };
    }
    case 'result': {
      const parsed = ResultContentSchema.safeParse(json);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        raw: json,
        error: `Failed to parse result: ${parsed.error.message}`,
      };
    }
    default:
      return { success: false, raw: json, error: `Unknown message type: ${type}` };
  }
}

/**
 * Extract the message type from raw content
 */
export function getMessageType(content: unknown): 'system' | 'user' | 'assistant' | 'result' {
  if (!content || typeof content !== 'object') return 'system';
  const obj = content as Record<string, unknown>;
  const type = obj.type;
  if (type === 'user') return 'user';
  if (type === 'assistant') return 'assistant';
  if (type === 'result') return 'result';
  return 'system';
}

// =============================================================================
// Helper functions for working with messages
// =============================================================================

/**
 * Build a map of tool_use_id -> result from a list of messages
 * This matches tool_use blocks with their corresponding tool_result
 */
export function buildToolResultMap(
  messages: AnyParsedMessage[]
): Map<string, { content?: string; is_error?: boolean }> {
  const map = new Map<string, { content?: string; is_error?: boolean }>();

  for (const msg of messages) {
    if (msg instanceof UserMessage) {
      const results = msg.getToolResultMap();
      for (const [id, result] of results) {
        map.set(id, result);
      }
    }
  }

  return map;
}

/**
 * Get all tool use IDs from an assistant message
 */
export function getToolUseIds(msg: AssistantMessage): string[] {
  return msg.getToolUses().map((tu) => tu.id);
}

/**
 * Check if a message is a standalone tool result (not part of regular conversation)
 */
export function isStandaloneToolResult(msg: AnyParsedMessage): boolean {
  return msg instanceof UserMessage && msg.isToolResult();
}
