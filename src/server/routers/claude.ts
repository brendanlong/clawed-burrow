import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import { tracked } from '@trpc/server';
import { runClaudeCommand, interruptClaude, isClaudeRunningAsync } from '../services/claude-runner';
import { serverEvents } from '../services/events';

export const claudeRouter = router({
  send: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        prompt: z.string().min(1).max(100000),
      })
    )
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

      if (session.status !== 'running' || !session.containerId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Session is not running',
        });
      }

      if (await isClaudeRunningAsync(input.sessionId)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Claude is already running for this session',
        });
      }

      // Start Claude in the background - don't await
      runClaudeCommand(input.sessionId, session.containerId, input.prompt).catch((err) => {
        console.error('Claude command failed:', err);
      });

      return { success: true };
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
        direction: z.enum(['forward', 'backward']).default('backward'),
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

      const isBackward = input.direction === 'backward';

      // Build where clause based on direction
      const whereClause: {
        sessionId: string;
        sequence?: { lt: number } | { gt: number };
      } = {
        sessionId: input.sessionId,
      };

      if (input.cursor !== undefined) {
        // backward: load older (sequence < cursor)
        // forward: load newer (sequence > cursor)
        whereClause.sequence = isBackward ? { lt: input.cursor } : { gt: input.cursor };
      }

      const messages = await prisma.message.findMany({
        where: whereClause,
        // backward: newest first (so we get the N most recent before cursor)
        // forward: oldest first (so we get the N oldest after cursor)
        orderBy: { sequence: isBackward ? 'desc' : 'asc' },
        take: input.limit + 1,
      });

      const hasMore = messages.length > input.limit;
      if (hasMore) {
        messages.pop();
      }

      const parsedMessages = messages.map((m) => ({
        ...m,
        content: JSON.parse(m.content),
      }));

      // For backward pagination, reverse so client gets chronological order
      if (isBackward) {
        parsedMessages.reverse();
      }

      // Cursor for next page depends on direction:
      // backward: oldest message's sequence (to load even older)
      // forward: newest message's sequence (to load even newer)
      const nextCursor =
        parsedMessages.length > 0
          ? isBackward
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
    .query(async ({ input }) => {
      return { running: await isClaudeRunningAsync(input.sessionId) };
    }),

  // SSE subscription for new messages
  onMessage: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      // Yield initial state to indicate subscription is active
      yield tracked('connected', { connected: true });

      // Subscribe to message events for this session
      for await (const event of serverEvents.subscribe(
        'newMessage',
        (e) => e.sessionId === input.sessionId
      )) {
        if (signal?.aborted) break;
        yield tracked(event.messageId, {
          messageId: event.messageId,
          sequence: event.sequence,
          type: event.type,
        });
      }
    }),

  // SSE subscription for Claude running state changes
  onRunningChange: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      // Yield initial state
      const initialRunning = await isClaudeRunningAsync(input.sessionId);
      yield tracked('initial', { running: initialRunning });

      // Subscribe to running state changes for this session
      for await (const event of serverEvents.subscribe(
        'claudeRunning',
        (e) => e.sessionId === input.sessionId
      )) {
        if (signal?.aborted) break;
        yield tracked(`running-${Date.now()}`, { running: event.running });
      }
    }),
});
