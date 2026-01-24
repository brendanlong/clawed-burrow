import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// Mock claude-runner service (has real Docker dependencies)
const mockRunClaudeCommand = vi.hoisted(() => vi.fn());
const mockInterruptClaude = vi.hoisted(() => vi.fn());
const mockIsClaudeRunningAsync = vi.hoisted(() => vi.fn());
const mockMarkLastMessageAsInterrupted = vi.hoisted(() => vi.fn());

vi.mock('../services/claude-runner', () => ({
  runClaudeCommand: mockRunClaudeCommand,
  interruptClaude: mockInterruptClaude,
  isClaudeRunningAsync: mockIsClaudeRunningAsync,
  markLastMessageAsInterrupted: mockMarkLastMessageAsInterrupted,
}));

// Use real token estimation (pure function)
// vi.mock('@/lib/token-estimation') - not mocked

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
let claudeRouter: Awaited<typeof import('./claude')>['claudeRouter'];
let router: Awaited<typeof import('../trpc')>['router'];

const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    claude: claudeRouter,
  });
  return testRouter.createCaller({ sessionId, rotatedToken: null });
};

describe('claudeRouter integration', () => {
  beforeAll(async () => {
    // Set up the test database BEFORE importing the router
    await setupTestDb();

    // Now dynamically import the router (which imports prisma)
    const claudeModule = await import('./claude');
    const trpcModule = await import('../trpc');
    claudeRouter = claudeModule.claudeRouter;
    router = trpcModule.router;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
  });

  describe('send', () => {
    it('should send a prompt to Claude for a running session', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Test Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
          containerId: 'container-123',
        },
      });

      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockRunClaudeCommand.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.send({
        sessionId: session.id,
        prompt: 'Hello, Claude!',
      });

      expect(result).toEqual({ success: true });
      expect(mockRunClaudeCommand).toHaveBeenCalledWith(
        session.id,
        'container-123',
        'Hello, Claude!'
      );
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    });

    it('should throw PRECONDITION_FAILED if session is not running', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Stopped Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'stopped',
        },
      });

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: session.id,
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Session is not running',
      });
    });

    it('should throw CONFLICT if Claude is already running', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Running Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
          containerId: 'container-123',
        },
      });

      mockIsClaudeRunningAsync.mockResolvedValue(true);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: session.id,
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Claude is already running for this session',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('should validate prompt is not empty', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: '',
        })
      ).rejects.toThrow();
    });
  });

  describe('interrupt', () => {
    it('should interrupt Claude successfully', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Running Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
          containerId: 'container-123',
        },
      });

      mockInterruptClaude.mockResolvedValue(true);
      mockMarkLastMessageAsInterrupted.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.interrupt({ sessionId: session.id });

      expect(result).toEqual({ success: true });
      expect(mockInterruptClaude).toHaveBeenCalledWith(session.id);
      expect(mockMarkLastMessageAsInterrupted).toHaveBeenCalledWith(session.id);
    });

    it('should return false if no process to interrupt', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Idle Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
          containerId: 'container-123',
        },
      });

      mockInterruptClaude.mockResolvedValue(false);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.interrupt({ sessionId: session.id });

      expect(result).toEqual({ success: false });
      expect(mockMarkLastMessageAsInterrupted).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.interrupt({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.interrupt({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getHistory', () => {
    it('should get message history from the database', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with history',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create messages in the database
      await testPrisma.message.createMany({
        data: [
          {
            sessionId: session.id,
            sequence: 0,
            type: 'user',
            content: '{"type":"user","content":"Hello"}',
          },
          {
            sessionId: session.id,
            sequence: 1,
            type: 'assistant',
            content: '{"type":"assistant","content":"Hi there!"}',
          },
          {
            sessionId: session.id,
            sequence: 2,
            type: 'user',
            content: '{"type":"user","content":"How are you?"}',
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getHistory({ sessionId: session.id });

      expect(result.messages).toHaveLength(3);
      expect(result.hasMore).toBe(false);

      // Messages should be in chronological order
      expect(result.messages[0].sequence).toBe(0);
      expect(result.messages[0].content).toEqual({ type: 'user', content: 'Hello' });
      expect(result.messages[1].sequence).toBe(1);
      expect(result.messages[2].sequence).toBe(2);
    });

    it('should support backward pagination', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with many messages',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create 60 messages
      const messages = Array.from({ length: 60 }, (_, i) => ({
        sessionId: session.id,
        sequence: i,
        type: i % 2 === 0 ? 'user' : 'assistant',
        content: JSON.stringify({ type: i % 2 === 0 ? 'user' : 'assistant', seq: i }),
      }));
      await testPrisma.message.createMany({ data: messages });

      const caller = createCaller('auth-session-id');

      // Get messages before sequence 50
      const result = await caller.claude.getHistory({
        sessionId: session.id,
        cursor: { sequence: 50, direction: 'backward' },
        limit: 20,
      });

      expect(result.messages).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      // Should be sequences 30-49 in chronological order
      expect(result.messages[0].sequence).toBe(30);
      expect(result.messages[19].sequence).toBe(49);
    });

    it('should support forward pagination', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with messages',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create 20 messages
      const messages = Array.from({ length: 20 }, (_, i) => ({
        sessionId: session.id,
        sequence: i,
        type: 'user',
        content: JSON.stringify({ type: 'user', seq: i }),
      }));
      await testPrisma.message.createMany({ data: messages });

      const caller = createCaller('auth-session-id');

      // Get messages after sequence 10
      const result = await caller.claude.getHistory({
        sessionId: session.id,
        cursor: { sequence: 10, direction: 'forward' },
        limit: 50,
      });

      expect(result.messages).toHaveLength(9); // sequences 11-19
      expect(result.hasMore).toBe(false);
      expect(result.messages[0].sequence).toBe(11);
      expect(result.messages[8].sequence).toBe(19);
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.getHistory({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.getHistory({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('isRunning', () => {
    it('should return running status', async () => {
      mockIsClaudeRunningAsync.mockResolvedValue(true);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.isRunning({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ running: true });
    });

    it('should return not running status', async () => {
      mockIsClaudeRunningAsync.mockResolvedValue(false);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.isRunning({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ running: false });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.isRunning({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getTokenUsage', () => {
    it('should calculate token usage from messages in the database', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with usage',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create a result message with usage data
      await testPrisma.message.create({
        data: {
          sessionId: session.id,
          sequence: 0,
          type: 'result',
          content: JSON.stringify({
            type: 'result',
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 50,
            },
          }),
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getTokenUsage({ sessionId: session.id });

      // Uses real token estimation
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.cacheReadTokens).toBe(100);
      expect(result.cacheCreationTokens).toBe(50);
      expect(result.totalTokens).toBe(1500);
    });

    it('should aggregate usage from multiple result messages', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with multiple turns',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create multiple result messages (each turn)
      await testPrisma.message.createMany({
        data: [
          {
            sessionId: session.id,
            sequence: 0,
            type: 'result',
            content: JSON.stringify({
              type: 'result',
              usage: { input_tokens: 1000, output_tokens: 500 },
            }),
          },
          {
            sessionId: session.id,
            sequence: 1,
            type: 'result',
            content: JSON.stringify({
              type: 'result',
              usage: { input_tokens: 2000, output_tokens: 800 },
            }),
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getTokenUsage({ sessionId: session.id });

      expect(result.inputTokens).toBe(3000);
      expect(result.outputTokens).toBe(1300);
      expect(result.totalTokens).toBe(4300);
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.getTokenUsage({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.getTokenUsage({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
