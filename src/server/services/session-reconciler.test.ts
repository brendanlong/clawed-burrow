import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Create mock objects that will be hoisted
const { mockPodmanFunctions, mockPrisma } = vi.hoisted(() => {
  const mockPodmanFunctions = {
    getContainerStatus: vi.fn(),
    listSessionContainers: vi.fn(),
    removeContainer: vi.fn(),
  };

  const mockPrisma = {
    session: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  return { mockPodmanFunctions, mockPrisma };
});

// Mock the podman service
vi.mock('./podman', () => mockPodmanFunctions);

// Mock prisma
vi.mock('@/lib/prisma', () => ({
  prisma: mockPrisma,
}));

// Mock the logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// Import after mocks are set up
import {
  reconcileSessionsWithPodman,
  syncSessionStatus,
  startBackgroundReconciliation,
  stopBackgroundReconciliation,
} from './session-reconciler';

describe('session-reconciler service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stop any running background reconciliation between tests
    stopBackgroundReconciliation();
  });

  afterEach(() => {
    stopBackgroundReconciliation();
  });

  describe('reconcileSessionsWithPodman', () => {
    it('should return empty result when no sessions exist', async () => {
      mockPrisma.session.findMany.mockResolvedValue([]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([]);

      const result = await reconcileSessionsWithPodman();

      expect(result).toEqual({
        sessionsChecked: 0,
        sessionsUpdated: 0,
        orphanedContainersCleaned: 0,
        sessionsMarkedStopped: 0,
        sessionsMarkedRunning: 0,
      });
    });

    it('should mark running session as stopped when container is not found', async () => {
      const session = {
        id: 'session-1',
        containerId: 'container-1',
        status: 'running',
      };
      mockPrisma.session.findMany.mockResolvedValue([session]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([]);
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('not_found');
      mockPrisma.session.update.mockResolvedValue({ ...session, status: 'stopped' });

      const result = await reconcileSessionsWithPodman();

      expect(result.sessionsChecked).toBe(1);
      expect(result.sessionsMarkedStopped).toBe(1);
      expect(result.sessionsUpdated).toBe(1);
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: 'stopped' },
      });
    });

    it('should mark stopped session as running when container is actually running', async () => {
      const session = {
        id: 'session-1',
        containerId: 'container-1',
        status: 'stopped',
      };
      mockPrisma.session.findMany.mockResolvedValue([session]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'container-1', sessionId: 'session-1', status: 'running' },
      ]);

      const result = await reconcileSessionsWithPodman();

      expect(result.sessionsChecked).toBe(1);
      expect(result.sessionsMarkedRunning).toBe(1);
      expect(result.sessionsUpdated).toBe(1);
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: 'running' },
      });
    });

    it('should not update session when status matches container state', async () => {
      const session = {
        id: 'session-1',
        containerId: 'container-1',
        status: 'running',
      };
      mockPrisma.session.findMany.mockResolvedValue([session]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'container-1', sessionId: 'session-1', status: 'running' },
      ]);

      const result = await reconcileSessionsWithPodman();

      expect(result.sessionsChecked).toBe(1);
      expect(result.sessionsUpdated).toBe(0);
      expect(mockPrisma.session.update).not.toHaveBeenCalled();
    });

    it('should update container ID when container was recreated', async () => {
      const session = {
        id: 'session-1',
        containerId: 'old-container-1',
        status: 'running',
      };
      mockPrisma.session.findMany.mockResolvedValue([session]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'new-container-1', sessionId: 'session-1', status: 'running' },
      ]);
      mockPrisma.session.update.mockResolvedValue({ ...session, containerId: 'new-container-1' });

      const result = await reconcileSessionsWithPodman();

      expect(result.sessionsChecked).toBe(1);
      expect(result.sessionsUpdated).toBe(1);
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { containerId: 'new-container-1' },
      });
    });

    it('should clean up orphaned containers with no matching session', async () => {
      mockPrisma.session.findMany.mockResolvedValue([]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'orphan-container', sessionId: 'nonexistent-session', status: 'running' },
      ]);
      mockPrisma.session.findUnique.mockResolvedValue(null); // Session doesn't exist

      const result = await reconcileSessionsWithPodman();

      expect(result.orphanedContainersCleaned).toBe(1);
      expect(mockPodmanFunctions.removeContainer).toHaveBeenCalledWith('orphan-container');
    });

    it('should not clean up container if session exists but not in findMany result (e.g., creating state)', async () => {
      // Session in "creating" state won't be in findMany results (filtered out)
      mockPrisma.session.findMany.mockResolvedValue([]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'container-1', sessionId: 'session-1', status: 'running' },
      ]);
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        status: 'creating',
      });

      const result = await reconcileSessionsWithPodman();

      expect(result.orphanedContainersCleaned).toBe(0);
      expect(mockPodmanFunctions.removeContainer).not.toHaveBeenCalled();
    });

    it('should handle errors during orphan container cleanup gracefully', async () => {
      mockPrisma.session.findMany.mockResolvedValue([]);
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'orphan-container', sessionId: 'nonexistent-session', status: 'running' },
      ]);
      mockPrisma.session.findUnique.mockResolvedValue(null);
      mockPodmanFunctions.removeContainer.mockRejectedValue(new Error('Remove failed'));

      // Should not throw
      const result = await reconcileSessionsWithPodman();

      // The function should still complete, just with 0 cleaned (due to error)
      expect(result.orphanedContainersCleaned).toBe(0);
    });
  });

  describe('syncSessionStatus', () => {
    it('should return null when session not found', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const result = await syncSessionStatus('nonexistent-session');

      expect(result).toBeNull();
    });

    it('should return null when session has no container ID', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        containerId: null,
        status: 'stopped',
      });

      const result = await syncSessionStatus('session-1');

      expect(result).toBeNull();
    });

    it('should return null for sessions in creating state', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        containerId: 'container-1',
        status: 'creating',
      });

      const result = await syncSessionStatus('session-1');

      expect(result).toBeNull();
      expect(mockPodmanFunctions.getContainerStatus).not.toHaveBeenCalled();
    });

    it('should update and return new status when container is stopped but session marked running', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        containerId: 'container-1',
        status: 'running',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('stopped');

      const result = await syncSessionStatus('session-1');

      expect(result).toBe('stopped');
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: 'stopped' },
      });
    });

    it('should update and return new status when container is running but session marked stopped', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        containerId: 'container-1',
        status: 'stopped',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');

      const result = await syncSessionStatus('session-1');

      expect(result).toBe('running');
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: 'running' },
      });
    });

    it('should return null when status already matches container state', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        containerId: 'container-1',
        status: 'running',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');

      const result = await syncSessionStatus('session-1');

      expect(result).toBeNull();
      expect(mockPrisma.session.update).not.toHaveBeenCalled();
    });

    it('should mark running session as stopped when container not found', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        containerId: 'container-1',
        status: 'running',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('not_found');

      const result = await syncSessionStatus('session-1');

      expect(result).toBe('stopped');
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: 'stopped' },
      });
    });
  });

  describe('background reconciliation', () => {
    it('should start and stop background reconciliation', () => {
      // Just test that these functions don't throw
      startBackgroundReconciliation();
      stopBackgroundReconciliation();
    });

    it('should warn when starting background reconciliation twice', () => {
      startBackgroundReconciliation();
      startBackgroundReconciliation(); // Should warn but not throw
      stopBackgroundReconciliation();
    });

    it('should handle stopping when not running', () => {
      // Should not throw
      stopBackgroundReconciliation();
    });
  });
});
