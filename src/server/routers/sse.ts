import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { sseEvents } from '../services/events';
import { tracked } from '@trpc/server';

export const sseRouter = router({
  // Subscribe to session updates (status changes, etc.)
  onSessionUpdate: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      // Create an async iterator from event emitter
      const events: Array<{ type: 'session_update'; sessionId: string; session: unknown }> = [];
      let resolveWait: (() => void) | null = null;

      const unsubscribe = sseEvents.onSessionUpdate(input.sessionId, (event) => {
        events.push(event);
        resolveWait?.();
      });

      // Clean up on abort
      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            yield tracked(event.sessionId, event);
          } else {
            // Wait for next event or abort
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Subscribe to new messages for a session
  onNewMessage: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      const events: Array<{
        type: 'new_message';
        sessionId: string;
        message: { id: string; sequence: number; type: string };
      }> = [];
      let resolveWait: (() => void) | null = null;

      const unsubscribe = sseEvents.onNewMessage(input.sessionId, (event) => {
        // Only send minimal data needed to trigger a refetch
        events.push({
          type: 'new_message',
          sessionId: event.sessionId,
          message: {
            id: event.message.id,
            sequence: event.message.sequence,
            type: event.message.type,
          },
        });
        resolveWait?.();
      });

      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            yield tracked(event.message.id, event);
          } else {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Subscribe to Claude running state changes
  onClaudeRunning: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      const events: Array<{ type: 'claude_running'; sessionId: string; running: boolean }> = [];
      let resolveWait: (() => void) | null = null;

      const unsubscribe = sseEvents.onClaudeRunning(input.sessionId, (event) => {
        events.push(event);
        resolveWait?.();
      });

      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            yield tracked(`${event.sessionId}-${event.running}`, event);
          } else {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),
});
