import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/crypto';
import { TRPCError } from '@trpc/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('repoSettings');

// Validation schemas
const repoFullNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, {
  message: 'Invalid repository name format. Expected "owner/repo"',
});

const envVarNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message:
      'Environment variable name must start with a letter or underscore and contain only alphanumeric characters and underscores',
  });

const envVarSchema = z.object({
  name: envVarNameSchema,
  value: z.string().max(10000),
  isSecret: z.boolean().default(false),
});

const mcpServerEnvValueSchema = z.object({
  value: z.string(),
  isSecret: z.boolean().default(false),
});

type McpServerEnvValue = z.infer<typeof mcpServerEnvValueSchema>;

const mcpServerEnvSchema = z.record(z.string(), mcpServerEnvValueSchema);

const mcpServerSchema = z.object({
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(1000),
  args: z.array(z.string()).optional(),
  env: mcpServerEnvSchema.optional(),
});

/**
 * Mask secret values for display
 */
function maskSecrets<T extends { value: string; isSecret: boolean }>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    value: item.isSecret ? '••••••••' : item.value,
  }));
}

/**
 * Mask MCP server env secrets for display
 */
function maskMcpEnv(env: Record<string, McpServerEnvValue>): Record<string, McpServerEnvValue> {
  return Object.fromEntries(
    Object.entries(env).map(([key, { value, isSecret }]) => [
      key,
      { value: isSecret ? '••••••••' : value, isSecret },
    ])
  );
}

/**
 * Encrypt MCP server env secrets
 */
function encryptMcpEnv(env: Record<string, McpServerEnvValue>): Record<string, McpServerEnvValue> {
  return Object.fromEntries(
    Object.entries(env).map(([key, { value, isSecret }]) => [
      key,
      { value: isSecret ? encrypt(value) : value, isSecret },
    ])
  );
}

export const repoSettingsRouter = router({
  /**
   * Get settings for a specific repository
   * Returns null if no settings exist
   */
  get: protectedProcedure
    .input(z.object({ repoFullName: repoFullNameSchema }))
    .query(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
        include: { envVars: true, mcpServers: true },
      });

      if (!settings) {
        return null;
      }

      // Mask secret values for display
      return {
        id: settings.id,
        repoFullName: settings.repoFullName,
        isFavorite: settings.isFavorite,
        displayOrder: settings.displayOrder,
        createdAt: settings.createdAt,
        updatedAt: settings.updatedAt,
        envVars: maskSecrets(
          settings.envVars.map((ev) => ({
            id: ev.id,
            name: ev.name,
            value: ev.value,
            isSecret: ev.isSecret,
          }))
        ),
        mcpServers: settings.mcpServers.map((mcp) => ({
          id: mcp.id,
          name: mcp.name,
          command: mcp.command,
          args: mcp.args ? (JSON.parse(mcp.args) as string[]) : [],
          env: mcp.env ? maskMcpEnv(JSON.parse(mcp.env) as Record<string, McpServerEnvValue>) : {},
        })),
      };
    }),

  /**
   * Toggle favorite status for a repository
   */
  toggleFavorite: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        isFavorite: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: {
          repoFullName: input.repoFullName,
          isFavorite: input.isFavorite,
        },
        update: { isFavorite: input.isFavorite },
      });

      log.info('Toggled favorite', {
        repoFullName: input.repoFullName,
        isFavorite: input.isFavorite,
      });

      return { isFavorite: settings.isFavorite };
    }),

  /**
   * List all favorite repository names
   */
  listFavorites: protectedProcedure.query(async () => {
    const favorites = await prisma.repoSettings.findMany({
      where: { isFavorite: true },
      select: { repoFullName: true },
      orderBy: [{ displayOrder: 'asc' }, { repoFullName: 'asc' }],
    });

    return { favorites: favorites.map((f) => f.repoFullName) };
  }),

  /**
   * List all repositories with settings (for settings page)
   */
  listWithSettings: protectedProcedure.query(async () => {
    const settings = await prisma.repoSettings.findMany({
      include: {
        envVars: { select: { id: true, name: true, isSecret: true } },
        mcpServers: { select: { id: true, name: true } },
      },
      orderBy: [{ isFavorite: 'desc' }, { updatedAt: 'desc' }],
    });

    return {
      settings: settings.map((s) => ({
        id: s.id,
        repoFullName: s.repoFullName,
        isFavorite: s.isFavorite,
        envVarCount: s.envVars.length,
        mcpServerCount: s.mcpServers.length,
        envVars: s.envVars,
        mcpServers: s.mcpServers,
        updatedAt: s.updatedAt,
      })),
    };
  }),

  /**
   * Set (create or update) an environment variable
   */
  setEnvVar: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        envVar: envVarSchema,
      })
    )
    .mutation(async ({ input }) => {
      if (input.envVar.isSecret && !isEncryptionConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'ENCRYPTION_KEY must be configured to store secrets. See .env.example for instructions.',
        });
      }

      // Ensure RepoSettings exists
      const settings = await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: { repoFullName: input.repoFullName },
        update: {},
      });

      const value = input.envVar.isSecret ? encrypt(input.envVar.value) : input.envVar.value;

      await prisma.envVar.upsert({
        where: {
          repoSettingsId_name: {
            repoSettingsId: settings.id,
            name: input.envVar.name,
          },
        },
        create: {
          repoSettingsId: settings.id,
          name: input.envVar.name,
          value,
          isSecret: input.envVar.isSecret,
        },
        update: {
          value,
          isSecret: input.envVar.isSecret,
        },
      });

      log.info('Set env var', {
        repoFullName: input.repoFullName,
        name: input.envVar.name,
        isSecret: input.envVar.isSecret,
      });

      return { success: true };
    }),

  /**
   * Delete an environment variable
   */
  deleteEnvVar: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        name: envVarNameSchema,
      })
    )
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
      });

      if (settings) {
        await prisma.envVar.deleteMany({
          where: {
            repoSettingsId: settings.id,
            name: input.name,
          },
        });

        log.info('Deleted env var', { repoFullName: input.repoFullName, name: input.name });
      }

      return { success: true };
    }),

  /**
   * Set (create or update) an MCP server configuration
   */
  setMcpServer: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        mcpServer: mcpServerSchema,
      })
    )
    .mutation(async ({ input }) => {
      // Check if any env vars are secrets
      const env = input.mcpServer.env ?? {};
      const hasSecrets = Object.values(env).some((e) => e.isSecret);
      if (hasSecrets && !isEncryptionConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'ENCRYPTION_KEY must be configured to store secrets. See .env.example for instructions.',
        });
      }

      // Ensure RepoSettings exists
      const settings = await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: { repoFullName: input.repoFullName },
        update: {},
      });

      // Encrypt secret env values
      const processedEnv = Object.keys(env).length > 0 ? encryptMcpEnv(env) : null;

      await prisma.mcpServer.upsert({
        where: {
          repoSettingsId_name: {
            repoSettingsId: settings.id,
            name: input.mcpServer.name,
          },
        },
        create: {
          repoSettingsId: settings.id,
          name: input.mcpServer.name,
          command: input.mcpServer.command,
          args: input.mcpServer.args ? JSON.stringify(input.mcpServer.args) : null,
          env: processedEnv ? JSON.stringify(processedEnv) : null,
        },
        update: {
          command: input.mcpServer.command,
          args: input.mcpServer.args ? JSON.stringify(input.mcpServer.args) : null,
          env: processedEnv ? JSON.stringify(processedEnv) : null,
        },
      });

      log.info('Set MCP server', { repoFullName: input.repoFullName, name: input.mcpServer.name });

      return { success: true };
    }),

  /**
   * Delete an MCP server configuration
   */
  deleteMcpServer: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        name: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
      });

      if (settings) {
        await prisma.mcpServer.deleteMany({
          where: {
            repoSettingsId: settings.id,
            name: input.name,
          },
        });

        log.info('Deleted MCP server', { repoFullName: input.repoFullName, name: input.name });
      }

      return { success: true };
    }),

  /**
   * Delete all settings for a repository
   */
  delete: protectedProcedure
    .input(z.object({ repoFullName: repoFullNameSchema }))
    .mutation(async ({ input }) => {
      await prisma.repoSettings.deleteMany({
        where: { repoFullName: input.repoFullName },
      });

      log.info('Deleted repo settings', { repoFullName: input.repoFullName });

      return { success: true };
    }),

  /**
   * Get decrypted settings for container creation (internal use)
   * This is exported separately for use by the container creation service
   */
  getForContainer: protectedProcedure
    .input(z.object({ repoFullName: repoFullNameSchema }))
    .query(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
        include: { envVars: true, mcpServers: true },
      });

      if (!settings) {
        return null;
      }

      return {
        envVars: settings.envVars.map((ev) => ({
          name: ev.name,
          value: ev.isSecret ? decrypt(ev.value) : ev.value,
          isSecret: ev.isSecret,
        })),
        mcpServers: settings.mcpServers.map((mcp) => {
          const env = mcp.env ? (JSON.parse(mcp.env) as Record<string, McpServerEnvValue>) : {};
          return {
            name: mcp.name,
            command: mcp.command,
            args: mcp.args ? (JSON.parse(mcp.args) as string[]) : undefined,
            env: Object.fromEntries(
              Object.entries(env).map(([key, { value, isSecret }]) => [
                key,
                isSecret ? decrypt(value) : value,
              ])
            ),
          };
        }),
      };
    }),
});
