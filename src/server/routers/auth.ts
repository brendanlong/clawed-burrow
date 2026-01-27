import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { verifyPassword, generateSessionToken, loginSchema, SESSION_DURATION_MS } from '@/lib/auth';
import { loginRateLimiter } from '@/lib/rate-limiter';
import { env } from '@/lib/env';
import { TRPCError } from '@trpc/server';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('auth');

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
      // Rate limit by IP address (use 'unknown' if IP not provided)
      const rateLimitKey = input.ipAddress ?? 'unknown';
      const rateLimitCheck = loginRateLimiter.check(rateLimitKey);

      if (!rateLimitCheck.allowed) {
        const retryAfterMinutes = Math.ceil((rateLimitCheck.retryAfterMs ?? 0) / 60000);
        log.warn('Login rate limited', { ip: input.ipAddress, retryAfterMinutes });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many login attempts. Please try again in ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? '' : 's'}.`,
        });
      }

      // Check if password hash is configured
      if (!env.PASSWORD_HASH) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Authentication not configured. Set PASSWORD_HASH environment variable.',
        });
      }

      let valid: boolean;
      try {
        valid = await verifyPassword(input.password, env.PASSWORD_HASH);
      } catch (error) {
        log.error('Password verification error', toError(error));
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid PASSWORD_HASH format. Generate with: pnpm hash-password <yourpassword>',
        });
      }

      if (!valid) {
        // Record failed attempt for rate limiting
        const failureResult = loginRateLimiter.recordFailure(rateLimitKey);
        log.warn('Failed login attempt', {
          ip: input.ipAddress,
          remainingAttempts: failureResult.remainingAttempts,
        });
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid password',
        });
      }

      // Record successful login (resets attempt counter)
      loginRateLimiter.recordSuccess(rateLimitKey);

      const token = await createAuthSession(input.ipAddress, input.userAgent);

      return { token };
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    // Revoke the current session instead of deleting
    await prisma.authSession.update({
      where: { id: ctx.sessionId },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }),

  logoutAll: protectedProcedure.mutation(async () => {
    // Revoke all non-revoked sessions
    await prisma.authSession.updateMany({
      where: { revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }),

  listSessions: protectedProcedure.query(async ({ ctx }) => {
    const sessions = await prisma.authSession.findMany({
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        lastActivityAt: true,
        revokedAt: true,
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
      // Prevent revoking current session via this endpoint
      if (input.sessionId === ctx.sessionId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Use logout to revoke your current session',
        });
      }

      // Revoke the session instead of deleting
      await prisma.authSession.update({
        where: { id: input.sessionId },
        data: { revokedAt: new Date() },
      });

      return { success: true };
    }),
});
