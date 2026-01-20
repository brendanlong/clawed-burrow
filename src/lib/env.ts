import { z } from 'zod';
import { resolve } from 'path';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/dev.db'),
  GITHUB_TOKEN: z.string().optional(),
  CLAUDE_AUTH_PATH: z.string().default('/root/.claude'),
  // Always resolve to absolute path so Docker volume binds work correctly
  DATA_DIR: z
    .string()
    .default('/data')
    .transform((p) => resolve(p)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Prefix for session branches in worktrees (e.g., "claude/" creates "claude/{sessionId}")
  SESSION_BRANCH_PREFIX: z.string().default('claude/'),
  // Argon2-hashed password for authentication (generate with: node -e "require('argon2').hash('yourpassword').then(console.log)")
  // No default - logins will fail if not set
  PASSWORD_HASH: z.string().optional(),
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

  return parsed.data;
}

export const env = validateEnv();
