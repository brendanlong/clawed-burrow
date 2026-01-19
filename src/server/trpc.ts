import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { JWTPayload } from '@/lib/auth';
import { verifyToken, parseAuthHeader } from '@/lib/auth';

export interface Context {
  user: JWTPayload | null;
}

export function createContext(opts: { headers: Headers }): Context {
  const authHeader = opts.headers.get('authorization');
  const token = parseAuthHeader(authHeader);
  const user = token ? verifyToken(token) : null;

  return { user };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  return next({
    ctx: {
      user: ctx.user,
    },
  });
});
