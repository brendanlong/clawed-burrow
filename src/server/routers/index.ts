import { router } from '../trpc';
import { authRouter } from './auth';
import { sessionsRouter } from './sessions';
import { claudeRouter } from './claude';
import { githubRouter } from './github';

export const appRouter = router({
  auth: authRouter,
  sessions: sessionsRouter,
  claude: claudeRouter,
  github: githubRouter,
});

export type AppRouter = typeof appRouter;
