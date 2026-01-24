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
    GIT_CACHE_VOLUME: 'clawed-burrow-git-cache',
    SESSION_BRANCH_PREFIX: 'claude/',
    SKIP_IMAGE_PULL: true,
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

  // Add mock unref method for background processes
  (proc as unknown as { unref: () => void }).unref = vi.fn();

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
  getContainerState,
  getContainerLogs,
  verifyContainerHealth,
  listSessionContainers,
  execInContainer,
  execInContainerWithTee,
  getExecStatus,
  isErrorExitCode,
  describeExitCode,
  findProcessInContainer,
  sendSignalToExec,
  signalProcessesByPattern,
  killProcessesByPattern,
  readFileInContainer,
  fileExistsInContainer,
  tailFileInContainer,
  cloneRepoInVolume,
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
        repoPath: 'my-repo',
      });

      expect(containerId).toBe('new-container-id');

      // Note: ensureImagePulled is currently commented out, so pull is not called
      // Verify create was called with correct args and working directory
      const createCall = mockSpawn.mock.calls.find((call) => call[1] && call[1].includes('create'));
      expect(createCall).toBeDefined();
      // --userns=keep-id should NOT be present when no pnpm/Gradle caches are configured
      expect(createCall![1]).not.toContain('--userns=keep-id');
      expect(createCall![1]).toContain('--name');
      expect(createCall![1]).toContain('claude-session-test-session');
      // Working directory should be set to /workspace/{repoPath}
      const wIndex = createCall![1].indexOf('-w');
      expect(createCall![1][wIndex + 1]).toBe('/workspace/my-repo');

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
        repoPath: '',
      });

      expect(containerId).toBe('new-container-id');

      const createCall = mockSpawn.mock.calls.find((call) => call[1] && call[1].includes('create'));
      expect(createCall).toBeDefined();
      // When repoPath is empty, working directory is /workspace (the session's mounted workspace)
      const wIndex = createCall![1].indexOf('-w');
      expect(createCall![1][wIndex + 1]).toBe('/workspace');
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

  describe('listSessionContainers', () => {
    it('should return list of session containers with status', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit(
            'data',
            Buffer.from(
              'abc123\tclaude-session-session-1\trunning\ndef456\tclaude-session-session-2\tstopped\n'
            )
          );
          proc.emit('close', 0);
        });
        return proc;
      });

      const containers = await listSessionContainers();

      expect(containers).toHaveLength(2);
      expect(containers[0]).toEqual({
        containerId: 'abc123',
        sessionId: 'session-1',
        status: 'running',
      });
      expect(containers[1]).toEqual({
        containerId: 'def456',
        sessionId: 'session-2',
        status: 'stopped',
      });
    });

    it('should return empty array when no containers exist', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from(''));
          proc.emit('close', 0);
        });
        return proc;
      });

      const containers = await listSessionContainers();

      expect(containers).toHaveLength(0);
    });

    it('should return empty array on podman error', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stderr.emit('data', Buffer.from('connection refused'));
          proc.emit('close', 1);
        });
        return proc;
      });

      const containers = await listSessionContainers();

      expect(containers).toHaveLength(0);
    });

    it('should filter out non-session containers', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit(
            'data',
            Buffer.from(
              'abc123\tclaude-session-session-1\trunning\nxyz789\tother-container\trunning\n'
            )
          );
          proc.emit('close', 0);
        });
        return proc;
      });

      const containers = await listSessionContainers();

      expect(containers).toHaveLength(1);
      expect(containers[0].sessionId).toBe('session-1');
    });

    it('should correctly parse UUID session IDs', async () => {
      const sessionUuid = '550e8400-e29b-41d4-a716-446655440000';
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from(`abc123\tclaude-session-${sessionUuid}\trunning\n`));
          proc.emit('close', 0);
        });
        return proc;
      });

      const containers = await listSessionContainers();

      expect(containers).toHaveLength(1);
      expect(containers[0].sessionId).toBe(sessionUuid);
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
      expect(status.notFound).toBe(false);
    });

    it('should return not running for unknown exec with notFound flag', async () => {
      const status = await getExecStatus('unknown-exec-id');
      expect(status.running).toBe(false);
      expect(status.exitCode).toBeNull();
      expect(status.notFound).toBe(true);
    });
  });

  describe('isErrorExitCode', () => {
    it('should return false for null exit code', () => {
      expect(isErrorExitCode(null)).toBe(false);
    });

    it('should return false for exit code 0', () => {
      expect(isErrorExitCode(0)).toBe(false);
    });

    it('should return true for non-zero exit codes', () => {
      expect(isErrorExitCode(1)).toBe(true);
      expect(isErrorExitCode(137)).toBe(true);
      expect(isErrorExitCode(139)).toBe(true);
      expect(isErrorExitCode(-1)).toBe(true);
    });
  });

  describe('describeExitCode', () => {
    it('should describe null exit code', () => {
      expect(describeExitCode(null)).toBe('unknown exit code');
    });

    it('should describe success', () => {
      expect(describeExitCode(0)).toBe('success');
    });

    it('should describe SIGKILL (OOM)', () => {
      expect(describeExitCode(137)).toBe('killed (SIGKILL) - possibly out of memory');
    });

    it('should describe SIGSEGV', () => {
      expect(describeExitCode(139)).toBe('segmentation fault (SIGSEGV)');
    });

    it('should describe SIGTERM', () => {
      expect(describeExitCode(143)).toBe('terminated (SIGTERM)');
    });

    it('should describe SIGINT', () => {
      expect(describeExitCode(130)).toBe('interrupted (SIGINT)');
    });

    it('should describe other signals', () => {
      expect(describeExitCode(129)).toBe('killed by signal 1');
    });

    it('should describe regular error codes', () => {
      expect(describeExitCode(1)).toBe('error code 1');
      expect(describeExitCode(127)).toBe('error code 127');
    });
  });

  describe('getContainerState', () => {
    it('should return running state', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                Running: true,
                ExitCode: 0,
                Error: '',
                StartedAt: '2024-01-01T00:00:00Z',
                FinishedAt: '0001-01-01T00:00:00Z',
                OOMKilled: false,
              })
            )
          );
          proc.emit('close', 0);
        });
        return proc;
      });

      const state = await getContainerState('test-container');
      expect(state.status).toBe('running');
      expect(state.exitCode).toBe(0);
      // Empty string is converted to null by the || operator
      expect(state.error).toBeNull();
      expect(state.oomKilled).toBe(false);
    });

    it('should return stopped state with exit code', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                Running: false,
                ExitCode: 137,
                Error: 'container was killed',
                StartedAt: '2024-01-01T00:00:00Z',
                FinishedAt: '2024-01-01T01:00:00Z',
                OOMKilled: true,
              })
            )
          );
          proc.emit('close', 0);
        });
        return proc;
      });

      const state = await getContainerState('test-container');
      expect(state.status).toBe('stopped');
      expect(state.exitCode).toBe(137);
      expect(state.error).toBe('container was killed');
      expect(state.oomKilled).toBe(true);
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

      const state = await getContainerState('nonexistent');
      expect(state.status).toBe('not_found');
      expect(state.exitCode).toBeNull();
      expect(state.error).toBeNull();
    });
  });

  describe('getContainerLogs', () => {
    it('should return container logs', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from('Log line 1\nLog line 2\n'));
          proc.emit('close', 0);
        });
        return proc;
      });

      const logs = await getContainerLogs('test-container');
      expect(logs).toBe('Log line 1\nLog line 2\n');
    });

    it('should pass tail and since options', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stdout.emit('data', Buffer.from('logs'));
          proc.emit('close', 0);
        });
        return proc;
      });

      await getContainerLogs('test-container', { tail: 50, since: '10m' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'podman',
        ['logs', '--tail', '50', '--since', '10m', 'test-container'],
        podmanEnvMatcher
      );
    });

    it('should return null on error', async () => {
      mockSpawn.mockImplementation(() => {
        const proc = createMockProcess();
        process.nextTick(() => {
          proc.stderr.emit('data', Buffer.from('container not found'));
          proc.emit('close', 1);
        });
        return proc;
      });

      const logs = await getContainerLogs('nonexistent');
      expect(logs).toBeNull();
    });
  });

  describe('verifyContainerHealth', () => {
    it('should verify healthy container', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        callCount++;
        const proc = createMockProcess();
        process.nextTick(() => {
          if (args.includes('inspect')) {
            proc.stdout.emit(
              'data',
              Buffer.from(JSON.stringify({ Running: true, ExitCode: 0, OOMKilled: false }))
            );
            proc.emit('close', 0);
          } else if (args.includes('echo')) {
            proc.stdout.emit('data', Buffer.from('health-check'));
            proc.emit('close', 0);
          } else if (args.includes('which')) {
            proc.stdout.emit('data', Buffer.from('/usr/bin/claude'));
            proc.emit('close', 0);
          } else {
            proc.emit('close', 0);
          }
        });
        return proc;
      });

      await expect(verifyContainerHealth('test-container')).resolves.toBeUndefined();
      expect(callCount).toBe(3); // inspect, echo, which
    });

    it('should throw if container is not running', async () => {
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const proc = createMockProcess();
        process.nextTick(() => {
          if (args.includes('inspect')) {
            proc.stdout.emit(
              'data',
              Buffer.from(JSON.stringify({ Running: false, ExitCode: 1, OOMKilled: false }))
            );
            proc.emit('close', 0);
          } else if (args.includes('logs')) {
            proc.stdout.emit('data', Buffer.from('error logs'));
            proc.emit('close', 0);
          } else {
            proc.emit('close', 0);
          }
        });
        return proc;
      });

      await expect(verifyContainerHealth('test-container')).rejects.toThrow(
        /Container is not running/
      );
    });

    it('should throw if claude is not available', async () => {
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const proc = createMockProcess();
        process.nextTick(() => {
          if (args.includes('inspect')) {
            proc.stdout.emit(
              'data',
              Buffer.from(JSON.stringify({ Running: true, ExitCode: 0, OOMKilled: false }))
            );
            proc.emit('close', 0);
          } else if (args.includes('echo')) {
            proc.stdout.emit('data', Buffer.from('health-check'));
            proc.emit('close', 0);
          } else if (args.includes('which')) {
            proc.stderr.emit('data', Buffer.from('claude not found'));
            proc.emit('close', 1);
          } else {
            proc.emit('close', 0);
          }
        });
        return proc;
      });

      await expect(verifyContainerHealth('test-container')).rejects.toThrow(
        /Claude CLI not available/
      );
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

  describe('cloneRepoInVolume', () => {
    it('should clone with --reference when cache update succeeds', async () => {
      const commandLog: string[][] = [];

      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        commandLog.push(args);
        const proc = createMockProcess();

        process.nextTick(() => {
          // Handle different commands
          if (args[0] === 'volume' && args[1] === 'inspect') {
            // Cache volume exists
            proc.emit('close', 0);
          } else if (args[0] === 'volume' && args[1] === 'create') {
            // Create volume succeeds
            proc.emit('close', 0);
          } else if (args[0] === 'create') {
            // Create container - return ID
            proc.stdout.emit('data', Buffer.from('container-id\n'));
            proc.emit('close', 0);
          } else if (args[0] === 'start') {
            proc.emit('close', 0);
          } else if (args[0] === 'stop' || args[0] === 'rm') {
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('ls')) {
            // Check if cache exists - simulate it exists
            proc.stdout.emit('data', Buffer.from('/cache/owner--repo.git\n'));
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('fetch')) {
            // Git fetch succeeds
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('clone')) {
            // Git clone succeeds
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('remote')) {
            // Git remote set-url succeeds
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('checkout')) {
            // Git checkout succeeds
            proc.emit('close', 0);
          } else {
            proc.emit('close', 0);
          }
        });

        return proc;
      });

      const result = await cloneRepoInVolume({
        sessionId: 'test-session-123',
        repoFullName: 'owner/repo',
        branch: 'main',
      });

      expect(result.repoPath).toBe('repo');

      // Find the clone command and verify it includes --reference
      const cloneCmd = commandLog.find((args) => args.includes('exec') && args.includes('clone'));
      expect(cloneCmd).toBeDefined();
      expect(cloneCmd).toContain('--reference');
      expect(cloneCmd).toContain('/cache/owner--repo.git');
      expect(cloneCmd).toContain('--dissociate');
    });

    it('should clone without --reference when cache update fails', async () => {
      const commandLog: string[][] = [];
      let cacheContainerCreated = false;

      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        commandLog.push(args);
        const proc = createMockProcess();

        process.nextTick(() => {
          // Handle different commands
          if (args[0] === 'volume' && args[1] === 'inspect') {
            // Cache volume doesn't exist
            proc.stderr.emit('data', Buffer.from('no such volume'));
            proc.emit('close', 1);
          } else if (args[0] === 'volume' && args[1] === 'create') {
            // Create volume succeeds
            proc.emit('close', 0);
          } else if (args[0] === 'create') {
            // Track if this is the cache container
            if (!cacheContainerCreated) {
              cacheContainerCreated = true;
              // Create cache container - return ID
              proc.stdout.emit('data', Buffer.from('cache-container-id\n'));
              proc.emit('close', 0);
            } else {
              // Create clone container - return ID
              proc.stdout.emit('data', Buffer.from('clone-container-id\n'));
              proc.emit('close', 0);
            }
          } else if (args[0] === 'start') {
            proc.emit('close', 0);
          } else if (args[0] === 'stop' || args[0] === 'rm') {
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('mkdir')) {
            // mkdir -p succeeds
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('clone') && args.includes('--bare')) {
            // Git bare clone fails (simulate network error)
            proc.stderr.emit('data', Buffer.from('fatal: unable to access'));
            proc.emit('close', 1);
          } else if (args.includes('exec') && args.includes('clone')) {
            // Regular clone succeeds
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('remote')) {
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('checkout')) {
            proc.emit('close', 0);
          } else {
            proc.emit('close', 0);
          }
        });

        return proc;
      });

      const result = await cloneRepoInVolume({
        sessionId: 'test-session-456',
        repoFullName: 'owner/repo',
        branch: 'main',
      });

      expect(result.repoPath).toBe('repo');

      // Find the final clone command (not the --bare one) and verify it does NOT include --reference
      const cloneCmds = commandLog.filter(
        (args) => args.includes('exec') && args.includes('clone') && !args.includes('--bare')
      );
      expect(cloneCmds.length).toBe(1);
      expect(cloneCmds[0]).not.toContain('--reference');
      expect(cloneCmds[0]).not.toContain('--dissociate');
    });

    it('should use correct cache path format (owner--repo.git)', async () => {
      const commandLog: string[][] = [];

      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        commandLog.push(args);
        const proc = createMockProcess();

        process.nextTick(() => {
          if (args[0] === 'volume') {
            proc.emit('close', 0);
          } else if (args[0] === 'create') {
            proc.stdout.emit('data', Buffer.from('container-id\n'));
            proc.emit('close', 0);
          } else if (args[0] === 'start' || args[0] === 'stop' || args[0] === 'rm') {
            proc.emit('close', 0);
          } else if (args.includes('exec') && args.includes('ls')) {
            // Cache exists
            proc.stdout.emit('data', Buffer.from('/cache/my-org--my-repo.git\n'));
            proc.emit('close', 0);
          } else {
            proc.emit('close', 0);
          }
        });

        return proc;
      });

      await cloneRepoInVolume({
        sessionId: 'test-session',
        repoFullName: 'my-org/my-repo',
        branch: 'main',
      });

      // Verify the cache check used the correct path format
      const lsCmd = commandLog.find((args) => args.includes('ls') && args.includes('-d'));
      expect(lsCmd).toBeDefined();
      expect(lsCmd).toContain('/cache/my-org--my-repo.git');
    });
  });
});
