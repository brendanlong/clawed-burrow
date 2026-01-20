import { router } from '../trpc';
import { authRouter } from './auth';
import { sessionsRouter } from './sessions';
import { claudeRouter } from './claude';
import { githubRouter } from './github';
import { sseRouter } from './sse';

export const appRouter = router({
  auth: authRouter,
  sessions: sessionsRouter,
  claude: claudeRouter,
  github: githubRouter,
  sse: sseRouter,
});

export type AppRouter = typeof appRouter;
