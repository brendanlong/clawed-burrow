import { EventEmitter } from 'events';

// Event types for type safety
export interface SessionUpdateEvent {
  sessionId: string;
  status: string;
  statusMessage: string | null;
}

export interface MessageEvent {
  sessionId: string;
  messageId: string;
  sequence: number;
  type: string;
}

export interface ClaudeRunningEvent {
  sessionId: string;
  running: boolean;
}

// Typed event map
interface EventMap {
  sessionUpdate: SessionUpdateEvent;
  newMessage: MessageEvent;
  claudeRunning: ClaudeRunningEvent;
}

// Single global event emitter for server-side events
class ServerEventEmitter {
  private emitter = new EventEmitter();

  constructor() {
    // Increase limit for many concurrent subscriptions
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.emitter.emit(event, data);
  }

  on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  // Create an async iterator for SSE subscriptions
  async *subscribe<K extends keyof EventMap>(
    event: K,
    filter?: (data: EventMap[K]) => boolean
  ): AsyncGenerator<EventMap[K], void, unknown> {
    const queue: EventMap[K][] = [];
    let resolve: (() => void) | null = null;
    const closed = false;

    const listener = (data: EventMap[K]) => {
      if (filter && !filter(data)) return;
      queue.push(data);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.emitter.on(event, listener);

    try {
      while (!closed) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
    } finally {
      this.emitter.off(event, listener);
    }
  }
}

// Export singleton instance
export const serverEvents = new ServerEventEmitter();
