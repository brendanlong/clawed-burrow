import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import {
  IDLE_TIMEOUT_MS,
  TOKEN_ROTATION_INTERVAL_MS,
  ACTIVITY_UPDATE_THROTTLE_MS,
  generateSessionToken,
} from '@/lib/auth';

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

// Will be set in beforeAll after test DB is set up
let createContext: Awaited<typeof import('./trpc')>['createContext'];

describe('createContext - activity tracking and token rotation', () => {
  beforeAll(async () => {
    await setupTestDb();

    // Now dynamically import the trpc module
    const trpcModule = await import('./trpc');
    createContext = trpcModule.createContext;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  function createHeaders(token: string | null): Headers {
    const headers = new Headers();
    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    }
    return headers;
  }

  async function createTestSession(
    overrides: {
      lastActivityAt?: Date;
      expiresAt?: Date;
    } = {}
  ) {
    const token = generateSessionToken();
    const now = new Date();
    const session = await testPrisma.authSession.create({
      data: {
        token,
        expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), // 7 days
        lastActivityAt: overrides.lastActivityAt ?? now,
      },
    });
    return { session, token };
  }

  describe('session validation', () => {
    it('should return null sessionId for missing token', async () => {
      const ctx = await createContext({ headers: createHeaders(null) });
      expect(ctx.sessionId).toBeNull();
      expect(ctx.rotatedToken).toBeNull();
    });

    it('should return null sessionId for invalid token', async () => {
      const ctx = await createContext({ headers: createHeaders('invalid-token') });
      expect(ctx.sessionId).toBeNull();
      expect(ctx.rotatedToken).toBeNull();
    });

    it('should return sessionId for valid token', async () => {
      const { session, token } = await createTestSession();

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBe(session.id);
    });
  });

  describe('expiration', () => {
    it('should reject and delete expired sessions', async () => {
      const expiredDate = new Date(Date.now() - 1000); // 1 second ago
      const { session, token } = await createTestSession({ expiresAt: expiredDate });

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBeNull();

      // Session should be deleted
      const remaining = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(remaining).toBeNull();
    });
  });

  describe('idle timeout', () => {
    it('should accept sessions within idle timeout', async () => {
      const lastActivity = new Date(Date.now() - IDLE_TIMEOUT_MS / 2); // Half of idle timeout ago
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBe(session.id);
    });

    it('should reject and delete sessions exceeding idle timeout', async () => {
      const lastActivity = new Date(Date.now() - IDLE_TIMEOUT_MS - 1000); // Past idle timeout
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBeNull();

      // Session should be deleted
      const remaining = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(remaining).toBeNull();
    });
  });

  describe('token rotation', () => {
    it('should rotate token when activity exceeds rotation interval', async () => {
      const lastActivity = new Date(Date.now() - TOKEN_ROTATION_INTERVAL_MS - 1000); // Past rotation interval
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });

      // Session should still be valid
      expect(ctx.sessionId).toBe(session.id);

      // Should have a rotated token
      expect(ctx.rotatedToken).toBeDefined();
      expect(ctx.rotatedToken).not.toBe(token);

      // Database should have the new token
      const updatedSession = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(updatedSession).toBeDefined();
      expect(updatedSession!.token).toBe(ctx.rotatedToken);

      // Last activity should be updated
      expect(updatedSession!.lastActivityAt.getTime()).toBeGreaterThan(lastActivity.getTime());
    });

    it('should not rotate token when activity is within rotation interval', async () => {
      const lastActivity = new Date(Date.now() - TOKEN_ROTATION_INTERVAL_MS / 2); // Half of rotation interval
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });

      // Session should still be valid
      expect(ctx.sessionId).toBe(session.id);

      // Should NOT have a rotated token
      expect(ctx.rotatedToken).toBeNull();

      // Token should remain unchanged
      const updatedSession = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(updatedSession!.token).toBe(token);
    });
  });

  describe('activity update throttling', () => {
    it('should update activity when exceeding throttle interval but not rotation interval', async () => {
      // Set last activity to just past the throttle interval but within rotation interval
      const lastActivity = new Date(Date.now() - ACTIVITY_UPDATE_THROTTLE_MS - 1000);
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });

      // Session should be valid
      expect(ctx.sessionId).toBe(session.id);

      // Should NOT have a rotated token
      expect(ctx.rotatedToken).toBeNull();

      // Wait a bit for the async update to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Last activity should be updated
      const updatedSession = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(updatedSession!.lastActivityAt.getTime()).toBeGreaterThan(lastActivity.getTime());
    });

    it('should not update activity when within throttle interval', async () => {
      const lastActivity = new Date(Date.now() - ACTIVITY_UPDATE_THROTTLE_MS / 2); // Half of throttle
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });

      // Session should be valid
      expect(ctx.sessionId).toBe(session.id);

      // Should NOT have a rotated token
      expect(ctx.rotatedToken).toBeNull();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Last activity should NOT be updated (still the same as when created)
      const updatedSession = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(updatedSession!.lastActivityAt.getTime()).toBe(lastActivity.getTime());
    });
  });
});
