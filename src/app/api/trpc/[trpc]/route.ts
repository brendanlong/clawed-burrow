import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/routers';
import { createContext } from '@/server/trpc';

// Custom header used to notify clients of token rotation
export const TOKEN_ROTATION_HEADER = 'X-Rotated-Token';

const handler = async (req: Request) => {
  // Create context first to check for token rotation
  const ctx = await createContext({ headers: req.headers });

  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => Promise.resolve(ctx),
  });

  // If token was rotated, add it as a header so client can update
  if (ctx.rotatedToken) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set(TOKEN_ROTATION_HEADER, ctx.rotatedToken);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }

  return response;
};

export { handler as GET, handler as POST };
