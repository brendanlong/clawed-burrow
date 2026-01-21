import { describe, it, expect, beforeEach, vi, afterEach, Mock } from 'vitest';
import { EventEmitter } from 'events';

// Helper to create a mock stream
function createMockStream(): EventEmitter & { resume: Mock } {
  const stream = new EventEmitter() as EventEmitter & { resume: Mock };
  stream.resume = vi.fn();
  return stream;
}

// Helper to create a Docker multiplexed frame
function createDockerFrame(streamType: number, data: string): Buffer {
  const payload = Buffer.from(data, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// Create mock objects that will be hoisted
const { mockContainer, mockExec, mockDocker } = vi.hoisted(() => {
  const mockContainer = {
    id: 'test-container-id',
    start: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    inspect: vi.fn(),
    exec: vi.fn(),
  };

  const mockExec = {
    id: 'test-exec-id',
    start: vi.fn(),
    inspect: vi.fn(),
  };

  const mockDocker = {
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    getContainer: vi.fn(),
    getExec: vi.fn(),
    pull: vi.fn(),
    modem: {
      followProgress: vi.fn(),
    },
  };

  return { mockContainer, mockExec, mockDocker };
});

// Mock dockerode - use factory function
vi.mock('dockerode', () => {
  return {
    default: function Docker() {
      return mockDocker;
    },
  };
});

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

// Import after mocks are set up
import {
  createAndStartContainer,
  stopContainer,
  removeContainer,
  execInContainer,
  getContainerStatus,
  sendSignalToExec,
  signalProcessesByPattern,
  killProcessesByPattern,
  findProcessInContainer,
  isProcessRunning,
  execInContainerWithOutputFile,
  getExecStatus,
  tailFileInContainer,
  readFileInContainer,
  countLinesInContainer,
  fileExistsInContainer,
} from './docker';

describe('docker service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset container and exec mocks
    mockContainer.start.mockResolvedValue(undefined);
    mockContainer.stop.mockResolvedValue(undefined);
    mockContainer.remove.mockResolvedValue(undefined);
    mockContainer.inspect.mockResolvedValue({ State: { Running: true } });
    mockContainer.exec.mockResolvedValue(mockExec);
    mockDocker.getContainer.mockReturnValue(mockContainer);
    mockDocker.getExec.mockReturnValue(mockExec);
    mockDocker.createContainer.mockResolvedValue(mockContainer);
    mockDocker.listContainers.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createAndStartContainer', () => {
    it('should create and start a new container when none exists', async () => {
      const mockStream = createMockStream();

      // Mock pull with callback-style API
      mockDocker.pull.mockImplementation(
        (_image: string, callback: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
          callback(null, mockStream as unknown as NodeJS.ReadableStream);
        }
      );
      mockDocker.modem.followProgress.mockImplementation(
        (
          _stream: NodeJS.ReadableStream,
          onFinish: (err: Error | null) => void,
          _onProgress: (event: { status?: string; progress?: string }) => void
        ) => {
          onFinish(null);
        }
      );

      mockDocker.listContainers.mockResolvedValue([]);

      const containerId = await createAndStartContainer({
        sessionId: 'test-session',
        workspacePath: '/data/workspaces/test-session',
      });

      expect(containerId).toBe('test-container-id');
      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: 'claude-code-runner:test',
          name: 'claude-session-test-session',
          WorkingDir: '/workspace',
        })
      );
      expect(mockContainer.start).toHaveBeenCalled();
    });

    it('should return existing container ID if already running', async () => {
      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'existing-container-id',
          State: 'running',
        },
      ]);

      const containerId = await createAndStartContainer({
        sessionId: 'test-session',
        workspacePath: '/data/workspaces/test-session',
      });

      expect(containerId).toBe('existing-container-id');
      expect(mockDocker.createContainer).not.toHaveBeenCalled();
    });

    it('should start existing stopped container', async () => {
      const stoppedContainer = {
        ...mockContainer,
        id: 'stopped-container-id',
        start: vi.fn().mockResolvedValue(undefined),
      };
      mockDocker.listContainers.mockResolvedValue([
        {
          Id: 'stopped-container-id',
          State: 'exited',
        },
      ]);
      mockDocker.getContainer.mockReturnValue(stoppedContainer);

      const containerId = await createAndStartContainer({
        sessionId: 'test-session',
        workspacePath: '/data/workspaces/test-session',
      });

      expect(containerId).toBe('stopped-container-id');
      expect(stoppedContainer.start).toHaveBeenCalled();
      expect(mockDocker.createContainer).not.toHaveBeenCalled();
    });

    it('should configure git credentials when githubToken is provided', async () => {
      const mockStream = createMockStream();

      mockDocker.pull.mockImplementation(
        (_image: string, callback: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
          callback(null, mockStream as unknown as NodeJS.ReadableStream);
        }
      );
      mockDocker.modem.followProgress.mockImplementation(
        (
          _stream: NodeJS.ReadableStream,
          onFinish: (err: Error | null) => void,
          _onProgress: (event: { status?: string; progress?: string }) => void
        ) => {
          onFinish(null);
        }
      );
      mockDocker.listContainers.mockResolvedValue([]);

      // Mock exec for git credential configuration
      const credentialStream = createMockStream();
      mockExec.start.mockImplementation(() => {
        process.nextTick(() => credentialStream.emit('end'));
        return Promise.resolve(credentialStream);
      });

      await createAndStartContainer({
        sessionId: 'test-session',
        workspacePath: '/data/workspaces/test-session',
        githubToken: 'ghp_test_token',
      });

      // Should have GITHUB_TOKEN in env vars
      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: expect.arrayContaining(['GITHUB_TOKEN=ghp_test_token']),
        })
      );

      // Should have called exec multiple times for git credential setup
      expect(mockContainer.exec).toHaveBeenCalled();
    });

    it('should throw error on container creation failure', async () => {
      const mockStream = createMockStream();

      mockDocker.pull.mockImplementation(
        (_image: string, callback: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
          callback(null, mockStream as unknown as NodeJS.ReadableStream);
        }
      );
      mockDocker.modem.followProgress.mockImplementation(
        (
          _stream: NodeJS.ReadableStream,
          onFinish: (err: Error | null) => void,
          _onProgress: (event: { status?: string; progress?: string }) => void
        ) => {
          onFinish(null);
        }
      );
      mockDocker.listContainers.mockResolvedValue([]);
      mockDocker.createContainer.mockRejectedValue(new Error('Docker API error'));

      await expect(
        createAndStartContainer({
          sessionId: 'test-session',
          workspacePath: '/data/workspaces/test-session',
        })
      ).rejects.toThrow('Docker API error');
    });
  });

  describe('stopContainer', () => {
    it('should stop a running container', async () => {
      await stopContainer('test-container-id');

      expect(mockDocker.getContainer).toHaveBeenCalledWith('test-container-id');
      expect(mockContainer.stop).toHaveBeenCalledWith({ t: 10 });
    });

    it('should not throw if container is already stopped', async () => {
      mockContainer.stop.mockRejectedValue(new Error('container not running'));

      await expect(stopContainer('test-container-id')).resolves.not.toThrow();
    });

    it('should throw for other stop errors', async () => {
      mockContainer.stop.mockRejectedValue(new Error('Some other error'));

      await expect(stopContainer('test-container-id')).rejects.toThrow('Some other error');
    });
  });

  describe('removeContainer', () => {
    it('should stop and remove a container', async () => {
      await removeContainer('test-container-id');

      expect(mockContainer.stop).toHaveBeenCalledWith({ t: 5 });
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('should ignore stop errors and still attempt remove', async () => {
      mockContainer.stop.mockRejectedValue(new Error('stop error'));

      await removeContainer('test-container-id');

      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('should not throw if remove fails', async () => {
      mockContainer.remove.mockRejectedValue(new Error('remove error'));

      await expect(removeContainer('test-container-id')).resolves.not.toThrow();
    });
  });

  describe('execInContainer', () => {
    it('should execute a command and return stream', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const result = await execInContainer('test-container-id', ['ls', '-la']);

      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['ls', '-la'],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      expect(mockExec.start).toHaveBeenCalledWith({ Detach: false, Tty: false });
      expect(result.stream).toBe(mockStream);
      expect(result.execId).toBe('test-exec-id');
    });
  });

  describe('getContainerStatus', () => {
    it('should return running for a running container', async () => {
      mockContainer.inspect.mockResolvedValue({ State: { Running: true } });

      const status = await getContainerStatus('test-container-id');

      expect(status).toBe('running');
    });

    it('should return stopped for a stopped container', async () => {
      mockContainer.inspect.mockResolvedValue({ State: { Running: false } });

      const status = await getContainerStatus('test-container-id');

      expect(status).toBe('stopped');
    });

    it('should return not_found for non-existent container', async () => {
      mockContainer.inspect.mockRejectedValue(new Error('no such container'));

      const status = await getContainerStatus('test-container-id');

      expect(status).toBe('not_found');
    });
  });

  describe('sendSignalToExec', () => {
    it('should send a signal to a process', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);
      mockExec.inspect.mockResolvedValue({ ExitCode: 0 });

      const signalPromise = sendSignalToExec('test-container-id', 12345, 'INT');

      // Simulate stream end
      process.nextTick(() => mockStream.emit('end'));

      await signalPromise;

      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['kill', '-INT', '12345'],
        AttachStdout: true,
        AttachStderr: true,
      });
    });

    it('should handle stream errors gracefully', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const signalPromise = sendSignalToExec('test-container-id', 12345, 'TERM');

      // Simulate stream error
      process.nextTick(() => mockStream.emit('error', new Error('stream error')));

      // Should not throw
      await expect(signalPromise).resolves.not.toThrow();
    });
  });

  describe('signalProcessesByPattern', () => {
    it('should send signal to processes matching pattern', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);
      mockExec.inspect.mockResolvedValue({ ExitCode: 0 });

      const signalPromise = signalProcessesByPattern('test-container-id', 'claude', 'TERM');

      process.nextTick(() => mockStream.emit('end'));

      await signalPromise;

      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['pkill', '-TERM', '-f', 'claude'],
        AttachStdout: true,
        AttachStderr: true,
      });
    });
  });

  describe('killProcessesByPattern', () => {
    it('should call signalProcessesByPattern with TERM', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);
      mockExec.inspect.mockResolvedValue({ ExitCode: 0 });

      const killPromise = killProcessesByPattern('test-container-id', 'tail -f');

      process.nextTick(() => mockStream.emit('end'));

      await killPromise;

      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['pkill', '-TERM', '-f', 'tail -f'],
        AttachStdout: true,
        AttachStderr: true,
      });
    });
  });

  describe('findProcessInContainer', () => {
    it('should return PID when process is found', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const findPromise = findProcessInContainer('test-container-id', 'claude');

      // Simulate pgrep output with Docker stream header
      process.nextTick(() => {
        mockStream.emit('data', createDockerFrame(1, '12345\n'));
        mockStream.emit('end');
      });

      const pid = await findPromise;

      expect(pid).toBe(12345);
      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['pgrep', '-f', 'claude'],
        AttachStdout: true,
        AttachStderr: true,
      });
    });

    it('should return null when process is not found', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const findPromise = findProcessInContainer('test-container-id', 'nonexistent');

      process.nextTick(() => {
        mockStream.emit('data', createDockerFrame(1, ''));
        mockStream.emit('end');
      });

      const pid = await findPromise;

      expect(pid).toBeNull();
    });

    it('should return null on stream error', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const findPromise = findProcessInContainer('test-container-id', 'claude');

      process.nextTick(() => {
        mockStream.emit('error', new Error('stream error'));
      });

      const pid = await findPromise;

      expect(pid).toBeNull();
    });
  });

  describe('isProcessRunning', () => {
    it('should return true when process is found', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const runningPromise = isProcessRunning('test-container-id', 'claude');

      process.nextTick(() => {
        mockStream.emit('data', createDockerFrame(1, '12345\n'));
        mockStream.emit('end');
      });

      const isRunning = await runningPromise;

      expect(isRunning).toBe(true);
    });

    it('should return false when process is not found', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const runningPromise = isProcessRunning('test-container-id', 'nonexistent');

      process.nextTick(() => {
        mockStream.emit('data', createDockerFrame(1, ''));
        mockStream.emit('end');
      });

      const isRunning = await runningPromise;

      expect(isRunning).toBe(false);
    });
  });

  describe('execInContainerWithOutputFile', () => {
    it('should execute command with output redirected to file', async () => {
      mockExec.start.mockResolvedValue(undefined);

      const result = await execInContainerWithOutputFile(
        'test-container-id',
        ['claude', '-p', 'hello'],
        '/tmp/output.txt'
      );

      expect(result.execId).toBe('test-exec-id');
      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['sh', '-c', expect.stringContaining('/tmp/output.txt')],
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        User: 'claudeuser',
      });
      expect(mockExec.start).toHaveBeenCalledWith({ Detach: true, Tty: false });
    });
  });

  describe('getExecStatus', () => {
    it('should return running status for running exec', async () => {
      mockExec.inspect.mockResolvedValue({ Running: true, ExitCode: 0 });

      const status = await getExecStatus('test-exec-id');

      expect(status).toEqual({ running: true, exitCode: null });
    });

    it('should return exit code for completed exec', async () => {
      mockExec.inspect.mockResolvedValue({ Running: false, ExitCode: 0 });

      const status = await getExecStatus('test-exec-id');

      expect(status).toEqual({ running: false, exitCode: 0 });
    });

    it('should return non-zero exit code for failed exec', async () => {
      mockExec.inspect.mockResolvedValue({ Running: false, ExitCode: 1 });

      const status = await getExecStatus('test-exec-id');

      expect(status).toEqual({ running: false, exitCode: 1 });
    });
  });

  describe('tailFileInContainer', () => {
    it('should tail a file starting from a specific line', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const result = await tailFileInContainer('test-container-id', '/tmp/output.txt', 10);

      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['tail', '-n', '+11', '-f', '/tmp/output.txt'],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      expect(result.stream).toBe(mockStream);
      expect(result.execId).toBe('test-exec-id');
    });

    it('should default to starting from line 0', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      await tailFileInContainer('test-container-id', '/tmp/output.txt');

      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['tail', '-n', '+1', '-f', '/tmp/output.txt'],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    });
  });

  describe('readFileInContainer', () => {
    it('should read file contents', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const readPromise = readFileInContainer('test-container-id', '/tmp/test.txt');

      process.nextTick(() => {
        mockStream.emit('data', createDockerFrame(1, 'file contents here'));
        mockStream.emit('end');
      });

      const contents = await readPromise;

      expect(contents).toBe('file contents here');
      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['cat', '/tmp/test.txt'],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    });

    it('should handle stream errors', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const readPromise = readFileInContainer('test-container-id', '/tmp/test.txt');

      process.nextTick(() => {
        mockStream.emit('error', new Error('read error'));
      });

      await expect(readPromise).rejects.toThrow('read error');
    });
  });

  describe('countLinesInContainer', () => {
    it('should return line count', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const countPromise = countLinesInContainer('test-container-id', '/tmp/test.txt');

      process.nextTick(() => {
        mockStream.emit('data', createDockerFrame(1, '42 /tmp/test.txt\n'));
        mockStream.emit('end');
      });

      const count = await countPromise;

      expect(count).toBe(42);
      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['wc', '-l', '/tmp/test.txt'],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    });

    it('should return 0 for invalid output', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const countPromise = countLinesInContainer('test-container-id', '/tmp/test.txt');

      process.nextTick(() => {
        mockStream.emit('data', createDockerFrame(1, 'invalid output'));
        mockStream.emit('end');
      });

      const count = await countPromise;

      expect(count).toBe(0);
    });
  });

  describe('fileExistsInContainer', () => {
    it('should return true when file exists', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);
      mockExec.inspect.mockResolvedValue({ ExitCode: 0 });

      const existsPromise = fileExistsInContainer('test-container-id', '/tmp/test.txt');

      process.nextTick(() => {
        mockStream.emit('end');
      });

      const exists = await existsPromise;

      expect(exists).toBe(true);
      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['test', '-f', '/tmp/test.txt'],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    });

    it('should return false when file does not exist', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);
      mockExec.inspect.mockResolvedValue({ ExitCode: 1 });

      const existsPromise = fileExistsInContainer('test-container-id', '/tmp/nonexistent.txt');

      process.nextTick(() => {
        mockStream.emit('end');
      });

      const exists = await existsPromise;

      expect(exists).toBe(false);
    });

    it('should return false on inspect error', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);
      mockExec.inspect.mockRejectedValue(new Error('inspect error'));

      const existsPromise = fileExistsInContainer('test-container-id', '/tmp/test.txt');

      process.nextTick(() => {
        mockStream.emit('end');
      });

      const exists = await existsPromise;

      expect(exists).toBe(false);
    });

    it('should return false on stream error', async () => {
      const mockStream = createMockStream();

      mockExec.start.mockResolvedValue(mockStream);

      const existsPromise = fileExistsInContainer('test-container-id', '/tmp/test.txt');

      process.nextTick(() => {
        mockStream.emit('error', new Error('stream error'));
      });

      const exists = await existsPromise;

      expect(exists).toBe(false);
    });
  });

  // Note: Image pull error handling tests are not included here because
  // ensureImagePulled uses a module-level cache (lastPullTime) that persists
  // across tests. The pull is rate-limited and skipped if recently pulled,
  // making it difficult to test error scenarios after successful pulls.
  // The error handling code paths in ensureImagePulled are verified through
  // code review and manual testing.
});
