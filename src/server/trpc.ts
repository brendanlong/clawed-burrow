import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { parseAuthHeader } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export interface Context {
  sessionId: string | null;
}

export async function createContext(opts: { headers: Headers }): Promise<Context> {
  const authHeader = opts.headers.get('authorization');
  const token = parseAuthHeader(authHeader);

  if (!token) {
    return { sessionId: null };
  }

  const session = await prisma.authSession.findUnique({
    where: { token },
    select: { id: true, expiresAt: true },
  });

  if (!session || session.expiresAt < new Date()) {
    return { sessionId: null };
  }

  return { sessionId: session.id };
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

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
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
