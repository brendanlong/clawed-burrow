import { z } from 'zod';
import { resolve } from 'path';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/dev.db'),
  GITHUB_TOKEN: z.string().optional(),
  CLAUDE_AUTH_PATH: z.string().default('/root/.claude'),
  // Path inside the container where data is mounted (for filesystem operations)
  DATA_DIR: z
    .string()
    .default('/data')
    .transform((p) => resolve(p)),
  // Host path to data directory - used for bind mounts when creating session containers
  // In Docker-in-Docker setups, this must be the path on the Docker host, not inside this container
  DATA_HOST_PATH: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Prefix for session branches (e.g., "claude/" creates branches like "claude/{sessionId}")
  SESSION_BRANCH_PREFIX: z.string().default('claude/'),
  // Base64-encoded Argon2 hash for authentication (generate with: pnpm hash-password <yourpassword>)
  // The hash is base64-encoded to avoid issues with $ characters in dotenv
  // No default - logins will fail if not set
  PASSWORD_HASH: z
    .string()
    .optional()
    .transform((val) => (val ? Buffer.from(val, 'base64').toString('utf-8') : undefined)),
  // Optional path to host pnpm store for sharing across sessions
  // pnpm's store is safe for concurrent access (atomic operations)
  // Example: /home/user/.local/share/pnpm/store
  PNPM_STORE_PATH: z.string().optional(),
  // Optional path to host Gradle user home for sharing caches across sessions
  // Gradle's cache is safe for concurrent access (file locking)
  // Example: /home/user/.gradle
  GRADLE_USER_HOME: z.string().optional(),
  // Docker image to use for Claude Code runner containers
  // Defaults to local build, but can be set to GHCR image for production
  CLAUDE_RUNNER_IMAGE: z.string().default('claude-code-runner:latest'),
  // Path to the host's Podman socket for container-in-container support
  // This socket is mounted into runner containers so Claude Code can run podman/docker commands
  // Example: /run/user/1000/podman/podman.sock
  PODMAN_SOCKET_PATH: z.string().optional(),
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
