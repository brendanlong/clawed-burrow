import { EventEmitter } from 'events';
import type { Message, Session } from '@prisma/client';

// Message with parsed content (for SSE events)
export type ParsedMessage = Omit<Message, 'content'> & { content: unknown };

// Event types for type-safe event handling
export interface SessionUpdateEvent {
  type: 'session_update';
  sessionId: string;
  session: Session;
}

export interface MessageEvent {
  type: 'new_message';
  sessionId: string;
  message: ParsedMessage;
}

export interface ClaudeRunningEvent {
  type: 'claude_running';
  sessionId: string;
  running: boolean;
}

export type SSEEvent = SessionUpdateEvent | MessageEvent | ClaudeRunningEvent;

// Create a typed event emitter
class SSEEventEmitter extends EventEmitter {
  emitSessionUpdate(sessionId: string, session: Session): void {
    this.emit(`session:${sessionId}`, {
      type: 'session_update',
      sessionId,
      session,
    } satisfies SessionUpdateEvent);
  }

  emitNewMessage(sessionId: string, message: ParsedMessage): void {
    this.emit(`messages:${sessionId}`, {
      type: 'new_message',
      sessionId,
      message,
    } satisfies MessageEvent);
  }

  emitClaudeRunning(sessionId: string, running: boolean): void {
    this.emit(`claude:${sessionId}`, {
      type: 'claude_running',
      sessionId,
      running,
    } satisfies ClaudeRunningEvent);
  }

  // Subscribe to session updates for a specific session
  onSessionUpdate(sessionId: string, callback: (event: SessionUpdateEvent) => void): () => void {
    const eventName = `session:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  // Subscribe to new messages for a specific session
  onNewMessage(sessionId: string, callback: (event: MessageEvent) => void): () => void {
    const eventName = `messages:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  // Subscribe to Claude running state changes for a specific session
  onClaudeRunning(sessionId: string, callback: (event: ClaudeRunningEvent) => void): () => void {
    const eventName = `claude:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }
}

// Singleton instance for the application
export const sseEvents = new SSEEventEmitter();

// Increase max listeners to handle many concurrent sessions
sseEvents.setMaxListeners(1000);
