import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import {
  createAndStartContainer,
  stopContainer,
  removeContainer,
  cloneRepoInVolume,
  removeWorkspaceFromVolume,
  verifyContainerHealth,
} from '../services/podman';
import { getRepoSettingsForContainer } from '../services/repo-settings';
import { syncSessionStatus } from '../services/session-reconciler';
import { sseEvents } from '../services/events';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('sessions');

const sessionStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'archived']);

// Background session setup - runs after create mutation returns
async function setupSession(
  sessionId: string,
  repoFullName: string,
  branch: string,
  githubToken?: string
): Promise<void> {
  log.info('Starting session setup', { sessionId, repoFullName, branch });

  const updateStatus = async (message: string) => {
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: { statusMessage: message },
    });
    sseEvents.emitSessionUpdate(sessionId, session);
  };

  try {
    // Clone the repository into the workspaces volume
    log.info('Cloning repository', { sessionId, repoFullName, branch });
    const { repoPath } = await cloneRepoInVolume({
      sessionId,
      repoFullName,
      branch,
      githubToken,
    });
    log.info('Repository cloned', { sessionId, repoPath });

    // Update status
    await updateStatus('Starting container...');

    // Fetch per-repo settings (env vars, MCP servers)
    const repoSettings = await getRepoSettingsForContainer(repoFullName);

    // Start container with GitHub token for push/pull access and repo-specific settings
    log.info('Starting container', { sessionId, hasRepoSettings: !!repoSettings });
    const containerId = await createAndStartContainer({
      sessionId,
      repoPath,
      githubToken,
      repoEnvVars: repoSettings?.envVars,
      mcpServers: repoSettings?.mcpServers,
    });
    log.info('Container started', { sessionId, containerId });

    // Verify container is healthy before marking session as running
    await updateStatus('Verifying container health...');
    await verifyContainerHealth(containerId);
    log.info('Container health verified', { sessionId, containerId });

    // Update session with container info
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: {
        repoPath,
        containerId,
        status: 'running',
        statusMessage: null,
      },
    });
    sseEvents.emitSessionUpdate(sessionId, session);

    log.info('Session setup complete', { sessionId });
  } catch (error) {
    // Log the full error with stack trace
    log.error('Session setup failed', toError(error), { sessionId, repoFullName, branch });

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
          workspacePath: '', // Deprecated - workspaces now use named volumes
          status: 'creating',
          statusMessage: 'Cloning repository...',
          initialPrompt: input.initialPrompt || null,
        },
      });

      // Start setup in background (don't await)
      // Note: setupSession already logs errors internally, but we catch here
      // to prevent unhandled promise rejections
      setupSession(session.id, input.repoFullName, input.branch, githubToken).catch((error) => {
        log.error('Unhandled error in session setup', toError(error), { sessionId: session.id });
      });

      // Return immediately so UI can navigate to session page
      return { session };
    }),

  list: protectedProcedure
    .input(
      z
        .object({
          status: sessionStatusSchema.optional(),
          includeArchived: z.boolean().optional(), // Default false - excludes archived sessions
        })
        .optional()
    )
    .query(async ({ input }) => {
      const includeArchived = input?.includeArchived ?? false;

      const sessions = await prisma.session.findMany({
        where: {
          ...(input?.status ? { status: input.status } : {}),
          // By default, exclude archived sessions unless explicitly requested
          ...(!includeArchived && !input?.status ? { status: { not: 'archived' } } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      });

      return { sessions };
    }),

  get: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      // Sync session status with actual container state before returning
      const newStatus = await syncSessionStatus(input.sessionId);

      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      // If status was updated, emit SSE event so other clients are notified
      if (newStatus !== null) {
        sseEvents.emitSessionUpdate(input.sessionId, session);
      }

      return { session };
    }),

  start: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      // Sync status with actual container state first
      await syncSessionStatus(input.sessionId);

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

        // Extract repoFullName from repoUrl (e.g., "https://github.com/owner/repo.git" -> "owner/repo")
        const repoFullNameMatch = session.repoUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
        const repoFullName = repoFullNameMatch?.[1];

        // Fetch per-repo settings (env vars, MCP servers)
        const repoSettings = repoFullName ? await getRepoSettingsForContainer(repoFullName) : null;

        const containerId = await createAndStartContainer({
          sessionId: session.id,
          repoPath: session.repoPath,
          githubToken,
          repoEnvVars: repoSettings?.envVars,
          mcpServers: repoSettings?.mcpServers,
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

      // If already archived, nothing to do
      if (session.status === 'archived') {
        return { success: true };
      }

      // Stop and remove container
      if (session.containerId) {
        await removeContainer(session.containerId);
      }

      // Remove workspace from volume
      await removeWorkspaceFromVolume(session.id);

      // Archive session instead of deleting (keep messages for later viewing)
      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: {
          status: 'archived',
          archivedAt: new Date(),
          containerId: null, // Clear container ID since container is removed
        },
      });

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { success: true };
    }),

  syncStatus: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      // Use the centralized syncSessionStatus function
      const newStatus = await syncSessionStatus(input.sessionId);

      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        return { session: null };
      }

      // If status was updated, emit SSE event so other clients are notified
      if (newStatus !== null) {
        sseEvents.emitSessionUpdate(input.sessionId, session);
      }

      return { session };
    }),
});
