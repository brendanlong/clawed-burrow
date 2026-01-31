import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// Set up encryption key for testing
process.env.ENCRYPTION_KEY = 'test-encryption-key-that-is-at-least-32-chars-long';

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// These will be set in beforeAll after the test DB is set up
let repoSettingsRouter: Awaited<typeof import('./repoSettings')>['repoSettingsRouter'];
let router: Awaited<typeof import('../trpc')>['router'];

const createCaller = () => {
  const testRouter = router({
    repoSettings: repoSettingsRouter,
  });
  // Use a fake session ID to pass the auth check
  return testRouter.createCaller({ sessionId: 'test-session', rotatedToken: null });
};

describe('repoSettings router', () => {
  const testRepoName = 'test-owner/test-repo';

  beforeAll(async () => {
    await setupTestDb();

    // Dynamically import after DB setup
    const repoSettingsModule = await import('./repoSettings');
    const trpcModule = await import('../trpc');
    repoSettingsRouter = repoSettingsModule.repoSettingsRouter;
    router = trpcModule.router;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  describe('toggleFavorite', () => {
    it('should create settings and set favorite to true', async () => {
      const caller = createCaller();
      const result = await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      expect(result.isFavorite).toBe(true);

      const settings = await testPrisma.repoSettings.findUnique({
        where: { repoFullName: testRepoName },
      });
      expect(settings?.isFavorite).toBe(true);
    });

    it('should toggle favorite off', async () => {
      const caller = createCaller();

      // First set to true
      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      // Then toggle off
      const result = await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: false,
      });

      expect(result.isFavorite).toBe(false);
    });
  });

  describe('listFavorites', () => {
    it('should return empty list when no favorites', async () => {
      const caller = createCaller();
      const result = await caller.repoSettings.listFavorites();
      expect(result.favorites).toEqual([]);
    });

    it('should return favorite repos', async () => {
      const caller = createCaller();

      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      const result = await caller.repoSettings.listFavorites();
      expect(result.favorites).toContain(testRepoName);
    });
  });

  describe('setEnvVar', () => {
    it('should create a non-secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'MY_VAR',
          value: 'my-value',
          isSecret: false,
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars).toHaveLength(1);
      expect(settings?.envVars[0].name).toBe('MY_VAR');
      expect(settings?.envVars[0].value).toBe('my-value');
      expect(settings?.envVars[0].isSecret).toBe(false);
    });

    it('should create an encrypted secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'SECRET_VAR',
          value: 'secret-value',
          isSecret: true,
        },
      });

      // Check that the value is masked in the response
      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars[0].name).toBe('SECRET_VAR');
      expect(settings?.envVars[0].value).toBe('••••••••');
      expect(settings?.envVars[0].isSecret).toBe(true);

      // Check that the raw value is encrypted in the database
      const dbSettings = await testPrisma.repoSettings.findUnique({
        where: { repoFullName: testRepoName },
        include: { envVars: true },
      });
      expect(dbSettings?.envVars[0].value).not.toBe('secret-value');
      expect(dbSettings?.envVars[0].value).toContain(':'); // Encrypted format includes colons
    });

    it('should update an existing env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'MY_VAR',
          value: 'initial-value',
          isSecret: false,
        },
      });

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'MY_VAR',
          value: 'updated-value',
          isSecret: false,
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars).toHaveLength(1);
      expect(settings?.envVars[0].value).toBe('updated-value');
    });
  });

  describe('deleteEnvVar', () => {
    it('should delete an env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'TO_DELETE',
          value: 'value',
          isSecret: false,
        },
      });

      await caller.repoSettings.deleteEnvVar({
        repoFullName: testRepoName,
        name: 'TO_DELETE',
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars).toHaveLength(0);
    });
  });

  describe('setMcpServer', () => {
    it('should create an MCP server config', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'memory',
          command: 'npx',
          args: ['@anthropic/mcp-server-memory'],
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers).toHaveLength(1);
      expect(settings?.mcpServers[0].name).toBe('memory');
      expect(settings?.mcpServers[0].command).toBe('npx');
      expect(settings?.mcpServers[0].args).toEqual(['@anthropic/mcp-server-memory']);
    });

    it('should create an MCP server with secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'api-server',
          command: 'node',
          args: ['server.js'],
          env: {
            API_KEY: { value: 'secret-api-key', isSecret: true },
            DEBUG: { value: 'true', isSecret: false },
          },
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers[0].env.API_KEY.value).toBe('••••••••');
      expect(settings?.mcpServers[0].env.API_KEY.isSecret).toBe(true);
      expect(settings?.mcpServers[0].env.DEBUG.value).toBe('true');
      expect(settings?.mcpServers[0].env.DEBUG.isSecret).toBe(false);
    });
  });

  describe('deleteMcpServer', () => {
    it('should delete an MCP server config', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'to-delete',
          command: 'node',
        },
      });

      await caller.repoSettings.deleteMcpServer({
        repoFullName: testRepoName,
        name: 'to-delete',
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers).toHaveLength(0);
    });
  });

  describe('getForContainer', () => {
    it('should return decrypted env vars', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'SECRET',
          value: 'my-secret-value',
          isSecret: true,
        },
      });

      const result = await caller.repoSettings.getForContainer({ repoFullName: testRepoName });
      expect(result?.envVars[0].name).toBe('SECRET');
      expect(result?.envVars[0].value).toBe('my-secret-value'); // Decrypted!
    });

    it('should return decrypted MCP server env vars', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'test-server',
          command: 'node',
          env: {
            API_KEY: { value: 'secret-key', isSecret: true },
          },
        },
      });

      const result = await caller.repoSettings.getForContainer({ repoFullName: testRepoName });
      expect(result?.mcpServers[0].env?.API_KEY).toBe('secret-key'); // Decrypted!
    });
  });

  describe('delete', () => {
    it('should delete all settings for a repo', async () => {
      const caller = createCaller();

      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'VAR',
          value: 'value',
          isSecret: false,
        },
      });

      await caller.repoSettings.delete({ repoFullName: testRepoName });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings).toBeNull();
    });
  });

  describe('listWithSettings', () => {
    it('should list repos with settings summary', async () => {
      const caller = createCaller();

      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'VAR1',
          value: 'value',
          isSecret: false,
        },
      });

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'server1',
          command: 'node',
        },
      });

      const result = await caller.repoSettings.listWithSettings();
      const found = result.settings.find((s) => s.repoFullName === testRepoName);
      expect(found).toBeDefined();
      expect(found?.isFavorite).toBe(true);
      expect(found?.envVarCount).toBe(1);
      expect(found?.mcpServerCount).toBe(1);
    });
  });
});
