import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Create mock objects that will be hoisted
const { mockPodmanFunctions, mockFs, mockEnv } = vi.hoisted(() => {
  const mockPodmanFunctions = {
    listSessionContainers: vi.fn(),
    copyClaudeAuth: vi.fn(),
  };

  const mockFs = {
    watch: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };

  const mockEnv = {
    CLAUDE_AUTH_PATH: '/mock/.claude',
  };

  return { mockPodmanFunctions, mockFs, mockEnv };
});

// Mock the podman service
vi.mock('./podman', () => mockPodmanFunctions);

// Mock fs
vi.mock('fs', () => mockFs);

// Mock env
vi.mock('@/lib/env', () => ({
  env: mockEnv,
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
  startCredentialWatcher,
  stopCredentialWatcher,
  pushCredentialsToAllContainers,
} from './credential-watcher';

describe('credential-watcher service', () => {
  let watchCallback: ((eventType: string, filename: string | null) => void) | null = null;
  let watcherInstance: { close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    watchCallback = null;

    // Create a mock watcher instance
    watcherInstance = {
      close: vi.fn(),
      on: vi.fn(),
    };

    // Set up the watch mock to capture the callback
    mockFs.watch.mockImplementation((_path, _options, callback) => {
      watchCallback = callback;
      return watcherInstance;
    });

    // Default to directory exists and is valid
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isDirectory: () => true });

    // Default copyClaudeAuth to succeed
    mockPodmanFunctions.copyClaudeAuth.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopCredentialWatcher();
    vi.useRealTimers();
  });

  describe('startCredentialWatcher', () => {
    it('should start watching the claude auth directory', () => {
      startCredentialWatcher();

      expect(mockFs.watch).toHaveBeenCalledWith(
        '/mock/.claude',
        { persistent: false },
        expect.any(Function)
      );
    });

    it('should warn if watcher is already running', () => {
      startCredentialWatcher();
      startCredentialWatcher(); // Should warn but not throw

      // Only one watch should be created
      expect(mockFs.watch).toHaveBeenCalledTimes(1);
    });

    it('should skip watching if directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      startCredentialWatcher();

      expect(mockFs.watch).not.toHaveBeenCalled();
    });

    it('should skip watching if path is not a directory', () => {
      mockFs.statSync.mockReturnValue({ isDirectory: () => false });

      startCredentialWatcher();

      expect(mockFs.watch).not.toHaveBeenCalled();
    });
  });

  describe('stopCredentialWatcher', () => {
    it('should close the watcher when stopped', () => {
      startCredentialWatcher();
      stopCredentialWatcher();

      expect(watcherInstance.close).toHaveBeenCalled();
    });

    it('should handle stopping when not running', () => {
      // Should not throw
      stopCredentialWatcher();
    });
  });

  describe('credential file change handling', () => {
    it('should debounce rapid file changes', () => {
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([]);

      startCredentialWatcher();

      // Simulate multiple rapid file changes
      watchCallback?.('change', '.credentials.json');
      watchCallback?.('change', '.credentials.json');
      watchCallback?.('change', '.credentials.json');

      // Before debounce timer, no containers should be queried
      expect(mockPodmanFunctions.listSessionContainers).not.toHaveBeenCalled();

      // Advance timers past debounce interval
      vi.advanceTimersByTime(1500);

      // Now the push should have been triggered (but only once)
      expect(mockPodmanFunctions.listSessionContainers).toHaveBeenCalledTimes(1);
    });

    it('should ignore non-credential files', () => {
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([]);

      startCredentialWatcher();

      // Simulate a change to a non-credential file
      watchCallback?.('change', 'some-other-file.txt');

      // Advance timers
      vi.advanceTimersByTime(1500);

      // No containers should be queried for non-credential files
      expect(mockPodmanFunctions.listSessionContainers).not.toHaveBeenCalled();
    });

    it('should handle .credentials.json and settings.json changes', () => {
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([]);

      startCredentialWatcher();

      // Advance time to avoid duplicate push check from previous test
      vi.advanceTimersByTime(2000);
      mockPodmanFunctions.listSessionContainers.mockClear();

      // Test .credentials.json
      watchCallback?.('change', '.credentials.json');
      vi.advanceTimersByTime(1500);
      expect(mockPodmanFunctions.listSessionContainers).toHaveBeenCalledTimes(1);

      mockPodmanFunctions.listSessionContainers.mockClear();

      // Advance time and test settings.json
      vi.advanceTimersByTime(2000);
      watchCallback?.('change', 'settings.json');
      vi.advanceTimersByTime(1500);
      expect(mockPodmanFunctions.listSessionContainers).toHaveBeenCalledTimes(1);
    });
  });

  describe('pushCredentialsToAllContainers', () => {
    it('should push credentials to all running containers', async () => {
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'container-1', sessionId: 'session-1', status: 'running' },
        { containerId: 'container-2', sessionId: 'session-2', status: 'running' },
      ]);

      const result = await pushCredentialsToAllContainers();

      expect(result.updated).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockPodmanFunctions.copyClaudeAuth).toHaveBeenCalledTimes(2);
      expect(mockPodmanFunctions.copyClaudeAuth).toHaveBeenCalledWith('container-1');
      expect(mockPodmanFunctions.copyClaudeAuth).toHaveBeenCalledWith('container-2');
    });

    it('should skip stopped containers', async () => {
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'container-1', sessionId: 'session-1', status: 'running' },
        { containerId: 'container-2', sessionId: 'session-2', status: 'stopped' },
      ]);

      const result = await pushCredentialsToAllContainers();

      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockPodmanFunctions.copyClaudeAuth).toHaveBeenCalledTimes(1);
      expect(mockPodmanFunctions.copyClaudeAuth).toHaveBeenCalledWith('container-1');
    });

    it('should return empty result when no containers exist', async () => {
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([]);

      const result = await pushCredentialsToAllContainers();

      expect(result).toEqual({ updated: 0, failed: 0 });
      expect(mockPodmanFunctions.copyClaudeAuth).not.toHaveBeenCalled();
    });

    it('should count failed container updates', async () => {
      mockPodmanFunctions.listSessionContainers.mockResolvedValue([
        { containerId: 'container-1', sessionId: 'session-1', status: 'running' },
      ]);
      mockPodmanFunctions.copyClaudeAuth.mockRejectedValue(new Error('Copy failed'));

      const result = await pushCredentialsToAllContainers();

      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
    });
  });
});
