import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/dev.db'),
  GITHUB_TOKEN: z.string().optional(),
  CLAUDE_AUTH_PATH: z.string().default('/root/.claude'),
  // Named volume for pnpm store - shared across all runner containers
  // Speeds up package installs by caching downloaded packages
  PNPM_STORE_VOLUME: z.string().default('clawed-burrow-pnpm-store'),
  // Named volume for Gradle cache - shared across all runner containers
  // Speeds up builds by caching downloaded dependencies and build outputs
  GRADLE_CACHE_VOLUME: z.string().default('clawed-burrow-gradle-cache'),
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
  // Docker image to use for Claude Code runner containers
  // Defaults to local build, but can be set to GHCR image for production
  CLAUDE_RUNNER_IMAGE: z.string().default('claude-code-runner:latest'),
  // Path to the host's Podman socket for container-in-container support
  // This socket is mounted into runner containers so Claude Code can run podman/docker commands
  // Example: /run/user/1000/podman/podman.sock
  PODMAN_SOCKET_PATH: z.string().optional(),
  // Skip pulling runner images on container start
  // Useful for testing local image builds without pushing to registry
  SKIP_IMAGE_PULL: z
    .string()
    .optional()
    .transform((val) => val === 'true' || val === '1'),
  // Explicit Claude config JSON for MCP servers
  // If set, this JSON will be written to ~/.claude.json in runner containers
  // instead of copying the host's .claude.json (which may contain Claude.ai's
  // automatically configured MCP server proxies that aren't appropriate for
  // --dangerously-skip-permissions mode)
  // Example: {"mcpServers":{"memory":{"command":"npx","args":["@anthropic/mcp-server-memory"]}}}
  CLAUDE_CONFIG_JSON: z.string().optional(),
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
