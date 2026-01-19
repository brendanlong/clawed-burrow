import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import type { SessionStatus } from '@/lib/types';
import { cloneOrFetchRepo, createWorktree, removeWorktree } from '../services/git';
import {
  createAndStartContainer,
  stopContainer,
  removeContainer,
  getContainerStatus,
} from '../services/docker';

const sessionStatusSchema = z.enum(['creating', 'running', 'stopped', 'error']);

export const sessionsRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
        branch: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      // Create session record first
      const session = await prisma.session.create({
        data: {
          name: input.name,
          repoUrl: `https://github.com/${input.repoFullName}.git`,
          branch: input.branch,
          worktreePath: '', // Will be updated after worktree creation
          status: 'creating',
        },
      });

      try {
        // Clone or fetch the repo
        const githubToken = process.env.GITHUB_TOKEN;
        await cloneOrFetchRepo(input.repoFullName, githubToken);

        // Create worktree
        const { worktreePath } = await createWorktree(input.repoFullName, input.branch, session.id);

        // Start container
        const containerId = await createAndStartContainer({
          sessionId: session.id,
          worktreePath,
        });

        // Update session with container info
        const updatedSession = await prisma.session.update({
          where: { id: session.id },
          data: {
            worktreePath,
            containerId,
            status: 'running',
          },
        });

        return { session: updatedSession };
      } catch (error) {
        // Mark session as error
        await prisma.session.update({
          where: { id: session.id },
          data: { status: 'error' },
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to create session',
        });
      }
    }),

  list: protectedProcedure
    .input(
      z
        .object({
          status: sessionStatusSchema.optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const sessions = await prisma.session.findMany({
        where: input?.status ? { status: input.status } : undefined,
        orderBy: { updatedAt: 'desc' },
        include: {
          messages: {
            orderBy: { sequence: 'desc' },
            take: 1,
          },
        },
      });

      return {
        sessions: sessions.map((s) => ({
          ...s,
          lastMessage: s.messages[0] || null,
          messages: undefined,
        })),
      };
    }),

  get: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
        include: {
          messages: {
            orderBy: { sequence: 'desc' },
            take: 1,
          },
        },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      return {
        session: {
          ...session,
          lastMessage: session.messages[0] || null,
          messages: undefined,
        },
      };
    }),

  start: protectedProcedure
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

      if (session.status === 'running') {
        return { session };
      }

      try {
        const containerId = await createAndStartContainer({
          sessionId: session.id,
          worktreePath: session.worktreePath,
        });

        const updatedSession = await prisma.session.update({
          where: { id: session.id },
          data: {
            containerId,
            status: 'running',
          },
        });

        return { session: updatedSession };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to start session',
        });
      }
    }),

  stop: protectedProcedure
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

      if (session.containerId) {
        await stopContainer(session.containerId);
      }

      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: { status: 'stopped' },
      });

      return { session: updatedSession };
    }),

  delete: protectedProcedure
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

      // Stop and remove container
      if (session.containerId) {
        await removeContainer(session.containerId);
      }

      // Remove worktree
      await removeWorktree(session.id);

      // Delete session (messages will cascade)
      await prisma.session.delete({
        where: { id: session.id },
      });

      return { success: true };
    }),

  syncStatus: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session || !session.containerId) {
        return { session };
      }

      const containerStatus = await getContainerStatus(session.containerId);

      let newStatus: SessionStatus = session.status as SessionStatus;
      if (containerStatus === 'not_found') {
        newStatus = 'stopped';
      } else if (containerStatus === 'stopped' && session.status === 'running') {
        newStatus = 'stopped';
      } else if (containerStatus === 'running' && session.status === 'stopped') {
        newStatus = 'running';
      }

      if (newStatus !== session.status) {
        const updatedSession = await prisma.session.update({
          where: { id: session.id },
          data: { status: newStatus },
        });
        return { session: updatedSession };
      }

      return { session };
    }),
});
