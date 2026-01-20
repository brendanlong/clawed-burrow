import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { verifyPassword, generateSessionToken, loginSchema, SESSION_DURATION_MS } from '@/lib/auth';
import { env } from '@/lib/env';
import { TRPCError } from '@trpc/server';

async function createAuthSession(ipAddress?: string, userAgent?: string): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await prisma.authSession.create({
    data: {
      token,
      expiresAt,
      ipAddress,
      userAgent,
    },
  });

  return token;
}

export const authRouter = router({
  login: publicProcedure
    .input(
      loginSchema.extend({
        ipAddress: z.string().optional(),
        userAgent: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Check if password hash is configured
      if (!env.PASSWORD_HASH) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Authentication not configured. Set PASSWORD_HASH environment variable.',
        });
      }

      const valid = await verifyPassword(input.password, env.PASSWORD_HASH);

      if (!valid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid password',
        });
      }

      const token = await createAuthSession(input.ipAddress, input.userAgent);

      return { token };
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    // Delete the current session
    await prisma.authSession.delete({
      where: { id: ctx.sessionId },
    });

    return { success: true };
  }),

  logoutAll: protectedProcedure.mutation(async () => {
    // Delete all sessions (logs out everywhere)
    await prisma.authSession.deleteMany({});

    return { success: true };
  }),

  listSessions: protectedProcedure.query(async ({ ctx }) => {
    const sessions = await prisma.authSession.findMany({
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      sessions: sessions.map((s) => ({
        ...s,
        isCurrent: s.id === ctx.sessionId,
      })),
    };
  }),

  deleteSession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Prevent deleting current session via this endpoint
      if (input.sessionId === ctx.sessionId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Use logout to delete your current session',
        });
      }

      await prisma.authSession.delete({
        where: { id: input.sessionId },
      });

      return { success: true };
    }),
});
