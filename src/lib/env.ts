import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/dev.db'),
  JWT_SECRET: z.string().default('development-secret-change-in-production'),
  GITHUB_TOKEN: z.string().optional(),
  CLAUDE_AUTH_PATH: z.string().default('/root/.claude'),
  DATA_DIR: z.string().default('/data'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  // During build time, use defaults
  const isBuildTime = process.env.NEXT_PHASE === 'phase-production-build';

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    // In development or build time, use defaults instead of crashing
    if (process.env.NODE_ENV !== 'production' || isBuildTime) {
      console.warn('Using default environment values');
      return envSchema.parse({});
    }
    throw new Error('Invalid environment variables');
  }

  // Warn about insecure defaults in production runtime (not build time)
  if (parsed.data.NODE_ENV === 'production' && !isBuildTime) {
    if (parsed.data.JWT_SECRET === 'development-secret-change-in-production') {
      console.error('ERROR: JWT_SECRET must be set in production!');
      throw new Error('JWT_SECRET must be set in production');
    }
  }

  return parsed.data;
}

export const env = validateEnv();
