import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// Create mock for child_process
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs.existsSync to simulate running inside a container
vi.mock('fs', () => ({
  existsSync: (path: string) => path === '/run/.containerenv' || path === '/.dockerenv',
}));

// Mock the env module
vi.mock('@/lib/env', () => ({
  env: {
    CLAUDE_RUNNER_IMAGE: 'claude-code-runner:test',
    CLAUDE_AUTH_PATH: '/test/.claude',
    DATA_DIR: '/data',
    DATA_HOST_PATH: undefined,
    PNPM_STORE_PATH: undefined,
    GRADLE_USER_HOME: undefined,
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
import {
  createAndStartContainer,
  stopContainer,
  removeContainer,
  getContainerStatus,
  execInContainer,
  execInContainerWithTee,
  getExecStatus,
  findProcessInContainer,
  sendSignalToExec,
  signalProcessesByPattern,
  killProcessesByPattern,
  readFileInContainer,
  fileExistsInContainer,
  tailFileInContainer,
} from './podman';

// Helper matcher for podman commands that includes the CONTAINER_HOST env
const podmanEnvMatcher = expect.objectContaining({
  env: expect.objectContaining({ CONTAINER_HOST: 'unix:///var/run/docker.sock' }),
});

describe('podman service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createAndStartContainer', () => {
    it('should create and start a new container when none exists', async () => {
      // Use command-based mock responses instead of call count
      // (to avoid issues with lastPullTime caching causing skipped pulls)
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const proc = createMockProcess();
        const command = args[0];

        process.nextTick(() => {
          if (command === 'ps') {
            // ps command - no existing container
            proc.stdout.emit('data', Buffer.from(''));
            proc.emit('close', 0);
          } else if (command === 'pull') {
            // pull command
            proc.emit('close', 0);
          } else if (command === 'create') {
            // create command - return container ID
            proc.stdout.emit('data', Buffer.from('new-container-id\n'));
            proc.emit('close', 0);
          } else if (command === 'start') {
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
        repoPath: 'my-repo',
      });

      expect(containerId).toBe('new-container-id');

      // Note: ensureImagePulled is currently commented out, so pull is not called
      // Verify create was called with correct args including --userns=keep-id and working directory
      const createCall = mockSpawn.mock.calls.find((call) => call[1] && call[1].includes('create'));
      expect(createCall).toBeDefined();
      expect(createCall![1]).toContain('--userns=keep-id');
      expect(createCall![1]).toContain('--name');
      expect(createCall![1]).toContain('claude-session-test-session');
      // Working directory should be set to /workspaces-volume/{sessionId}/{repoPath}
      const wIndex = createCall![1].indexOf('-w');
      expect(createCall![1][wIndex + 1]).toBe('/workspaces-volume/test-session/my-repo');

      // When PODMAN_SOCKET_PATH is not set, should NOT include socket mount or CONTAINER_HOST env
      const createArgs = createCall![1] as string[];
      expect(createArgs).not.toContain('CONTAINER_HOST=unix:///var/run/docker.sock');
      expect(createArgs.join(' ')).not.toContain('/var/run/docker.sock');
    });

    it('should use /workspace as working dir when repoPath is empty', async () => {
      // Note: pull may be skipped if recently pulled by another test
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const proc = createMockProcess();

        process.nextTick(() => {
          if (args[0] === 'ps') {
            // ps command - no existing container
            proc.stdout.emit('data', Buffer.from(''));
            proc.emit('close', 0);
          } else if (args[0] === 'pull') {
            // pull command
            proc.emit('close', 0);
          } else if (args[0] === 'create') {
            // create command - return container ID
            proc.stdout.emit('data', Buffer.from('new-container-id\n'));
            proc.emit('close', 0);
          } else if (args[0] === 'start') {
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
        repoPath: '',
      });

      expect(containerId).toBe('new-container-id');

      const createCall = mockSpawn.mock.calls.find((call) => call[1] && call[1].includes('create'));
      expect(createCall).toBeDefined();
      // When repoPath is empty, working directory is /workspaces-volume/{sessionId}
      const wIndex = createCall![1].indexOf('-w');
      expect(createCall![1][wIndex + 1]).toBe('/workspaces-volume/test-session');
    });

    it('should return existing container ID if already running', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          // ps command - existing running container
          proc.stdout.emit('data', Buffer.from('existing-id\trunning\n'));
          proc.emit('close', 0);
        });
        return proc;
      });

      const containerId = await createAndStartContainer({
        sessionId: 'test-session',
        workspacePath: '/data/workspaces/test-session',
        repoPath: 'my-repo',
      });

      expect(containerId).toBe('existing-id');
      // Should only call ps, not create
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('should start existing stopped container', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const proc = createMockProcess();
        process.nextTick(() => {
          if (callCount === 1) {
            // ps - container exists but stopped
            proc.stdout.emit('data', Buffer.from('stopped-id\texited\n'));
            proc.emit('close', 0);
          } else {
            // start command
            proc.emit('close', 0);
          }
        });
        return proc;
      });

      const containerId = await createAndStartContainer({
        sessionId: 'test-session',
        workspacePath: '/data/workspaces/test-session',
        repoPath: 'my-repo',
      });

      expect(containerId).toBe('stopped-id');
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      // Second call should be start
      const startCall = mockSpawn.mock.calls[1];
      expect(startCall[1]).toContain('start');
      expect(startCall[1]).toContain('stopped-id');
    });
  });

  describe('stopContainer', () => {
    it('should stop a container', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => proc.emit('close', 0));
        return proc;
      });

      await stopContainer('test-container-id');

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['stop', '-t', '10', 'test-container-id'],
        podmanEnvMatcher
      );
    });

    it('should not throw if container is already stopped', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stderr.emit('data', Buffer.from('container not running'));
          proc.emit('close', 1);
        });
        return proc;
      });

      // Should not throw
      await expect(stopContainer('test-container-id')).resolves.not.toThrow();
    });
  });

  describe('removeContainer', () => {
    it('should stop and remove a container', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => proc.emit('close', 0));
        return proc;
      });

      await removeContainer('test-container-id');

      // Should call stop then rm (with CONTAINER_HOST env)
      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['stop', '-t', '5', 'test-container-id'],
        podmanEnvMatcher
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['rm', '-f', 'test-container-id'],
        podmanEnvMatcher
      );
    });
  });

  describe('getContainerStatus', () => {
    it('should return running for a running container', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from('true\n'));
          proc.emit('close', 0);
        });
        return proc;
      });

      const status = await getContainerStatus('test-container-id');
      expect(status).toBe('running');
    });

    it('should return stopped for a stopped container', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from('false\n'));
          proc.emit('close', 0);
        });
        return proc;
      });

      const status = await getContainerStatus('test-container-id');
      expect(status).toBe('stopped');
    });

    it('should return not_found for non-existent container', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stderr.emit('data', Buffer.from('no such container'));
          proc.emit('close', 1);
        });
        return proc;
      });

      const status = await getContainerStatus('nonexistent');
      expect(status).toBe('not_found');
    });
  });

  describe('execInContainer', () => {
    it('should execute a command and return stream', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        return proc;
      });

      const result = await execInContainer('test-container', ['ls', '-la']);

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'ls', '-la'],
        podmanEnvMatcher
      );
      expect(result.stream).toBeTruthy();
      expect(result.execId).toBe('test-uuid-1234');
    });
  });

  describe('execInContainerWithTee', () => {
    it('should execute command with tee and return stream', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        return proc;
      });

      const result = await execInContainerWithTee(
        'test-container',
        ['claude', '-p', 'hello'],
        '/tmp/output.txt'
      );

      expect(result.stream).toBeTruthy();
      expect(result.execId).toBe('test-uuid-1234');

      // Verify the command includes tee
      const execCall = mockSpawn.mock.calls[0];
      expect(execCall[1]).toContain('exec');
      expect(execCall[1]).toContain('test-container');
      expect(execCall[1].join(' ')).toContain('tee');
      expect(execCall[1].join(' ')).toContain('/tmp/output.txt');
    });
  });

  describe('getExecStatus', () => {
    it('should return running status for running exec', async () => {
      // First, start an exec
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        // Don't emit close - process is still running
        return proc;
      });

      const { execId } = await execInContainer('test-container', ['sleep', '100']);

      const status = await getExecStatus(execId);
      expect(status.running).toBe(true);
      expect(status.exitCode).toBeNull();
    });

    it('should return not running for unknown exec', async () => {
      const status = await getExecStatus('unknown-exec-id');
      expect(status.running).toBe(false);
      expect(status.exitCode).toBeNull();
    });
  });

  describe('findProcessInContainer', () => {
    it('should return PID when process is found', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from('12345\n'));
          proc.emit('close', 0);
        });
        return proc;
      });

      const pid = await findProcessInContainer('test-container', 'claude');
      expect(pid).toBe(12345);

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'pgrep', '-f', 'claude'],
        podmanEnvMatcher
      );
    });

    it('should return null when process is not found', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from(''));
          proc.emit('close', 1);
        });
        return proc;
      });

      const pid = await findProcessInContainer('test-container', 'nonexistent');
      expect(pid).toBeNull();
    });
  });

  describe('sendSignalToExec', () => {
    it('should send signal to a process', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => proc.emit('close', 0));
        return proc;
      });

      await sendSignalToExec('test-container', 12345, 'INT');

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'kill', '-INT', '12345'],
        podmanEnvMatcher
      );
    });
  });

  describe('signalProcessesByPattern', () => {
    it('should send signal to processes matching pattern', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => proc.emit('close', 0));
        return proc;
      });

      await signalProcessesByPattern('test-container', 'claude', 'TERM');

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'pkill', '-TERM', '-f', 'claude'],
        podmanEnvMatcher
      );
    });
  });

  describe('killProcessesByPattern', () => {
    it('should call signalProcessesByPattern with TERM', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => proc.emit('close', 0));
        return proc;
      });

      await killProcessesByPattern('test-container', 'tail -f');

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'pkill', '-TERM', '-f', 'tail -f'],
        podmanEnvMatcher
      );
    });
  });

  describe('readFileInContainer', () => {
    it('should read file contents', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from('file contents here'));
          proc.emit('close', 0);
        });
        return proc;
      });

      const contents = await readFileInContainer('test-container', '/tmp/test.txt');

      expect(contents).toBe('file contents here');
      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'cat', '/tmp/test.txt'],
        podmanEnvMatcher
      );
    });
  });

  describe('fileExistsInContainer', () => {
    it('should return true when file exists', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => proc.emit('close', 0));
        return proc;
      });

      const exists = await fileExistsInContainer('test-container', '/tmp/test.txt');

      expect(exists).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'test', '-f', '/tmp/test.txt'],
        podmanEnvMatcher
      );
    });

    it('should return false when file does not exist', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => proc.emit('close', 1));
        return proc;
      });

      const exists = await fileExistsInContainer('test-container', '/tmp/nonexistent.txt');

      expect(exists).toBe(false);
    });
  });

  describe('tailFileInContainer', () => {
    it('should tail a file starting from a specific line', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        return proc;
      });

      const result = await tailFileInContainer('test-container', '/tmp/output.txt', 10);

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['exec', 'test-container', 'tail', '-n', '+11', '-f', '/tmp/output.txt'],
        podmanEnvMatcher
      );
      expect(result.stream).toBeTruthy();
      expect(result.execId).toBe('test-uuid-1234');
    });
  });
});
