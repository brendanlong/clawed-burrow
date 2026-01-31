import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('file:./data/dev.db'),
  GITHUB_TOKEN: z.string().optional(),
  // Claude Code OAuth token (run `claude setup-token` to generate)
  // Lasts for 1 year and is simpler than copying auth files
  CLAUDE_CODE_OAUTH_TOKEN: z.string(),
  // Claude model to use in runner containers (e.g., "opus", "sonnet", "claude-opus-4-5-20251101")
  // Passed as --model to the claude CLI
  CLAUDE_MODEL: z.string().default('opus'),
  // Named volume for pnpm store - shared across all runner containers
  // Speeds up package installs by caching downloaded packages
  PNPM_STORE_VOLUME: z.string().default('clawed-abode-pnpm-store'),
  // Named volume for Gradle cache - shared across all runner containers
  // Speeds up builds by caching downloaded dependencies and build outputs
  GRADLE_CACHE_VOLUME: z.string().default('clawed-abode-gradle-cache'),
  // Named volume for git reference cache - shared across all runner containers
  // Stores bare repos used as --reference during clones to speed up session creation
  GIT_CACHE_VOLUME: z.string().default('clawed-abode-git-cache'),
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
  // 32+ character key for encrypting secrets (env vars, MCP API keys)
  // Generate with: openssl rand -base64 32
  // Required for storing per-repo secrets
  ENCRYPTION_KEY: z.string().min(32).optional(),
  // Explicit Claude config JSON for MCP servers
  // If set, this JSON will be written to ~/.claude.json in runner containers
  // instead of copying the host's .claude.json (which may contain Claude.ai's
  // automatically configured MCP server proxies that aren't appropriate for
  // --dangerously-skip-permissions mode)
  // Example: {"mcpServers":{"memory":{"command":"npx","args":["@anthropic/mcp-server-memory"]}}}
  CLAUDE_CONFIG_JSON: z.string().optional(),
  // Network mode for Claude session containers
  // - "host": Share host's network namespace. Allows containers to connect to
  //   services started via podman-compose on localhost. Recommended when agents
  //   need to run and connect to containerized services.
  // - "bridge" (default): Standard container networking with NAT. More isolated
  //   but containers cannot easily connect to podman-compose services.
  // - "pasta": Rootless Podman's default. Similar limitations to bridge.
  // See: https://github.com/brendanlong/clawed-abode/issues/147
  CONTAINER_NETWORK_MODE: z.enum(['host', 'bridge', 'pasta']).default('host'),
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
      // Provide dummy value for required CLAUDE_CODE_OAUTH_TOKEN during build
      return envSchema.parse({ CLAUDE_CODE_OAUTH_TOKEN: 'build-time-placeholder' });
    }
    throw new Error('Invalid environment variables');
  }

  return parsed.data;
}

export const env = validateEnv();
