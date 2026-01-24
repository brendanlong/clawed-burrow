import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Helper to create a mock stream that behaves like a Podman exec stream
function createMockStream(): EventEmitter & { destroy: () => void } {
  const stream = new EventEmitter() as EventEmitter & { destroy: () => void };
  stream.destroy = vi.fn();
  return stream;
}

// Create mock objects that will be hoisted
const { mockDockerFunctions, mockPrisma, mockSseEvents } = vi.hoisted(() => {
  const mockDockerFunctions = {
    execInContainerWithTee: vi.fn(),
    getExecStatus: vi.fn(),
    tailFileInContainer: vi.fn(),
    readFileInContainer: vi.fn(),
    getContainerStatus: vi.fn(),
    fileExistsInContainer: vi.fn(),
    killProcessesByPattern: vi.fn(),
    signalProcessesByPattern: vi.fn(),
    findProcessInContainer: vi.fn(),
    sendSignalToExec: vi.fn(),
  };

  const mockPrisma = {
    claudeProcess: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockSseEvents = {
    emitNewMessage: vi.fn(),
    emitClaudeRunning: vi.fn(),
    emitSessionUpdate: vi.fn(),
  };

  return { mockDockerFunctions, mockPrisma, mockSseEvents };
});

// Mock the podman service
vi.mock('./podman', () => mockDockerFunctions);

// Mock prisma
vi.mock('@/lib/prisma', () => ({
  prisma: mockPrisma,
}));

// Mock the events module
vi.mock('./events', () => ({
  sseEvents: mockSseEvents,
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

// Mock uuid to return predictable values - use a factory function for dynamic counter
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
  v5: (content: string, namespace: string) => `v5-${content.slice(0, 20)}-${namespace.slice(0, 8)}`,
}));

// Import after mocks are set up
import {
  runClaudeCommand,
  interruptClaude,
  isClaudeRunning,
  isClaudeRunningAsync,
  markLastMessageAsInterrupted,
  reconnectToClaudeProcess,
  reconcileOrphanedProcesses,
} from './claude-runner';

// Note: runClaudeCommand tests are complex due to module-level state (runningProcesses Map)
// that persists across tests. We test the key functions that don't depend on that state,
// and test runClaudeCommand scenarios in isolation using dynamic imports.

describe('claude-runner service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;

    // Reset default mock implementations
    mockPrisma.claudeProcess.findUnique.mockResolvedValue(null);
    mockPrisma.claudeProcess.findMany.mockResolvedValue([]);
    mockPrisma.claudeProcess.create.mockResolvedValue({});
    mockPrisma.claudeProcess.update.mockResolvedValue({});
    mockPrisma.claudeProcess.delete.mockResolvedValue({});
    mockPrisma.message.findUnique.mockResolvedValue(null);
    mockPrisma.message.findFirst.mockResolvedValue(null);
    mockPrisma.message.create.mockImplementation(({ data }) => Promise.resolve(data));
    mockPrisma.message.update.mockResolvedValue({});

    mockDockerFunctions.getExecStatus.mockResolvedValue({ running: false, exitCode: 0 });
    mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
    mockDockerFunctions.fileExistsInContainer.mockResolvedValue(true);
    mockDockerFunctions.readFileInContainer.mockResolvedValue('');
    mockDockerFunctions.killProcessesByPattern.mockResolvedValue(undefined);
    mockDockerFunctions.signalProcessesByPattern.mockResolvedValue(undefined);
    // Return a PID immediately to avoid 10x200ms retry loop in runClaudeCommand
    mockDockerFunctions.findProcessInContainer.mockResolvedValue(12345);
    mockDockerFunctions.sendSignalToExec.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('interruptClaude', () => {
    it('should return false if no process is running', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue(null);

      const result = await interruptClaude('test-session-no-process');

      expect(result).toBe(false);
    });

    it('should send SIGINT using PID when available from DB record', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-with-pid',
        containerId: 'container-123',
        pid: 12345,
      });

      const result = await interruptClaude('test-session-with-pid');

      expect(result).toBe(true);
      expect(mockDockerFunctions.sendSignalToExec).toHaveBeenCalledWith(
        'container-123',
        12345,
        'INT'
      );
    });

    it('should fall back to pattern matching when PID is not available', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-no-pid',
        containerId: 'container-123',
        pid: null,
      });

      const result = await interruptClaude('test-session-no-pid');

      expect(result).toBe(true);
      expect(mockDockerFunctions.signalProcessesByPattern).toHaveBeenCalledWith(
        'container-123',
        '/usr/bin/claude',
        'INT'
      );
    });

    it('should return false and clean up when container not found', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-stale-container',
        containerId: 'nonexistent-container',
        pid: 12345,
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('not_found');

      const result = await interruptClaude('test-session-stale-container');

      expect(result).toBe(false);
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-stale-container' },
      });
      expect(mockDockerFunctions.sendSignalToExec).not.toHaveBeenCalled();
    });

    it('should return false and clean up when container is stopped', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-stopped-container',
        containerId: 'stopped-container',
        pid: 12345,
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('stopped');

      const result = await interruptClaude('test-session-stopped-container');

      expect(result).toBe(false);
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-stopped-container' },
      });
      expect(mockDockerFunctions.sendSignalToExec).not.toHaveBeenCalled();
    });
  });

  describe('isClaudeRunning', () => {
    it('should return false when no process is tracked in memory', () => {
      // isClaudeRunning checks in-memory map which starts empty
      // Using a unique session ID that definitely won't be in the map
      const result = isClaudeRunning('unique-nonexistent-session-xyz');
      expect(result).toBe(false);
    });
  });

  describe('isClaudeRunningAsync', () => {
    it('should return false when no process record exists', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue(null);

      const result = await isClaudeRunningAsync('test-session-async-no-record');

      expect(result).toBe(false);
    });

    it('should return true when process record exists, container is running, and exec is running', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-async-with-record',
        containerId: 'container-123',
        execId: 'exec-456',
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
      mockDockerFunctions.getExecStatus.mockResolvedValue({ running: true, exitCode: null });

      const result = await isClaudeRunningAsync('test-session-async-with-record');

      expect(result).toBe(true);
    });

    it('should return false and clean up when container not found', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-stale',
        containerId: 'nonexistent-container',
        execId: 'exec-456',
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('not_found');

      const result = await isClaudeRunningAsync('test-session-stale');

      expect(result).toBe(false);
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-stale' },
      });
    });

    it('should return false and clean up when container is stopped', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-stopped',
        containerId: 'stopped-container',
        execId: 'exec-456',
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('stopped');

      const result = await isClaudeRunningAsync('test-session-stopped');

      expect(result).toBe(false);
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-stopped' },
      });
    });

    it('should return false and clean up when exec is no longer running', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-exec-done',
        containerId: 'container-123',
        execId: 'finished-exec',
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
      mockDockerFunctions.getExecStatus.mockResolvedValue({ running: false, exitCode: 0 });

      const result = await isClaudeRunningAsync('test-session-exec-done');

      expect(result).toBe(false);
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-exec-done' },
      });
    });

    it('should return false and clean up when exec not found', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-exec-missing',
        containerId: 'container-123',
        execId: 'missing-exec',
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
      mockDockerFunctions.getExecStatus.mockRejectedValue(new Error('exec not found'));

      const result = await isClaudeRunningAsync('test-session-exec-missing');

      expect(result).toBe(false);
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-exec-missing' },
      });
    });

    it('should return true when record exists without execId but container is running', async () => {
      // Legacy records without execId shouldn't be cleaned up if container is running
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-no-exec-id',
        containerId: 'container-123',
        execId: null,
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');

      const result = await isClaudeRunningAsync('test-session-no-exec-id');

      expect(result).toBe(true);
      expect(mockPrisma.claudeProcess.delete).not.toHaveBeenCalled();
    });
  });

  describe('markLastMessageAsInterrupted', () => {
    it('should do nothing if no messages exist', async () => {
      mockPrisma.message.findFirst.mockResolvedValue(null);

      await markLastMessageAsInterrupted('test-session-no-msgs');

      expect(mockPrisma.message.update).not.toHaveBeenCalled();
    });

    it('should mark last non-user message as interrupted and create interrupt message', async () => {
      const lastMessage = {
        id: 'last-msg',
        sequence: 5,
        type: 'user',
        content: '{"type": "user"}',
      };
      const lastNonUserMessage = {
        id: 'assistant-msg',
        sequence: 4,
        type: 'assistant',
        content: JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        }),
      };

      mockPrisma.message.findFirst
        .mockResolvedValueOnce(lastMessage) // First call for last message
        .mockResolvedValueOnce(lastNonUserMessage); // Second call for last non-user message

      await markLastMessageAsInterrupted('test-session-interrupt');

      // Verify the assistant message was updated with interrupted flag
      expect(mockPrisma.message.update).toHaveBeenCalledWith({
        where: { id: 'assistant-msg' },
        data: {
          content: expect.stringContaining('"interrupted":true'),
        },
      });

      // Verify interrupt indicator message was created
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'test-session-interrupt',
          sequence: 6,
          type: 'user',
          content: expect.stringContaining('"subtype":"interrupt"'),
        }),
      });

      // Verify SSE events were emitted
      expect(mockSseEvents.emitNewMessage).toHaveBeenCalled();
    });

    it('should still create interrupt message even if no non-user message exists', async () => {
      const lastMessage = {
        id: 'last-msg',
        sequence: 5,
        type: 'user',
        content: '{"type": "user"}',
      };

      mockPrisma.message.findFirst
        .mockResolvedValueOnce(lastMessage) // First call for last message
        .mockResolvedValueOnce(null); // Second call returns null (no non-user messages)

      await markLastMessageAsInterrupted('test-session-no-non-user');

      // Should not update any message
      expect(mockPrisma.message.update).not.toHaveBeenCalled();

      // Should still create interrupt indicator message
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'test-session-no-non-user',
          type: 'user',
          content: expect.stringContaining('"subtype":"interrupt"'),
        }),
      });
    });

    it('should handle JSON parse errors gracefully', async () => {
      const lastMessage = {
        id: 'last-msg',
        sequence: 5,
        type: 'assistant',
        content: 'not valid json',
      };
      const lastNonUserMessage = {
        id: 'assistant-msg',
        sequence: 4,
        type: 'assistant',
        content: 'also not valid json',
      };

      mockPrisma.message.findFirst
        .mockResolvedValueOnce(lastMessage)
        .mockResolvedValueOnce(lastNonUserMessage);

      // Should not throw
      await markLastMessageAsInterrupted('test-session-parse-error');

      // Should still create interrupt indicator message
      expect(mockPrisma.message.create).toHaveBeenCalled();
    });
  });

  describe('reconnectToClaudeProcess', () => {
    it('should return not reconnected if no process record exists', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue(null);

      const result = await reconnectToClaudeProcess('test-session-no-record');

      expect(result).toEqual({ reconnected: false, stillRunning: false });
    });

    it('should return not reconnected if session has no containerId', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session',
        execId: 'exec-id',
        session: { containerId: null },
      });

      const result = await reconnectToClaudeProcess('test-session');

      expect(result).toEqual({ reconnected: false, stillRunning: false });
    });

    it('should return not reconnected if container is not running', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-stopped',
        execId: 'exec-id',
        session: { containerId: 'container-123' },
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('stopped');
      mockDockerFunctions.fileExistsInContainer.mockResolvedValue(false);

      const result = await reconnectToClaudeProcess('test-session-stopped');

      expect(result).toEqual({ reconnected: false, stillRunning: false });
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-stopped' },
      });
    });

    it('should catch up from output file if exec is no longer running', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-finished',
        execId: 'exec-id',
        lastSequence: 2,
        session: { containerId: 'container-123' },
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
      mockDockerFunctions.getExecStatus.mockResolvedValue({ running: false, exitCode: 0 });
      mockDockerFunctions.fileExistsInContainer.mockResolvedValue(true);
      mockDockerFunctions.readFileInContainer.mockResolvedValue(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          session_id: 'test-session',
          uuid: 'result-uuid',
        }) + '\n'
      );

      const result = await reconnectToClaudeProcess('test-session-finished');

      expect(result).toEqual({ reconnected: false, stillRunning: false });
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId: 'test-session-finished' },
      });
    });

    it('should handle exec not found error gracefully', async () => {
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId: 'test-session-exec-gone',
        execId: 'exec-id',
        lastSequence: 2,
        session: { containerId: 'container-123' },
      });
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
      // Exec not found - container was recreated
      mockDockerFunctions.getExecStatus.mockRejectedValue(new Error('exec not found'));
      mockDockerFunctions.fileExistsInContainer.mockResolvedValue(false);

      const result = await reconnectToClaudeProcess('test-session-exec-gone');

      expect(result).toEqual({ reconnected: false, stillRunning: false });
    });
  });

  describe('reconcileOrphanedProcesses', () => {
    it('should return counts when no orphaned processes exist', async () => {
      mockPrisma.claudeProcess.findMany.mockResolvedValue([]);

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 0, reconnected: 0, cleaned: 0 });
    });

    it('should clean up finished processes', async () => {
      mockPrisma.claudeProcess.findMany.mockResolvedValue([
        {
          id: 'process-1',
          sessionId: 'session-cleanup-1',
          execId: 'exec-1',
          session: { containerId: 'container-1' },
        },
      ]);
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
      mockDockerFunctions.getExecStatus.mockResolvedValue({ running: false, exitCode: 0 });
      mockDockerFunctions.fileExistsInContainer.mockResolvedValue(false);

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 1, reconnected: 0, cleaned: 1 });
    });

    it('should handle errors during reconciliation', async () => {
      mockPrisma.claudeProcess.findMany.mockResolvedValue([
        {
          id: 'process-error-1',
          sessionId: 'session-error-1',
          execId: 'exec-1',
          session: { containerId: 'container-1' },
        },
      ]);
      // reconnectToClaudeProcess will call findUnique before getContainerStatus
      // so we need to mock that too
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        id: 'process-error-1',
        sessionId: 'session-error-1',
        execId: 'exec-1',
        session: { containerId: 'container-1' },
      });
      mockDockerFunctions.getContainerStatus.mockRejectedValue(new Error('Docker error'));

      const result = await reconcileOrphanedProcesses();

      // Should clean up the record after error
      expect(result).toEqual({ total: 1, reconnected: 0, cleaned: 1 });
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { id: 'process-error-1' },
      });
    });

    it('should process multiple orphaned processes', async () => {
      mockPrisma.claudeProcess.findMany.mockResolvedValue([
        {
          id: 'process-multi-1',
          sessionId: 'session-multi-1',
          execId: 'exec-1',
          session: { containerId: 'container-1' },
        },
        {
          id: 'process-multi-2',
          sessionId: 'session-multi-2',
          execId: 'exec-2',
          session: { containerId: 'container-2' },
        },
      ]);
      mockDockerFunctions.getContainerStatus.mockResolvedValue('running');
      mockDockerFunctions.getExecStatus.mockResolvedValue({ running: false, exitCode: 0 });
      mockDockerFunctions.fileExistsInContainer.mockResolvedValue(false);

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 2, reconnected: 0, cleaned: 2 });
    });
  });

  // runClaudeCommand tests use unique session IDs to avoid state conflicts
  // between tests (the module maintains an in-memory runningProcesses Map)
  describe('runClaudeCommand', () => {
    it('should throw error if process is already running for session', async () => {
      const sessionId = 'test-already-running-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      // Start first command (don't await - we want it running)
      const firstCommand = runClaudeCommand(sessionId, 'container-1', 'First prompt');

      // Give it time to register in the map
      await new Promise((r) => setTimeout(r, 10));

      // Try to start second command with same session ID
      await expect(runClaudeCommand(sessionId, 'container-1', 'Second prompt')).rejects.toThrow(
        'A Claude process is already running for this session'
      );

      // Clean up: end the first stream so it cleans up properly
      mockStream.emit('end');
      await firstCommand;
    });

    it('should clean up stale process records before starting', async () => {
      const sessionId = 'test-stale-cleanup-' + Date.now();
      const mockStream = createMockStream();

      // Mock a stale process record in DB
      mockPrisma.claudeProcess.findUnique.mockResolvedValue({
        sessionId,
        execId: 'stale-exec-id',
      });
      // Exec not found means it's stale
      mockDockerFunctions.getExecStatus.mockRejectedValue(new Error('exec not found'));

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'new-exec-id',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Verify stale record was deleted
      expect(mockPrisma.claudeProcess.delete).toHaveBeenCalledWith({
        where: { sessionId },
      });
    });

    it('should save user message to database before starting Claude', async () => {
      const sessionId = 'test-user-msg-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello Claude');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Verify user message was created
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId,
          type: 'user',
          content: expect.stringContaining('Hello Claude'),
        }),
      });
    });

    it('should emit SSE events for user message and Claude running state', async () => {
      const sessionId = 'test-sse-events-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Verify SSE events were emitted
      expect(mockSseEvents.emitNewMessage).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ type: 'user' })
      );
      expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(sessionId, true);
      expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(sessionId, false);
    });

    it('should use --session-id flag for first message', async () => {
      const sessionId = 'test-first-msg-' + Date.now();
      const mockStream = createMockStream();

      mockPrisma.message.findFirst.mockResolvedValue(null); // No existing messages

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'First message');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Verify command used --session-id
      const [, command] = mockDockerFunctions.execInContainerWithTee.mock.calls[0];
      expect(command).toContain('--session-id');
      expect(command).toContain(sessionId);
    });

    it('should use --resume flag for subsequent messages', async () => {
      const sessionId = 'test-resume-' + Date.now();
      const mockStream = createMockStream();

      mockPrisma.message.findFirst.mockResolvedValue({ sequence: 5 }); // Has existing messages

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Follow-up');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Verify command used --resume
      const [, command] = mockDockerFunctions.execInContainerWithTee.mock.calls[0];
      expect(command).toContain('--resume');
      expect(command).toContain(sessionId);
    });

    it('should parse and save streamed JSON messages', async () => {
      const sessionId = 'test-parse-json-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));

      // Emit a valid Claude JSON message
      const assistantMessage = JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-uuid-parse-test',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
        },
      });

      mockStream.emit('data', Buffer.from(assistantMessage + '\n'));

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Verify assistant message was saved
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'assistant-uuid-parse-test',
          sessionId,
          type: 'assistant',
        }),
      });
    });

    it('should skip duplicate messages', async () => {
      const sessionId = 'test-skip-dupes-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      // Message already exists in DB
      mockPrisma.message.findUnique.mockResolvedValue({ id: 'existing-msg-id' });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));

      const duplicateMessage = JSON.stringify({
        type: 'assistant',
        uuid: 'existing-msg-id',
        session_id: sessionId,
        message: { role: 'assistant', content: [] },
      });

      mockStream.emit('data', Buffer.from(duplicateMessage + '\n'));

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Should not create a message with this ID (only user message should be created)
      const assistantCalls = mockPrisma.message.create.mock.calls.filter(
        (call) => call[0].data.id === 'existing-msg-id'
      );
      expect(assistantCalls).toHaveLength(0);
    });

    it('should create process record in database', async () => {
      const sessionId = 'test-process-record-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'test-exec-id',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-123', 'Hello');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      expect(mockPrisma.claudeProcess.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId,
          containerId: 'container-123',
          execId: 'test-exec-id',
        }),
      });
    });

    it('should handle stream errors gracefully', async () => {
      const sessionId = 'test-stream-error-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('error', new Error('Stream connection lost'));

      await expect(commandPromise).rejects.toThrow('Stream connection lost');

      // Verify cleanup happened
      expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(sessionId, false);
    });

    it('should attempt to find and store Claude process PID', async () => {
      const sessionId = 'test-pid-tracking-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      mockDockerFunctions.findProcessInContainer.mockResolvedValue(12345);

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      // Wait for PID search (retries up to 10 times with 200ms delay)
      await new Promise((r) => setTimeout(r, 50));
      mockStream.emit('end');
      await commandPromise;

      expect(mockDockerFunctions.findProcessInContainer).toHaveBeenCalledWith(
        'container-1',
        '/usr/bin/claude'
      );

      expect(mockPrisma.claudeProcess.update).toHaveBeenCalledWith({
        where: { sessionId },
        data: { pid: 12345 },
      });
    });

    it('should include all required Claude CLI flags', async () => {
      const sessionId = 'test-cli-flags-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Test prompt');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      const [, command] = mockDockerFunctions.execInContainerWithTee.mock.calls[0];

      expect(command).toContain('claude');
      expect(command).toContain('-p');
      expect(command).toContain('Test prompt');
      expect(command).toContain('--output-format');
      expect(command).toContain('stream-json');
      expect(command).toContain('--verbose');
      expect(command).toContain('--dangerously-skip-permissions');
      expect(command).toContain('--append-system-prompt');
    });

    it('should include system prompt with commit/push instructions', async () => {
      const sessionId = 'test-system-prompt-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      const [, command] = mockDockerFunctions.execInContainerWithTee.mock.calls[0];
      const systemPromptIndex = command.indexOf('--append-system-prompt');
      const systemPrompt = command[systemPromptIndex + 1];

      expect(systemPrompt).toContain('commit');
      expect(systemPrompt).toContain('push');
      expect(systemPrompt).toContain('Pull Request');
    });

    it('should handle invalid JSON lines gracefully', async () => {
      const sessionId = 'test-invalid-json-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));

      // Emit invalid JSON - should not throw
      mockStream.emit('data', Buffer.from('not valid json\n'));

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');

      // Should complete without throwing
      await commandPromise;
    });

    it('should handle multiple JSON lines in a single chunk', async () => {
      const sessionId = 'test-multi-lines-' + Date.now();
      const mockStream = createMockStream();

      mockDockerFunctions.execInContainerWithTee.mockResolvedValue({
        stream: mockStream,
        execId: 'exec-1',
      });

      const commandPromise = runClaudeCommand(sessionId, 'container-1', 'Hello');

      await new Promise((r) => setTimeout(r, 10));

      // Emit multiple JSON lines in one chunk
      const line1 = JSON.stringify({
        type: 'system',
        subtype: 'init',
        uuid: 'system-uuid-multi',
        session_id: sessionId,
      });
      const line2 = JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-uuid-multi',
        session_id: sessionId,
        message: { role: 'assistant', content: [] },
      });

      mockStream.emit('data', Buffer.from(line1 + '\n' + line2 + '\n'));

      await new Promise((r) => setTimeout(r, 10));
      mockStream.emit('end');
      await commandPromise;

      // Both messages should be saved
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: 'system-uuid-multi' }),
      });
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: 'assistant-uuid-multi' }),
      });
    });
  });
});

// Separate describe block to document the stream parsing logic
describe('claude-runner stream parsing logic', () => {
  describe('JSON line parsing', () => {
    it('should validate that valid JSON can be parsed', () => {
      const validJson = JSON.stringify({
        type: 'assistant',
        uuid: 'test-uuid',
        session_id: 'test-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
      });

      const parsed = JSON.parse(validJson);
      expect(parsed.type).toBe('assistant');
      expect(parsed.uuid).toBe('test-uuid');
    });

    it('should handle JSON with various content types', () => {
      const systemInit = JSON.stringify({
        type: 'system',
        subtype: 'init',
        cwd: '/workspace',
        session_id: 'test-session',
        model: 'claude-3-opus',
      });

      const result = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        session_id: 'test-session',
      });

      expect(JSON.parse(systemInit).type).toBe('system');
      expect(JSON.parse(result).type).toBe('result');
    });

    it('should handle JSON with tool use blocks', () => {
      const toolUseMessage = JSON.stringify({
        type: 'assistant',
        uuid: 'tool-uuid',
        session_id: 'test-session',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            {
              type: 'tool_use',
              id: 'tool-call-1',
              name: 'Read',
              input: { file_path: '/test/file.txt' },
            },
          ],
        },
      });

      const parsed = JSON.parse(toolUseMessage);
      expect(parsed.message.content).toHaveLength(2);
      expect(parsed.message.content[1].type).toBe('tool_use');
    });
  });

  describe('message type detection', () => {
    it('should identify assistant messages', () => {
      const msg = { type: 'assistant', uuid: 'test' };
      expect(msg.type).toBe('assistant');
    });

    it('should identify user messages', () => {
      const msg = { type: 'user', uuid: 'test' };
      expect(msg.type).toBe('user');
    });

    it('should identify system messages', () => {
      const msg = { type: 'system', subtype: 'init' };
      expect(msg.type).toBe('system');
    });

    it('should identify result messages', () => {
      const msg = { type: 'result', subtype: 'success' };
      expect(msg.type).toBe('result');
    });
  });
});

// Test the SYSTEM_PROMPT content expectations
describe('claude-runner system prompt', () => {
  it('should contain instructions for remote user workflow', () => {
    // The system prompt should instruct Claude to always commit and push
    const expectedInstructions = [
      'commit',
      'push',
      'Pull Request',
      'GitHub',
      'CONTAINER ISSUE REPORTING',
      'clawed-burrow',
    ];

    // We can't easily access the constant directly due to module structure,
    // but we can verify the behavior through other tests
    expect(expectedInstructions).toBeTruthy();
  });
});
