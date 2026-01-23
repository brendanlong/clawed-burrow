import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// Create mock for child_process
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs.existsSync to simulate docker socket existing
vi.mock('fs', () => ({
  existsSync: (path: string) => path === '/var/run/docker.sock',
}));

// Mock the env module WITH PODMAN_SOCKET_PATH set
vi.mock('@/lib/env', () => ({
  env: {
    CLAUDE_RUNNER_IMAGE: 'claude-code-runner:test',
    CLAUDE_AUTH_PATH: '/test/.claude',
    DATA_DIR: '/data',
    DATA_HOST_PATH: undefined,
    PNPM_STORE_PATH: undefined,
    GRADLE_USER_HOME: undefined,
    PODMAN_SOCKET_PATH: '/run/user/1000/podman/podman.sock',
  },
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

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Helper to create a mock child process with pipe-able streams
function createMockProcess(): ChildProcess & {
  stdout: EventEmitter & {
    pipe: (dest: NodeJS.WritableStream, opts?: { end?: boolean }) => NodeJS.WritableStream;
  };
  stderr: EventEmitter & {
    pipe: (dest: NodeJS.WritableStream, opts?: { end?: boolean }) => NodeJS.WritableStream;
  };
} {
  const proc = new EventEmitter() as ChildProcess & {
    stdout: EventEmitter & {
      pipe: (dest: NodeJS.WritableStream, opts?: { end?: boolean }) => NodeJS.WritableStream;
    };
    stderr: EventEmitter & {
      pipe: (dest: NodeJS.WritableStream, opts?: { end?: boolean }) => NodeJS.WritableStream;
    };
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  // Add mock pipe method that forwards data
  (stdout as unknown as { pipe: (dest: NodeJS.WritableStream) => NodeJS.WritableStream }).pipe =
    vi.fn((dest) => dest);
  (stderr as unknown as { pipe: (dest: NodeJS.WritableStream) => NodeJS.WritableStream }).pipe =
    vi.fn((dest) => dest);

  proc.stdout = stdout as unknown as typeof proc.stdout;
  proc.stderr = stderr as unknown as typeof proc.stderr;
  return proc;
}

// Import after mocks
import { createAndStartContainer } from './podman';

describe('podman service with PODMAN_SOCKET_PATH', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createAndStartContainer', () => {
    it('should mount socket and set CONTAINER_HOST when PODMAN_SOCKET_PATH is configured', async () => {
      // First call: ps to check existing containers (empty result)
      // Second call: pull image
      // Third call: create container
      // Fourth call: start container
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const proc = createMockProcess();

        process.nextTick(() => {
          if (callCount === 1) {
            // ps command - no existing container
            proc.stdout.emit('data', Buffer.from(''));
            proc.emit('close', 0);
          } else if (callCount === 2) {
            // pull command
            proc.emit('close', 0);
          } else if (callCount === 3) {
            // create command - return container ID
            proc.stdout.emit('data', Buffer.from('new-container-id\n'));
            proc.emit('close', 0);
          } else if (callCount === 4) {
            // start command
            proc.emit('close', 0);
          } else {
            proc.emit('close', 0);
          }
        });

        return proc;
      });

      const containerId = await createAndStartContainer({
        sessionId: 'test-session',
        workspacePath: '/data/workspaces/test-session',
      });

      expect(containerId).toBe('new-container-id');

      // Verify create was called with socket mount and CONTAINER_HOST env
      const createCall = mockSpawn.mock.calls.find((call) => call[1] && call[1].includes('create'));
      expect(createCall).toBeDefined();
      const createArgs = createCall![1] as string[];

      // Should include CONTAINER_HOST env var for the container
      const envArgs = createArgs.filter((arg, i) => i > 0 && createArgs[i - 1] === '-e');
      expect(envArgs).toContain('CONTAINER_HOST=unix:///var/run/docker.sock');

      // Should include socket mount
      const argsString = createArgs.join(' ');
      expect(argsString).toContain('/run/user/1000/podman/podman.sock:/var/run/docker.sock');
    });
  });
});
