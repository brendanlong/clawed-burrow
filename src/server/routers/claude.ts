import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import { runClaudeCommand, interruptClaude, isClaudeRunning } from '../services/claude-runner';

export const claudeRouter = router({
  send: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        prompt: z.string().min(1).max(100000),
      })
    )
    .subscription(async function* ({ input }) {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      if (session.status !== 'running' || !session.containerId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Session is not running',
        });
      }

      if (isClaudeRunning(input.sessionId)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Claude is already running for this session',
        });
      }

      // Create a queue to store messages
      const messageQueue: Array<{
        id: string;
        type: string;
        content: unknown;
        sequence: number;
      }> = [];
      let isComplete = false;
      let error: unknown = null;

      // Start the Claude process (runs in background while we yield messages)
      runClaudeCommand(input.sessionId, session.containerId, input.prompt, (message) => {
        messageQueue.push(message);
      })
        .then(() => {
          isComplete = true;
        })
        .catch((err) => {
          error = err;
          isComplete = true;
        });

      // Yield messages as they arrive
      while (!isComplete || messageQueue.length > 0) {
        if (messageQueue.length > 0) {
          const message = messageQueue.shift()!;
          yield message;
        } else {
          // Wait a bit for more messages
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      if (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }),

  interrupt: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      const interrupted = await interruptClaude(input.sessionId);

      return { success: interrupted };
    }),

  getHistory: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        cursor: z.number().int().optional(),
        direction: z.enum(['before', 'after']).default('before'),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      const whereClause: {
        sessionId: string;
        sequence?: { lt?: number; gt?: number };
      } = {
        sessionId: input.sessionId,
      };

      if (input.cursor !== undefined) {
        if (input.direction === 'before') {
          whereClause.sequence = { lt: input.cursor };
        } else {
          whereClause.sequence = { gt: input.cursor };
        }
      }

      const messages = await prisma.message.findMany({
        where: whereClause,
        orderBy: {
          sequence: input.direction === 'before' ? 'desc' : 'asc',
        },
        take: input.limit + 1, // Get one extra to check if there are more
      });

      const hasMore = messages.length > input.limit;
      if (hasMore) {
        messages.pop();
      }

      // Parse content JSON for each message
      const parsedMessages = messages.map((m) => ({
        ...m,
        content: JSON.parse(m.content),
      }));

      // Reverse if we fetched in DESC order so client gets chronological order
      if (input.direction === 'before') {
        parsedMessages.reverse();
      }

      const nextCursor =
        parsedMessages.length > 0
          ? input.direction === 'before'
            ? parsedMessages[0].sequence
            : parsedMessages[parsedMessages.length - 1].sequence
          : undefined;

      return {
        messages: parsedMessages,
        nextCursor,
        hasMore,
      };
    }),

  isRunning: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(({ input }) => {
      return { running: isClaudeRunning(input.sessionId) };
    }),
});
