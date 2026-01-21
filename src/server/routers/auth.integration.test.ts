import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  setupTestDatabase,
  teardownTestDatabase,
  getTestPrisma,
  clearTestDatabase,
} from '@/test/setup-prisma';
import { hashPassword } from '@/lib/auth';

// We need to mock the prisma import used by the router to use our test instance
// But we'll use real auth functions (verifyPassword, generateSessionToken)
const mockPrisma = {
  authSession: {
    create: null as unknown,
    delete: null as unknown,
    deleteMany: null as unknown,
    findMany: null as unknown,
    findUnique: null as unknown,
  },
};

// This will be set up after database initialization
let realPrisma: ReturnType<typeof getTestPrisma>;

vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return realPrisma || mockPrisma;
  },
}));

// Mock env - we'll set the real hash in beforeAll
const mockEnv = vi.hoisted(() => ({
  PASSWORD_HASH: undefined as string | undefined,
}));

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

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

import { authRouter } from './auth';
import { router } from '../trpc';

const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    auth: authRouter,
  });
  return testRouter.createCaller({ sessionId });
};

const TEST_PASSWORD = 'test-password-123';

describe('authRouter integration', () => {
  beforeAll(async () => {
    realPrisma = await setupTestDatabase();

    // Create a real password hash for testing
    const hash = await hashPassword(TEST_PASSWORD);
    mockEnv.PASSWORD_HASH = hash;
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearTestDatabase();
  });

  describe('login', () => {
    it('should login successfully with correct password and create a session in the database', async () => {
      const caller = createCaller(null);
      const result = await caller.auth.login({
        password: TEST_PASSWORD,
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      // Should return a token
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(32);

      // Verify session was created in the database
      const sessions = await realPrisma.authSession.findMany();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].token).toBe(result.token);
      expect(sessions[0].ipAddress).toBe('127.0.0.1');
      expect(sessions[0].userAgent).toBe('test-agent');
      expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject invalid password', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.login({ password: 'wrong-password' })).rejects.toThrow(TRPCError);

      await expect(caller.auth.login({ password: 'wrong-password' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid password',
      });

      // Verify no session was created
      const sessions = await realPrisma.authSession.findMany();
      expect(sessions).toHaveLength(0);
    });

    it('should throw error if PASSWORD_HASH is not configured', async () => {
      const originalHash = mockEnv.PASSWORD_HASH;
      mockEnv.PASSWORD_HASH = undefined;

      const caller = createCaller(null);

      await expect(caller.auth.login({ password: 'any-password' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Authentication not configured. Set PASSWORD_HASH environment variable.',
      });

      mockEnv.PASSWORD_HASH = originalHash;
    });

    it('should create multiple sessions for multiple logins', async () => {
      const caller = createCaller(null);

      const result1 = await caller.auth.login({ password: TEST_PASSWORD });
      const result2 = await caller.auth.login({ password: TEST_PASSWORD });
      const result3 = await caller.auth.login({ password: TEST_PASSWORD });

      // All tokens should be different
      expect(result1.token).not.toBe(result2.token);
      expect(result2.token).not.toBe(result3.token);

      // Should have 3 sessions in database
      const sessions = await realPrisma.authSession.findMany();
      expect(sessions).toHaveLength(3);
    });
  });

  describe('logout', () => {
    it('should delete the current session from the database', async () => {
      // First login to create a session
      const loginCaller = createCaller(null);
      const loginResult = await loginCaller.auth.login({ password: TEST_PASSWORD });

      // Get the session ID from the database
      const session = await realPrisma.authSession.findFirst({
        where: { token: loginResult.token },
      });
      expect(session).toBeDefined();

      // Now logout using that session
      const logoutCaller = createCaller(session!.id);
      const result = await logoutCaller.auth.logout();

      expect(result).toEqual({ success: true });

      // Verify session was deleted
      const remainingSessions = await realPrisma.authSession.findMany();
      expect(remainingSessions).toHaveLength(0);
    });

    it('should only delete the current session, not others', async () => {
      const loginCaller = createCaller(null);

      // Create 3 sessions
      await loginCaller.auth.login({ password: TEST_PASSWORD });
      const session2 = await loginCaller.auth.login({ password: TEST_PASSWORD });
      await loginCaller.auth.login({ password: TEST_PASSWORD });

      const sessionToLogout = await realPrisma.authSession.findFirst({
        where: { token: session2.token },
      });

      // Logout the middle session
      const logoutCaller = createCaller(sessionToLogout!.id);
      await logoutCaller.auth.logout();

      // Should have 2 sessions remaining
      const remaining = await realPrisma.authSession.findMany();
      expect(remaining).toHaveLength(2);
      expect(remaining.find((s) => s.id === sessionToLogout!.id)).toBeUndefined();
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.logout()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('logoutAll', () => {
    it('should delete all sessions from the database', async () => {
      const loginCaller = createCaller(null);

      // Create multiple sessions
      const session1 = await loginCaller.auth.login({ password: TEST_PASSWORD });
      await loginCaller.auth.login({ password: TEST_PASSWORD });
      await loginCaller.auth.login({ password: TEST_PASSWORD });

      const currentSession = await realPrisma.authSession.findFirst({
        where: { token: session1.token },
      });

      // Logout all
      const caller = createCaller(currentSession!.id);
      const result = await caller.auth.logoutAll();

      expect(result).toEqual({ success: true });

      // All sessions should be deleted
      const remaining = await realPrisma.authSession.findMany();
      expect(remaining).toHaveLength(0);
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.logoutAll()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('listSessions', () => {
    it('should list all sessions with isCurrent flag', async () => {
      const loginCaller = createCaller(null);

      // Create sessions with different metadata
      const session1 = await loginCaller.auth.login({
        password: TEST_PASSWORD,
        ipAddress: '192.168.1.1',
        userAgent: 'Chrome',
      });
      await loginCaller.auth.login({
        password: TEST_PASSWORD,
        ipAddress: '192.168.1.2',
        userAgent: 'Firefox',
      });
      await loginCaller.auth.login({
        password: TEST_PASSWORD,
        ipAddress: '192.168.1.3',
        userAgent: 'Safari',
      });

      const currentSession = await realPrisma.authSession.findFirst({
        where: { token: session1.token },
      });

      const caller = createCaller(currentSession!.id);
      const result = await caller.auth.listSessions();

      expect(result.sessions).toHaveLength(3);

      // Find the current session in the results
      const current = result.sessions.find((s) => s.id === currentSession!.id);
      expect(current).toBeDefined();
      expect(current!.isCurrent).toBe(true);
      expect(current!.ipAddress).toBe('192.168.1.1');
      expect(current!.userAgent).toBe('Chrome');

      // Other sessions should not be current
      const others = result.sessions.filter((s) => s.id !== currentSession!.id);
      expect(others.every((s) => s.isCurrent === false)).toBe(true);
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.listSessions()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('deleteSession', () => {
    it('should delete another session', async () => {
      const loginCaller = createCaller(null);

      const session1 = await loginCaller.auth.login({ password: TEST_PASSWORD });
      const session2 = await loginCaller.auth.login({ password: TEST_PASSWORD });

      const currentSession = await realPrisma.authSession.findFirst({
        where: { token: session1.token },
      });
      const otherSession = await realPrisma.authSession.findFirst({
        where: { token: session2.token },
      });

      const caller = createCaller(currentSession!.id);
      const result = await caller.auth.deleteSession({
        sessionId: otherSession!.id,
      });

      expect(result).toEqual({ success: true });

      // Other session should be deleted
      const remaining = await realPrisma.authSession.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(currentSession!.id);
    });

    it('should prevent deleting current session', async () => {
      const loginCaller = createCaller(null);
      const loginResult = await loginCaller.auth.login({ password: TEST_PASSWORD });

      const currentSession = await realPrisma.authSession.findFirst({
        where: { token: loginResult.token },
      });

      const caller = createCaller(currentSession!.id);

      await expect(
        caller.auth.deleteSession({ sessionId: currentSession!.id })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Use logout to delete your current session',
      });

      // Session should still exist
      const remaining = await realPrisma.authSession.findMany();
      expect(remaining).toHaveLength(1);
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.deleteSession({ sessionId: 'some-id' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
