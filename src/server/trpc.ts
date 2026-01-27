import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import {
  parseAuthHeader,
  generateSessionToken,
  IDLE_TIMEOUT_MS,
  TOKEN_ROTATION_INTERVAL_MS,
  ACTIVITY_UPDATE_THROTTLE_MS,
} from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';

const log = createLogger('trpc');

export interface Context {
  sessionId: string | null;
  rotatedToken: string | null; // New token if rotation occurred
}

export async function createContext(opts: { headers: Headers }): Promise<Context> {
  const authHeader = opts.headers.get('authorization');
  const token = parseAuthHeader(authHeader);

  if (!token) {
    return { sessionId: null, rotatedToken: null };
  }

  const session = await prisma.authSession.findUnique({
    where: { token },
    select: { id: true, expiresAt: true, lastActivityAt: true, revokedAt: true },
  });

  if (!session) {
    return { sessionId: null, rotatedToken: null };
  }

  const now = new Date();

  // Check if session has been revoked
  if (session.revokedAt) {
    return { sessionId: null, rotatedToken: null };
  }

  // Check if session has expired
  if (session.expiresAt < now) {
    return { sessionId: null, rotatedToken: null };
  }

  // Check for idle timeout
  const idleTime = now.getTime() - session.lastActivityAt.getTime();
  if (idleTime > IDLE_TIMEOUT_MS) {
    // Session is idle, reject it (but don't delete - keep for audit/display)
    log.info('Session rejected due to idle timeout', { sessionId: session.id });
    return { sessionId: null, rotatedToken: null };
  }

  // Check if token rotation is needed (more than TOKEN_ROTATION_INTERVAL_MS since last activity)
  let rotatedToken: string | null = null;
  if (idleTime > TOKEN_ROTATION_INTERVAL_MS) {
    // Rotate the token
    const newToken = generateSessionToken();
    try {
      await prisma.authSession.update({
        where: { id: session.id },
        data: { token: newToken, lastActivityAt: now },
      });
      rotatedToken = newToken;
      log.info('Session token rotated', { sessionId: session.id });
    } catch {
      // If update fails (e.g., race condition), just continue with activity update
      log.warn('Token rotation failed, continuing with activity update', { sessionId: session.id });
    }
  } else if (idleTime > ACTIVITY_UPDATE_THROTTLE_MS) {
    // Just update last activity (throttled to avoid excessive DB writes)
    prisma.authSession
      .update({
        where: { id: session.id },
        data: { lastActivityAt: now },
      })
      .catch(() => {
        // Fire and forget - don't fail the request if activity update fails
      });
  }

  return { sessionId: session.id, rotatedToken };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  sse: {
    ping: {
      enabled: true,
      intervalMs: 2000,
    },
    client: {
      reconnectAfterInactivityMs: 5000,
    },
  },
});

// Logging middleware for all procedures
const loggingMiddleware = t.middleware(async ({ path, type, next }) => {
  const start = Date.now();
  const result = await next();
  const duration = Date.now() - start;

  if (result.ok) {
    log.info(`${type} ${path}`, { duration });
  } else {
    log.warn(`${type} ${path} failed`, { duration, error: result.error.message });
  }

  return result;
});

// Base procedure with logging
const baseProcedure = t.procedure.use(loggingMiddleware);

export const router = t.router;
export const publicProcedure = baseProcedure;

export const protectedProcedure = baseProcedure.use(({ ctx, next }) => {
  if (!ctx.sessionId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  return next({
    ctx: {
      sessionId: ctx.sessionId,
    },
  });
});
