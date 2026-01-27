import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { hashPassword } from '@/lib/auth';

// Mock env - we'll set the real hash in beforeAll
const mockEnv = vi.hoisted(() => ({
  PASSWORD_HASH: undefined as string | undefined,
}));

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

// Mock logger (just to reduce noise)
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
let authRouter: Awaited<typeof import('./auth')>['authRouter'];
let router: Awaited<typeof import('../trpc')>['router'];

const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    auth: authRouter,
  });
  return testRouter.createCaller({ sessionId, rotatedToken: null });
};

const TEST_PASSWORD = 'test-password-123';

describe('authRouter integration', () => {
  beforeAll(async () => {
    // Set up the test database BEFORE importing the router
    // This ensures @/lib/prisma connects to our test DB
    await setupTestDb();

    // Now dynamically import the router (which imports prisma)
    const authModule = await import('./auth');
    const trpcModule = await import('../trpc');
    authRouter = authModule.authRouter;
    router = trpcModule.router;

    // Create a real password hash for testing
    const hash = await hashPassword(TEST_PASSWORD);
    mockEnv.PASSWORD_HASH = hash;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  describe('login', () => {
    it('should login successfully with correct password and create a session in the database', async () => {
      const caller = createCaller(null);
      const beforeLogin = Date.now();
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
      const sessions = await testPrisma.authSession.findMany();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].token).toBe(result.token);
      expect(sessions[0].ipAddress).toBe('127.0.0.1');
      expect(sessions[0].userAgent).toBe('test-agent');
      expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
      // Verify lastActivityAt is set to now
      expect(sessions[0].lastActivityAt.getTime()).toBeGreaterThanOrEqual(beforeLogin);
      expect(sessions[0].lastActivityAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should reject invalid password', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.login({ password: 'wrong-password' })).rejects.toThrow(TRPCError);

      await expect(caller.auth.login({ password: 'wrong-password' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid password',
      });

      // Verify no session was created
      const sessions = await testPrisma.authSession.findMany();
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
      const sessions = await testPrisma.authSession.findMany();
      expect(sessions).toHaveLength(3);
    });
  });

  describe('logout', () => {
    it('should mark the current session as revoked', async () => {
      // First login to create a session
      const loginCaller = createCaller(null);
      const loginResult = await loginCaller.auth.login({ password: TEST_PASSWORD });

      // Get the session ID from the database
      const session = await testPrisma.authSession.findFirst({
        where: { token: loginResult.token },
      });
      expect(session).toBeDefined();
      expect(session!.revokedAt).toBeNull();

      // Now logout using that session
      const logoutCaller = createCaller(session!.id);
      const beforeLogout = Date.now();
      const result = await logoutCaller.auth.logout();

      expect(result).toEqual({ success: true });

      // Verify session was marked as revoked (not deleted)
      const revokedSession = await testPrisma.authSession.findFirst({
        where: { id: session!.id },
      });
      expect(revokedSession).toBeDefined();
      expect(revokedSession!.revokedAt).toBeDefined();
      expect(revokedSession!.revokedAt!.getTime()).toBeGreaterThanOrEqual(beforeLogout);
      expect(revokedSession!.revokedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should only revoke the current session, not others', async () => {
      const loginCaller = createCaller(null);

      // Create 3 sessions
      await loginCaller.auth.login({ password: TEST_PASSWORD });
      const session2 = await loginCaller.auth.login({ password: TEST_PASSWORD });
      await loginCaller.auth.login({ password: TEST_PASSWORD });

      const sessionToLogout = await testPrisma.authSession.findFirst({
        where: { token: session2.token },
      });

      // Logout the middle session
      const logoutCaller = createCaller(sessionToLogout!.id);
      await logoutCaller.auth.logout();

      // Should still have 3 sessions in database
      const remaining = await testPrisma.authSession.findMany();
      expect(remaining).toHaveLength(3);

      // Only the logged out session should be revoked
      const revokedSession = remaining.find((s) => s.id === sessionToLogout!.id);
      expect(revokedSession!.revokedAt).toBeDefined();

      // Other sessions should not be revoked
      const otherSessions = remaining.filter((s) => s.id !== sessionToLogout!.id);
      expect(otherSessions.every((s) => s.revokedAt === null)).toBe(true);
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.logout()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('logoutAll', () => {
    it('should mark all sessions as revoked', async () => {
      const loginCaller = createCaller(null);

      // Create multiple sessions
      const session1 = await loginCaller.auth.login({ password: TEST_PASSWORD });
      await loginCaller.auth.login({ password: TEST_PASSWORD });
      await loginCaller.auth.login({ password: TEST_PASSWORD });

      const currentSession = await testPrisma.authSession.findFirst({
        where: { token: session1.token },
      });

      // Logout all
      const caller = createCaller(currentSession!.id);
      const beforeLogout = Date.now();
      const result = await caller.auth.logoutAll();

      expect(result).toEqual({ success: true });

      // All sessions should still exist but be revoked
      const remaining = await testPrisma.authSession.findMany();
      expect(remaining).toHaveLength(3);
      expect(remaining.every((s) => s.revokedAt !== null)).toBe(true);
      expect(
        remaining.every(
          (s) => s.revokedAt!.getTime() >= beforeLogout && s.revokedAt!.getTime() <= Date.now()
        )
      ).toBe(true);
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.logoutAll()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('listSessions', () => {
    it('should list all sessions including revoked ones with isCurrent flag and lastActivityAt', async () => {
      const loginCaller = createCaller(null);
      const beforeLogin = Date.now();

      // Create sessions with different metadata
      const session1 = await loginCaller.auth.login({
        password: TEST_PASSWORD,
        ipAddress: '192.168.1.1',
        userAgent: 'Chrome',
      });
      const session2 = await loginCaller.auth.login({
        password: TEST_PASSWORD,
        ipAddress: '192.168.1.2',
        userAgent: 'Firefox',
      });
      await loginCaller.auth.login({
        password: TEST_PASSWORD,
        ipAddress: '192.168.1.3',
        userAgent: 'Safari',
      });

      // Revoke one session
      const sessionToRevoke = await testPrisma.authSession.findFirst({
        where: { token: session2.token },
      });
      await testPrisma.authSession.update({
        where: { id: sessionToRevoke!.id },
        data: { revokedAt: new Date() },
      });

      const currentSession = await testPrisma.authSession.findFirst({
        where: { token: session1.token },
      });

      const caller = createCaller(currentSession!.id);
      const result = await caller.auth.listSessions();

      // Should list all 3 sessions including the revoked one
      expect(result.sessions).toHaveLength(3);

      // Find the current session in the results
      const current = result.sessions.find((s) => s.id === currentSession!.id);
      expect(current).toBeDefined();
      expect(current!.isCurrent).toBe(true);
      expect(current!.ipAddress).toBe('192.168.1.1');
      expect(current!.userAgent).toBe('Chrome');
      expect(current!.revokedAt).toBeNull();
      // Verify lastActivityAt is included
      expect(current!.lastActivityAt).toBeDefined();
      expect(current!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(beforeLogin);

      // Find the revoked session
      const revoked = result.sessions.find((s) => s.id === sessionToRevoke!.id);
      expect(revoked).toBeDefined();
      expect(revoked!.revokedAt).toBeDefined();

      // Other sessions should not be current
      const others = result.sessions.filter((s) => s.id !== currentSession!.id);
      expect(others.every((s) => s.isCurrent === false)).toBe(true);
      // All sessions should have lastActivityAt
      expect(result.sessions.every((s) => s.lastActivityAt !== undefined)).toBe(true);
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.listSessions()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('deleteSession', () => {
    it('should mark another session as revoked', async () => {
      const loginCaller = createCaller(null);

      const session1 = await loginCaller.auth.login({ password: TEST_PASSWORD });
      const session2 = await loginCaller.auth.login({ password: TEST_PASSWORD });

      const currentSession = await testPrisma.authSession.findFirst({
        where: { token: session1.token },
      });
      const otherSession = await testPrisma.authSession.findFirst({
        where: { token: session2.token },
      });

      const caller = createCaller(currentSession!.id);
      const beforeRevoke = Date.now();
      const result = await caller.auth.deleteSession({
        sessionId: otherSession!.id,
      });

      expect(result).toEqual({ success: true });

      // Both sessions should still exist in database
      const remaining = await testPrisma.authSession.findMany();
      expect(remaining).toHaveLength(2);

      // Other session should be revoked
      const revokedSession = remaining.find((s) => s.id === otherSession!.id);
      expect(revokedSession).toBeDefined();
      expect(revokedSession!.revokedAt).toBeDefined();
      expect(revokedSession!.revokedAt!.getTime()).toBeGreaterThanOrEqual(beforeRevoke);

      // Current session should not be revoked
      const currentStillActive = remaining.find((s) => s.id === currentSession!.id);
      expect(currentStillActive!.revokedAt).toBeNull();
    });

    it('should prevent revoking current session', async () => {
      const loginCaller = createCaller(null);
      const loginResult = await loginCaller.auth.login({ password: TEST_PASSWORD });

      const currentSession = await testPrisma.authSession.findFirst({
        where: { token: loginResult.token },
      });

      const caller = createCaller(currentSession!.id);

      await expect(
        caller.auth.deleteSession({ sessionId: currentSession!.id })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Use logout to revoke your current session',
      });

      // Session should still exist and not be revoked
      const session = await testPrisma.authSession.findFirst({
        where: { id: currentSession!.id },
      });
      expect(session).toBeDefined();
      expect(session!.revokedAt).toBeNull();
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.deleteSession({ sessionId: 'some-id' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
