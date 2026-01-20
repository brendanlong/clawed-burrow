import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import type { SessionStatus } from '@/lib/types';
import { cloneRepo, removeWorkspace } from '../services/git';
import {
  createAndStartContainer,
  stopContainer,
  removeContainer,
  getContainerStatus,
} from '../services/docker';
import { sseEvents } from '../services/events';

const sessionStatusSchema = z.enum(['creating', 'running', 'stopped', 'error']);

// Background session setup - runs after create mutation returns
async function setupSession(
  sessionId: string,
  repoFullName: string,
  branch: string,
  githubToken?: string
): Promise<void> {
  const updateStatus = async (message: string) => {
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: { statusMessage: message },
    });
    sseEvents.emitSessionUpdate(sessionId, session);
  };

  try {
    // Clone the repository
    const { workspacePath } = await cloneRepo(repoFullName, branch, sessionId, githubToken);

    // Update status
    await updateStatus('Starting container...');

    // Start container with GitHub token for push/pull access
    const containerId = await createAndStartContainer({
      sessionId,
      workspacePath,
      githubToken,
    });

    // Update session with container info
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: {
        workspacePath,
        containerId,
        status: 'running',
        statusMessage: null,
      },
    });
    sseEvents.emitSessionUpdate(sessionId, session);
  } catch (error) {
    // Mark session as error with message
    const errorMessage = error instanceof Error ? error.message : 'Failed to create session';
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: 'error',
        statusMessage: errorMessage,
      },
    });
    sseEvents.emitSessionUpdate(sessionId, session);
  }
}

export const sessionsRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
        branch: z.string().min(1),
        initialPrompt: z.string().max(100000).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const githubToken = process.env.GITHUB_TOKEN;

      // Create session record first
      const session = await prisma.session.create({
        data: {
          name: input.name,
          repoUrl: `https://github.com/${input.repoFullName}.git`,
          branch: input.branch,
          workspacePath: '', // Will be updated after clone
          status: 'creating',
          statusMessage: 'Cloning repository...',
          initialPrompt: input.initialPrompt || null,
        },
      });

      // Start setup in background (don't await)
      setupSession(session.id, input.repoFullName, input.branch, githubToken).catch((error) => {
        console.error('Session setup failed:', error);
      });

      // Return immediately so UI can navigate to session page
      return { session };
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
        const githubToken = process.env.GITHUB_TOKEN;
        const containerId = await createAndStartContainer({
          sessionId: session.id,
          workspacePath: session.workspacePath,
          githubToken,
        });

        const updatedSession = await prisma.session.update({
          where: { id: session.id },
          data: {
            containerId,
            status: 'running',
          },
        });

        sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
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

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
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

      // Remove workspace
      await removeWorkspace(session.id);

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
