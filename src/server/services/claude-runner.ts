import {
  execInContainerToFile,
  getExecStatus,
  tailFileInContainer,
  readFileInContainer,
  getContainerStatus,
  getContainerState,
  getContainerLogs,
  fileExistsInContainer,
  killProcessesByPattern,
  signalProcessesByPattern,
  findProcessInContainer,
  sendSignalToExec,
  isErrorExitCode,
  describeExitCode,
} from './podman';
import { prisma } from '@/lib/prisma';
import { getMessageType } from '@/lib/claude-messages';
import { v4 as uuid, v5 as uuidv5 } from 'uuid';
import { sseEvents } from './events';
import { createLogger, toError } from '@/lib/logger';

// Namespace UUID for generating deterministic IDs from error line content
const ERROR_LINE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Track running Claude processes per session (in-memory for quick lookups)
// The DB is the source of truth; this is for performance
const runningProcesses = new Map<string, { containerId: string; pid: number | null }>();

// Track active stream processors to avoid duplicate processing
const activeStreamProcessors = new Set<string>();

const OUTPUT_FILE_PREFIX = '.claude-output-';

// Pattern to match the actual claude CLI process, but not tail commands watching .claude-output files
// Using /usr/bin/claude because that's the installed path and won't match other processes
const CLAUDE_PROCESS_PATTERN = '/usr/bin/claude';

// System prompt appended to all Claude sessions to ensure proper workflow
// Since users interact through GitHub PRs (no local access), Claude must always
// commit, push, and open PRs for any changes to be visible
const SYSTEM_PROMPT = `IMPORTANT: The user is accessing this session remotely through a web interface and has no local access to the files. They can only see your changes through GitHub. Therefore, you MUST follow this workflow for ANY code changes:

1. Always commit your changes with clear, descriptive commit messages
2. Always push your commits to the remote repository
3. If you're working on a new branch or the changes would benefit from review, open a Pull Request using the GitHub CLI (gh pr create)
4. If a PR already exists for the current branch, just push to update it

Never leave uncommitted or unpushed changes - the user cannot see them otherwise.

CONTAINER ENVIRONMENT: This container uses Podman for container operations (not Docker). Use \`podman\` and \`podman-compose\` commands for container management. Aliases for \`docker\` and \`docker-compose\` are available and will work, but prefer using the podman commands directly. You have passwordless sudo access for installing additional packages if needed.

CONTAINER ISSUE REPORTING: This container should have all standard development tools pre-installed and properly configured. If you encounter missing tools, misconfigured environments, or other container setup issues that prevent you from completing tasks:

1. First, check if the issue has already been reported by searching existing issues: \`gh issue list --repo brendanlong/clawed-burrow --search "<issue description>" --state all\`
2. If no existing issue matches, report it to the clawed-burrow repository: \`gh issue create --repo brendanlong/clawed-burrow --title "<brief description>" --body "<detailed description of the problem and what you were trying to do>" --label bug --label reported-by-claude\`
3. Then continue with your task using workarounds if possible, or inform the user that the task cannot be completed due to the container issue.`;

const log = createLogger('claude-runner');

// =============================================================================
// Partial Message Tracking for Stream Events
// =============================================================================

/**
 * Represents a content block being accumulated from stream events.
 * Tracks text or tool_use blocks as they stream in.
 */
interface PartialContentBlock {
  type: 'text' | 'tool_use';
  // For text blocks
  text?: string;
  // For tool_use blocks
  id?: string;
  name?: string;
  input?: string; // JSON string being accumulated
}

/**
 * Tracks a partial message being built from stream events.
 * Used to accumulate content_block_delta events until the message is complete.
 */
interface PartialMessage {
  messageId: string; // The msg_xxx ID from message_start
  sessionId: string;
  sequence: number;
  model?: string;
  contentBlocks: PartialContentBlock[];
  lastUpdated: number;
}

/**
 * Tracks partial messages per session.
 * Key is the sessionId, value is the current partial message being accumulated.
 */
const partialMessages = new Map<string, PartialMessage>();

/**
 * Process a stream_event line and update the partial message state.
 * Returns a partial assistant message if there's content to display, null otherwise.
 */
function processStreamEvent(
  sessionId: string,
  parsed: { type: 'stream_event'; event: unknown; session_id: string; uuid: string }
): { messageId: string; content: unknown } | null {
  const event = parsed.event as Record<string, unknown>;
  const eventType = event.type as string;

  switch (eventType) {
    case 'message_start': {
      // Start of a new message - initialize tracking
      const message = event.message as Record<string, unknown>;
      const messageId = message.id as string;
      const model = message.model as string | undefined;

      partialMessages.set(sessionId, {
        messageId,
        sessionId,
        sequence: -1, // Will be assigned when we emit
        model,
        contentBlocks: [],
        lastUpdated: Date.now(),
      });
      return null;
    }

    case 'content_block_start': {
      // Start of a new content block (text or tool_use)
      const partial = partialMessages.get(sessionId);
      if (!partial) return null;

      const index = event.index as number;
      const contentBlock = event.content_block as Record<string, unknown>;
      const blockType = contentBlock.type as string;

      // Ensure array is large enough
      while (partial.contentBlocks.length <= index) {
        partial.contentBlocks.push({ type: 'text', text: '' });
      }

      if (blockType === 'text') {
        partial.contentBlocks[index] = {
          type: 'text',
          text: (contentBlock.text as string) || '',
        };
      } else if (blockType === 'tool_use') {
        partial.contentBlocks[index] = {
          type: 'tool_use',
          id: contentBlock.id as string,
          name: contentBlock.name as string,
          input: '',
        };
      }

      partial.lastUpdated = Date.now();
      return buildPartialAssistantMessage(partial);
    }

    case 'content_block_delta': {
      // Incremental update to a content block
      const partial = partialMessages.get(sessionId);
      if (!partial) return null;

      const index = event.index as number;
      const delta = event.delta as Record<string, unknown>;
      const deltaType = delta.type as string;

      if (index >= partial.contentBlocks.length) return null;

      const block = partial.contentBlocks[index];

      if (deltaType === 'text_delta' && block.type === 'text') {
        block.text = (block.text || '') + (delta.text as string);
      } else if (deltaType === 'input_json_delta' && block.type === 'tool_use') {
        block.input = (block.input || '') + (delta.partial_json as string);
      }

      partial.lastUpdated = Date.now();
      return buildPartialAssistantMessage(partial);
    }

    case 'content_block_stop': {
      // A content block is complete - emit current state
      const partial = partialMessages.get(sessionId);
      if (!partial) return null;
      return buildPartialAssistantMessage(partial);
    }

    case 'message_delta': {
      // Message-level update (e.g., stop_reason) - not needed for display
      return null;
    }

    case 'message_stop': {
      // Message complete - clean up partial state
      // The full message will come in a separate 'assistant' event
      partialMessages.delete(sessionId);
      return null;
    }

    default:
      return null;
  }
}

/**
 * Build a partial assistant message from accumulated content blocks.
 * This creates a message structure that matches the final assistant message format.
 */
function buildPartialAssistantMessage(
  partial: PartialMessage
): { messageId: string; content: unknown } | null {
  // Only emit if we have some content
  const hasContent = partial.contentBlocks.some((block) => {
    if (block.type === 'text') return block.text && block.text.length > 0;
    if (block.type === 'tool_use') return block.name; // Tool use just needs name to be useful
    return false;
  });

  if (!hasContent) return null;

  // Build content blocks in the format expected by the frontend
  const contentBlocks = partial.contentBlocks
    .map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text || '' };
      } else if (block.type === 'tool_use') {
        // Parse the accumulated JSON input, or use empty object if incomplete
        let input: Record<string, unknown> = {};
        if (block.input) {
          try {
            input = JSON.parse(block.input);
          } catch {
            // JSON is incomplete - use what we have as a string for display
            input = { _partial: block.input };
          }
        }
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input,
        };
      }
      return null;
    })
    .filter(Boolean);

  const content = {
    type: 'assistant',
    message: {
      model: partial.model,
      id: partial.messageId,
      type: 'message',
      role: 'assistant',
      content: contentBlocks,
      stop_reason: null,
    },
    session_id: partial.sessionId,
    uuid: partial.messageId, // Use messageId as uuid for consistency
    _partial: true, // Mark as partial for debugging/display purposes
  };

  return { messageId: partial.messageId, content };
}

/**
 * Check if a parsed JSON object is a stream_event.
 */
function isStreamEvent(
  parsed: unknown
): parsed is { type: 'stream_event'; event: unknown; session_id: string; uuid: string } {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>).type === 'stream_event'
  );
}

// =============================================================================
// End of Partial Message Tracking
// =============================================================================

/**
 * Create and save a system error message for display to the user.
 * Used when Claude process fails unexpectedly.
 */
async function createErrorMessage(
  sessionId: string,
  errorText: string,
  details?: {
    exitCode?: number | null;
    containerLogs?: string | null;
  }
): Promise<void> {
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  const sequence = (lastMessage?.sequence ?? -1) + 1;
  const errorId = uuidv5(`${sessionId}:error:${Date.now()}:${errorText}`, ERROR_LINE_NAMESPACE);

  // Build detailed error content
  let fullText = errorText;
  if (details?.exitCode !== undefined && details.exitCode !== null && details.exitCode !== 0) {
    fullText += `\n\nExit code: ${details.exitCode} (${describeExitCode(details.exitCode)})`;
  }
  if (details?.containerLogs) {
    // Truncate logs if too long
    const maxLogLength = 2000;
    const logs =
      details.containerLogs.length > maxLogLength
        ? details.containerLogs.slice(-maxLogLength) + '\n...(truncated)'
        : details.containerLogs;
    fullText += `\n\nContainer logs:\n${logs}`;
  }

  const errorContent = {
    type: 'system',
    subtype: 'error',
    content: [{ type: 'text', text: fullText }],
  };

  try {
    const message = await prisma.message.create({
      data: {
        id: errorId,
        sessionId,
        sequence,
        type: 'system',
        content: JSON.stringify(errorContent),
      },
    });

    sseEvents.emitNewMessage(sessionId, {
      id: message.id,
      sessionId,
      sequence,
      type: 'system',
      content: errorContent,
      createdAt: message.createdAt,
    });

    log.info('Created error message', { sessionId, errorId, sequence });
  } catch (err) {
    // Ignore duplicate errors
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return;
    }
    log.error('Failed to create error message', toError(err), { sessionId });
  }
}

/**
 * Check container health and create error message if container has failed.
 * Returns true if container is healthy, false if it has failed.
 */
async function checkContainerHealthAndReport(
  sessionId: string,
  containerId: string
): Promise<boolean> {
  const containerState = await getContainerState(containerId);

  if (containerState.status === 'not_found') {
    log.error('Container not found during health check', undefined, {
      sessionId,
      containerId,
    });

    await createErrorMessage(sessionId, 'Container was terminated unexpectedly.', {
      exitCode: null,
    });
    return false;
  }

  if (containerState.status === 'stopped') {
    log.error('Container stopped unexpectedly', undefined, {
      sessionId,
      containerId,
      exitCode: containerState.exitCode,
      error: containerState.error,
      oomKilled: containerState.oomKilled,
    });

    let errorText = 'Container stopped unexpectedly.';
    if (containerState.oomKilled) {
      errorText = 'Container was killed due to out of memory.';
    } else if (containerState.error) {
      errorText = `Container stopped with error: ${containerState.error}`;
    }

    const containerLogs = await getContainerLogs(containerId, { tail: 50 });
    await createErrorMessage(sessionId, errorText, {
      exitCode: containerState.exitCode,
      containerLogs,
    });
    return false;
  }

  return true;
}

/**
 * Result of attempting to save a message line to the database.
 */
type SaveMessageResult =
  | {
      saved: true;
      sequence: number;
      message: {
        id: string;
        sessionId: string;
        sequence: number;
        type: string;
        content: unknown;
        createdAt: Date;
      };
    }
  | { saved: false; reason: 'parse_error' | 'duplicate' | 'stream_event' };

/**
 * Parse a JSON line and save it as a message if it doesn't already exist.
 * Returns the saved message with parsed content if saved, or info about why it was skipped.
 */
async function saveMessageIfNotExists(
  sessionId: string,
  line: string,
  sequence: number
): Promise<SaveMessageResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { saved: false, reason: 'parse_error' };
  }

  // Stream events are not saved to DB - they're handled separately for partial updates
  if (isStreamEvent(parsed)) {
    return { saved: false, reason: 'stream_event' };
  }

  const messageType = getMessageType(parsed);
  // Extract message ID - try different locations based on message type
  // For assistant messages, prefer message.id (the Anthropic message ID) so that
  // partial messages and final messages use the same ID for client-side replacement.
  // Other message types use uuid or id as before.
  const parsedObj = parsed as {
    uuid?: string;
    id?: string;
    message?: { id?: string };
    type?: string;
  };
  let msgId: string;
  if (parsedObj.type === 'assistant' && parsedObj.message?.id) {
    // For assistant messages, use the Anthropic message ID for consistency with partial messages
    msgId = parsedObj.message.id;
  } else {
    // For other messages, use uuid, id, or generate one
    msgId = parsedObj.uuid || parsedObj.id || uuid();
  }

  // Check if message already exists (can happen after server restart)
  const existing = await prisma.message.findUnique({
    where: { id: msgId },
    select: { id: true },
  });
  if (existing) {
    return { saved: false, reason: 'duplicate' };
  }

  try {
    const message = await prisma.message.create({
      data: {
        id: msgId,
        sessionId,
        sequence,
        type: messageType,
        content: line,
      },
    });

    return { saved: true, sequence, message: { ...message, content: parsed } };
  } catch (err) {
    // Handle unique constraint violation on (sessionId, sequence)
    // This can happen in race conditions when processing the same output file
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return { saved: false, reason: 'duplicate' };
    }
    throw err;
  }
}

/**
 * Process a line from Claude's output, handling both regular messages and stream events.
 * Stream events are processed to emit partial message updates via SSE.
 * Regular messages are saved to the database and emitted via SSE.
 *
 * @returns The new sequence number (incremented if a message was saved)
 */
async function processOutputLine(
  sessionId: string,
  line: string,
  sequence: number
): Promise<{ newSequence: number; saved: boolean }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    log.warn('processOutputLine: Failed to parse JSON', {
      sessionId,
      line: line.slice(0, 100),
    });
    return { newSequence: sequence, saved: false };
  }

  // Handle stream_event messages for partial updates
  if (isStreamEvent(parsed)) {
    const partialResult = processStreamEvent(sessionId, parsed);

    if (partialResult) {
      // Emit partial message update via SSE
      // We use a temporary sequence number (-1) since this isn't saved to DB
      // The client will use the message ID for deduplication/replacement
      sseEvents.emitNewMessage(sessionId, {
        id: partialResult.messageId,
        sessionId,
        sequence: -1, // Temporary, will be replaced by final message
        type: 'assistant',
        content: partialResult.content,
        createdAt: new Date(),
      });
    }

    return { newSequence: sequence, saved: false };
  }

  // Handle regular messages - save to DB
  const result = await saveMessageIfNotExists(sessionId, line, sequence);
  if (result.saved) {
    log.debug('processOutputLine: Saved message', { sessionId, sequence: result.sequence });
    sseEvents.emitNewMessage(sessionId, result.message);
    return { newSequence: result.sequence + 1, saved: true };
  } else if (result.reason === 'parse_error') {
    log.warn('processOutputLine: Failed to parse JSON', {
      sessionId,
      line: line.slice(0, 100),
    });
  }

  return { newSequence: sequence, saved: false };
}

function getOutputFileName(sessionId: string): string {
  return `${OUTPUT_FILE_PREFIX}${sessionId}.jsonl`;
}

function getOutputFilePath(sessionId: string): string {
  // Put output file in /tmp to avoid cluttering the workspace with untracked files
  return `/tmp/${getOutputFileName(sessionId)}`;
}

export async function runClaudeCommand(
  sessionId: string,
  containerId: string,
  prompt: string
): Promise<void> {
  log.info('runClaudeCommand: Starting', { sessionId, containerId, promptLength: prompt.length });

  // Check if session already has a running process (in-memory check first for speed)
  if (runningProcesses.has(sessionId)) {
    log.warn('runClaudeCommand: Process already running in memory', { sessionId });
    throw new Error('A Claude process is already running for this session');
  }

  // Check DB for persistent record
  const existingProcess = await prisma.claudeProcess.findUnique({
    where: { sessionId },
  });
  if (existingProcess) {
    // Check if it's actually still running
    try {
      const status = await getExecStatus(existingProcess.execId);
      if (status.running) {
        throw new Error('A Claude process is already running for this session');
      }
    } catch {
      // Exec not found, clean up stale record
    }
    await prisma.claudeProcess.delete({ where: { sessionId } });
  }

  // Verify the container is still running before trying to exec
  const containerStatus = await getContainerStatus(containerId);
  if (containerStatus !== 'running') {
    log.error('runClaudeCommand: Container not running', undefined, {
      sessionId,
      containerId,
      containerStatus,
    });
    throw new Error(
      `Cannot execute Claude command: container is ${containerStatus === 'not_found' ? 'not found' : 'stopped'}`
    );
  }

  // Get the next sequence number for this session
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  let sequence = (lastMessage?.sequence ?? -1) + 1;

  // Store the user prompt first
  const userMessageId = uuid();
  const userMessageSequence = sequence++;
  const userMessageContent = { type: 'user', content: prompt };
  await prisma.message.create({
    data: {
      id: userMessageId,
      sessionId,
      sequence: userMessageSequence,
      type: 'user',
      content: JSON.stringify(userMessageContent),
    },
  });

  // Emit SSE event for the user message so client can update immediately
  sseEvents.emitNewMessage(sessionId, {
    id: userMessageId,
    sessionId,
    sequence: userMessageSequence,
    type: 'user',
    content: userMessageContent,
    createdAt: new Date(),
  });

  // Build the Claude command
  // Use --resume for subsequent messages, --session-id for the first
  const isFirstMessage = !lastMessage;
  const command = [
    'claude',
    '-p',
    prompt,
    ...(isFirstMessage ? ['--session-id', sessionId] : ['--resume', sessionId]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages', // Stream within-message updates
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    SYSTEM_PROMPT,
  ];

  const outputFile = getOutputFilePath(sessionId);

  // Start Claude with output redirected to file
  // This avoids the blocking issue where pipes back up when the service disconnects
  log.info('runClaudeCommand: Executing command in container', { command, outputFile });
  const { execId, errorStream } = await execInContainerToFile(containerId, command, outputFile);
  log.info('runClaudeCommand: Command started with file redirect', { sessionId, execId });

  // Collect any startup/redirect errors from the error stream
  let startupError = '';
  errorStream.on('data', (chunk: Buffer) => {
    startupError += chunk.toString('utf-8');
  });

  // Create persistent record for crash recovery
  await prisma.claudeProcess.create({
    data: {
      sessionId,
      containerId,
      execId,
      outputFile: getOutputFileName(sessionId),
      lastSequence: sequence - 1,
    },
  });

  runningProcesses.set(sessionId, { containerId, pid: null });
  log.info('runClaudeCommand: Process registered', { sessionId });

  // Emit Claude running event
  sseEvents.emitClaudeRunning(sessionId, true);

  try {
    // Find and store the PID of the Claude process for direct signal delivery
    // Retry a few times since the process may take a moment to start
    let pid: number | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      pid = await findProcessInContainer(containerId, CLAUDE_PROCESS_PATTERN);
      if (pid) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (pid) {
      log.debug('runClaudeCommand: Found Claude process PID', { sessionId, pid });
      runningProcesses.set(sessionId, { containerId, pid });
      await prisma.claudeProcess.update({
        where: { sessionId },
        data: { pid },
      });
    } else {
      log.warn('runClaudeCommand: Could not find Claude process PID', { sessionId });
    }

    // Wait for output file to exist (with timeout)
    let fileExists = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      fileExists = await fileExistsInContainer(containerId, outputFile);
      if (fileExists) break;

      // Check for startup errors
      if (startupError.trim()) {
        throw new Error(`Claude command failed to start: ${startupError.trim()}`);
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    if (!fileExists) {
      // Check one more time for startup errors
      if (startupError.trim()) {
        throw new Error(`Claude command failed to start: ${startupError.trim()}`);
      }
      throw new Error('Output file was not created - command may have failed to start');
    }

    // Tail the output file for actual claude output
    const { stream: tailStream } = await tailFileInContainer(containerId, outputFile, 0);

    let buffer = '';
    let totalLines = 0;
    let finalExitCode: number | null = null;

    // Process output by tailing the file and polling exec status
    await new Promise<void>((resolve, reject) => {
      tailStream.on('data', async (chunk: Buffer) => {
        const data = chunk.toString('utf-8');
        buffer += data;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          totalLines++;

          const result = await processOutputLine(sessionId, line, sequence);
          if (result.saved) {
            sequence = result.newSequence;
            // Update last processed sequence for recovery
            await prisma.claudeProcess
              .update({ where: { sessionId }, data: { lastSequence: sequence - 1 } })
              .catch(() => {});
          }
        }
      });

      tailStream.on('error', (err) => {
        log.error('runClaudeCommand: Tail stream error', toError(err), { sessionId });
        reject(err);
      });

      // Poll exec status to detect when the command completes
      const pollInterval = setInterval(async () => {
        try {
          const status = await getExecStatus(execId);

          if (!status.running) {
            clearInterval(pollInterval);
            finalExitCode = status.exitCode;

            // Give tail a moment to catch up with final output
            await new Promise((r) => setTimeout(r, 500));
            tailStream.destroy();

            // Read any remaining content from the file
            try {
              const fileContent = await readFileInContainer(containerId, outputFile);
              const allLines = fileContent.split('\n').filter((l) => l.trim());

              for (let i = totalLines; i < allLines.length; i++) {
                const line = allLines[i];
                const result = await processOutputLine(sessionId, line, sequence);
                if (result.saved) {
                  sequence = result.newSequence;
                }
                totalLines++;
              }
            } catch (err) {
              log.warn('runClaudeCommand: Failed to read remaining content', {
                sessionId,
                error: toError(err).message,
              });
            }

            log.info('runClaudeCommand: Completed', {
              sessionId,
              totalLines,
              exitCode: finalExitCode,
            });

            resolve();
          }
        } catch (err) {
          clearInterval(pollInterval);
          reject(err);
        }
      }, 1000);
    });

    // Check for process errors after stream completes
    if (isErrorExitCode(finalExitCode)) {
      // Check if container is still healthy
      const containerHealthy = await checkContainerHealthAndReport(sessionId, containerId);

      if (containerHealthy) {
        // Container is fine, so this is a Claude process error
        // Exit code 130 (SIGINT) is expected for interrupts
        if (finalExitCode !== 130) {
          log.error('Claude process failed', undefined, {
            sessionId,
            exitCode: finalExitCode,
            exitDescription: describeExitCode(finalExitCode),
          });

          // Get container logs for context
          const containerLogs = await getContainerLogs(containerId, { tail: 30 });
          await createErrorMessage(
            sessionId,
            `Claude process exited unexpectedly: ${describeExitCode(finalExitCode)}`,
            { exitCode: finalExitCode, containerLogs }
          );
        }
      }
    }
  } finally {
    runningProcesses.delete(sessionId);
    await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});

    // Emit Claude stopped event
    sseEvents.emitClaudeRunning(sessionId, false);
    log.debug('runClaudeCommand: Cleanup complete', { sessionId });
  }
}

/**
 * Reconnect to an existing Claude process and continue processing its output.
 * Used after server restart to resume processing orphaned processes.
 */
export async function reconnectToClaudeProcess(
  sessionId: string
): Promise<{ reconnected: boolean; stillRunning: boolean }> {
  const processRecord = await prisma.claudeProcess.findUnique({
    where: { sessionId },
    include: { session: true },
  });

  if (!processRecord || !processRecord.session.containerId) {
    return { reconnected: false, stillRunning: false };
  }

  const containerId = processRecord.session.containerId;

  // Check if container is still running
  const containerStatus = await getContainerStatus(containerId);
  if (containerStatus !== 'running') {
    log.info('reconnectToClaudeProcess: Container not running', {
      sessionId,
      containerId,
      containerStatus,
    });
    // Container stopped - check health and report if needed
    await checkContainerHealthAndReport(sessionId, containerId);
    // Try to read remaining output
    try {
      await catchUpFromOutputFile(sessionId, containerId, getOutputFilePath(sessionId));
    } catch (err) {
      log.warn('reconnectToClaudeProcess: Failed to catch up from output file', {
        sessionId,
        error: toError(err).message,
      });
    }
    await prisma.claudeProcess.delete({ where: { sessionId } });
    return { reconnected: false, stillRunning: false };
  }

  // Check if Claude exec is still running using the stored execId
  const status = await getExecStatus(processRecord.execId);
  let claudeRunning = status.running;

  if (status.notFound) {
    log.info('reconnectToClaudeProcess: Exec ID not found (server may have restarted)', {
      sessionId,
      execId: processRecord.execId,
    });

    // Exec ID is invalid (server restarted), but the process might still be running
    // Check by looking for the actual claude process in the container
    const pid = await findProcessInContainer(containerId, CLAUDE_PROCESS_PATTERN);
    claudeRunning = pid !== null;

    if (claudeRunning) {
      log.info('reconnectToClaudeProcess: Claude process still running (found by PID)', {
        sessionId,
        pid,
      });
      // Update the stored PID
      await prisma.claudeProcess.update({
        where: { sessionId },
        data: { pid },
      });
    } else {
      log.info('reconnectToClaudeProcess: Claude process not found in container', {
        sessionId,
      });
    }
  }

  if (!claudeRunning) {
    // Process finished - check for errors and read remaining output
    log.info('reconnectToClaudeProcess: Process no longer running', {
      sessionId,
      execId: processRecord.execId,
      exitCode: status.exitCode,
    });

    // Check if this was an error exit (only if we have an exit code)
    if (isErrorExitCode(status.exitCode) && status.exitCode !== 130) {
      const containerLogs = await getContainerLogs(containerId, { tail: 30 });
      await createErrorMessage(
        sessionId,
        `Claude process exited: ${describeExitCode(status.exitCode)}`,
        { exitCode: status.exitCode, containerLogs }
      );
    }

    try {
      await catchUpFromOutputFile(sessionId, containerId, getOutputFilePath(sessionId));
    } catch (err) {
      log.warn('reconnectToClaudeProcess: Failed to catch up from output file', {
        sessionId,
        error: toError(err).message,
      });
    }
    await prisma.claudeProcess.delete({ where: { sessionId } });
    return { reconnected: false, stillRunning: false };
  }

  // Process is still running - reconnect to it
  if (runningProcesses.has(sessionId) || activeStreamProcessors.has(sessionId)) {
    // Already being processed
    return { reconnected: true, stillRunning: true };
  }

  runningProcesses.set(sessionId, { containerId, pid: processRecord.pid });

  // Emit Claude running event for reconnection
  sseEvents.emitClaudeRunning(sessionId, true);

  // Start processing the output file in the background
  // Use PID-based detection if exec ID is invalid
  processOutputFileWithPid(
    sessionId,
    containerId,
    getOutputFilePath(sessionId),
    processRecord.lastSequence + 1
  )
    .finally(() => {
      runningProcesses.delete(sessionId);
      killProcessesByPattern(containerId, getOutputFilePath(sessionId)).catch(() => {});
      prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
      // Emit Claude stopped event
      sseEvents.emitClaudeRunning(sessionId, false);
    })
    .catch((err) => {
      log.error('Error processing reconnected Claude output', toError(err), { sessionId });
    });

  return { reconnected: true, stillRunning: true };
}

/**
 * Read any unprocessed output from the file and save to DB.
 * Used when process has finished but we missed some output.
 */
async function catchUpFromOutputFile(
  sessionId: string,
  containerId: string,
  outputFile: string
): Promise<void> {
  // Check if file exists
  const fileExists = await fileExistsInContainer(containerId, outputFile);
  if (!fileExists) {
    log.info('catchUpFromOutputFile: Output file not found', { sessionId, outputFile });
    return;
  }

  const fileContent = await readFileInContainer(containerId, outputFile);
  const lines = fileContent.split('\n').filter((line) => line.trim());

  // Get current max sequence from DB to know where to start new messages
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  let sequence = (lastMessage?.sequence ?? -1) + 1;
  let linesProcessed = 0;
  let linesSkipped = 0;

  // Process all lines and skip any that are already in the DB (by message ID).
  // This is more robust than trying to calculate which lines to skip based on
  // sequence numbers, since sequence numbers don't map 1:1 to file line numbers.
  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      JSON.parse(line);
    } catch {
      // Generate deterministic ID from content so we can detect duplicates
      const errorId = uuidv5(`${sessionId}:error:${line}`, ERROR_LINE_NAMESPACE);
      const existingError = await prisma.message.findUnique({
        where: { id: errorId },
        select: { id: true },
      });
      if (existingError) {
        linesSkipped++;
        continue;
      }

      // Save as error
      await prisma.message.create({
        data: {
          id: errorId,
          sessionId,
          sequence: sequence++,
          type: 'system',
          content: JSON.stringify({
            type: 'system',
            subtype: 'error',
            content: [{ type: 'text', text: line }],
          }),
        },
      });
      linesProcessed++;
      continue;
    }

    const result = await saveMessageIfNotExists(sessionId, line, sequence);
    if (result.saved) {
      sequence = result.sequence + 1;
      linesProcessed++;
    } else if (result.reason === 'duplicate') {
      linesSkipped++;
    }
  }

  log.info('catchUpFromOutputFile: Complete', {
    sessionId,
    linesProcessed,
    linesSkipped,
  });
}

async function updateLastSequence(sessionId: string, sequence: number): Promise<void> {
  await prisma.claudeProcess
    .update({
      where: { sessionId },
      data: { lastSequence: sequence },
    })
    .catch(() => {}); // Ignore if record doesn't exist
}

/**
 * Process the output file by tailing it and using PID-based process detection.
 * Used for reconnection after server restart when exec ID is no longer valid.
 */
async function processOutputFileWithPid(
  sessionId: string,
  containerId: string,
  outputFile: string,
  startSequence: number
): Promise<void> {
  log.info('processOutputFileWithPid: Starting', { sessionId, outputFile, startSequence });

  if (activeStreamProcessors.has(sessionId)) {
    throw new Error('Stream processor already active for this session');
  }

  activeStreamProcessors.add(sessionId);
  let sequence = startSequence;
  let buffer = '';
  let totalLines = 0;

  try {
    // First check if container is still running
    const containerStatus = await getContainerStatus(containerId);
    if (containerStatus !== 'running') {
      log.warn('processOutputFileWithPid: Container not running at start', {
        sessionId,
        containerId,
        containerStatus,
      });
      await checkContainerHealthAndReport(sessionId, containerId);
      return;
    }

    // Wait for file to exist
    let attempts = 0;
    while (attempts < 50) {
      const exists = await fileExistsInContainer(containerId, outputFile);
      if (exists) break;

      if (attempts % 10 === 0) {
        const status = await getContainerStatus(containerId);
        if (status !== 'running') {
          log.warn('processOutputFileWithPid: Container stopped while waiting for output file', {
            sessionId,
            containerId,
            status,
          });
          await checkContainerHealthAndReport(sessionId, containerId);
          return;
        }
      }

      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }

    const { stream } = await tailFileInContainer(containerId, outputFile, 0);

    await new Promise<void>((resolve, reject) => {
      stream.on('data', async (chunk: Buffer) => {
        const data = chunk.toString('utf-8');
        buffer += data;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          totalLines++;

          const result = await processOutputLine(sessionId, line, sequence);
          if (result.saved) {
            sequence = result.newSequence;
            await updateLastSequence(sessionId, sequence - 1);
          }
        }
      });

      // Poll process existence using PID pattern matching
      const pollInterval = setInterval(async () => {
        try {
          // Check container status periodically
          const containerStatus = await getContainerStatus(containerId);
          if (containerStatus !== 'running') {
            clearInterval(pollInterval);
            stream.destroy();
            log.warn('processOutputFileWithPid: Container stopped during processing', {
              sessionId,
              containerId,
              containerStatus,
            });
            await checkContainerHealthAndReport(sessionId, containerId);
            resolve();
            return;
          }

          // Check if claude process is still running by pattern
          const pid = await findProcessInContainer(containerId, CLAUDE_PROCESS_PATTERN);
          const processRunning = pid !== null;

          log.debug('processOutputFileWithPid: Process status', {
            sessionId,
            processRunning,
            pid,
            totalLines,
          });

          if (!processRunning) {
            clearInterval(pollInterval);
            await new Promise((r) => setTimeout(r, 500));
            stream.destroy();

            // Read remaining content
            try {
              const fileContent = await readFileInContainer(containerId, outputFile);
              const allLines = fileContent.split('\n').filter((l) => l.trim());

              for (let i = totalLines; i < allLines.length; i++) {
                const line = allLines[i];
                const result = await processOutputLine(sessionId, line, sequence);
                if (result.saved) {
                  sequence = result.newSequence;
                }
                totalLines++;
              }
            } catch (err) {
              log.warn('processOutputFileWithPid: Failed to read remaining content', {
                sessionId,
                error: toError(err).message,
              });
            }

            log.info('processOutputFileWithPid: Completed', {
              sessionId,
              totalLines,
            });
            resolve();
          }
        } catch (err) {
          clearInterval(pollInterval);
          reject(err);
        }
      }, 1000);

      stream.on('error', (err) => {
        clearInterval(pollInterval);
        reject(err);
      });
    });
  } finally {
    activeStreamProcessors.delete(sessionId);
    await killProcessesByPattern(containerId, outputFile).catch(() => {});
  }
}

/**
 * Mark the last non-user message as potentially interrupted and add an interrupt indicator message.
 * Called after successfully sending SIGINT to the Claude process.
 */
export async function markLastMessageAsInterrupted(sessionId: string): Promise<void> {
  log.info('markLastMessageAsInterrupted: Marking message as interrupted', { sessionId });

  // Get the last message to find the current max sequence
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true },
  });

  if (!lastMessage) {
    log.warn('markLastMessageAsInterrupted: No messages found', { sessionId });
    return;
  }

  // Find the last non-user message to mark as interrupted
  // This could be assistant, result, or system type
  const lastNonUserMessage = await prisma.message.findFirst({
    where: {
      sessionId,
      type: { not: 'user' },
    },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true },
  });

  if (lastNonUserMessage) {
    // Parse the content, add interrupted flag, and save back
    try {
      const content = JSON.parse(lastNonUserMessage.content);
      content.interrupted = true;
      await prisma.message.update({
        where: { id: lastNonUserMessage.id },
        data: { content: JSON.stringify(content) },
      });
      log.debug('markLastMessageAsInterrupted: Marked message as interrupted', {
        sessionId,
        messageId: lastNonUserMessage.id,
        type: lastNonUserMessage.type,
      });

      // Emit update for the modified message
      sseEvents.emitNewMessage(sessionId, {
        id: lastNonUserMessage.id,
        sessionId,
        sequence: lastNonUserMessage.sequence,
        type: lastNonUserMessage.type,
        content,
        createdAt: new Date(),
      });
    } catch (err) {
      log.warn('markLastMessageAsInterrupted: Failed to parse message content', {
        sessionId,
        messageId: lastNonUserMessage.id,
        error: toError(err).message,
      });
    }
  }

  // Add an interrupt indicator message
  const interruptMessageId = uuid();
  const interruptSequence = lastMessage.sequence + 1;
  const interruptContent = {
    type: 'user',
    subtype: 'interrupt',
    content: 'Interrupted',
  };

  await prisma.message.create({
    data: {
      id: interruptMessageId,
      sessionId,
      sequence: interruptSequence,
      type: 'user',
      content: JSON.stringify(interruptContent),
    },
  });

  log.info('markLastMessageAsInterrupted: Added interrupt message', {
    sessionId,
    messageId: interruptMessageId,
    sequence: interruptSequence,
  });

  // Emit the new interrupt message
  sseEvents.emitNewMessage(sessionId, {
    id: interruptMessageId,
    sessionId,
    sequence: interruptSequence,
    type: 'user',
    content: interruptContent,
    createdAt: new Date(),
  });
}

export async function interruptClaude(sessionId: string): Promise<boolean> {
  log.info('interruptClaude: Interrupt requested', { sessionId });

  // Check in-memory first
  const process = runningProcesses.get(sessionId);
  if (process) {
    log.debug('interruptClaude: Found in-memory process', {
      sessionId,
      containerId: process.containerId,
      pid: process.pid,
    });

    // Verify the container is still running before trying to signal
    const containerStatus = await getContainerStatus(process.containerId);
    if (containerStatus !== 'running') {
      log.info('interruptClaude: Cleaning up stale in-memory process (container not running)', {
        sessionId,
        containerId: process.containerId,
        containerStatus,
      });
      runningProcesses.delete(sessionId);
      await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
      return false;
    }

    if (process.pid) {
      // Use direct kill with PID for more reliable signal delivery
      await sendSignalToExec(process.containerId, process.pid, 'INT');
    } else {
      // Fallback to pattern matching if PID not available
      await signalProcessesByPattern(process.containerId, CLAUDE_PROCESS_PATTERN, 'INT');
    }
    return true;
  }

  // Check DB for persistent record
  const processRecord = await prisma.claudeProcess.findUnique({
    where: { sessionId },
  });
  if (!processRecord) {
    log.info('interruptClaude: No process found', { sessionId });
    return false;
  }

  // Verify the container actually exists before trying to signal
  const containerStatus = await getContainerStatus(processRecord.containerId);
  if (containerStatus !== 'running') {
    log.info('interruptClaude: Cleaning up stale process record (container not running)', {
      sessionId,
      containerId: processRecord.containerId,
      containerStatus,
    });
    await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
    return false;
  }

  log.debug('interruptClaude: Found DB process record', {
    sessionId,
    containerId: processRecord.containerId,
    pid: processRecord.pid,
  });
  // Send SIGINT to the Claude process - prefer direct PID if available
  if (processRecord.pid) {
    await sendSignalToExec(processRecord.containerId, processRecord.pid, 'INT');
  } else {
    await signalProcessesByPattern(processRecord.containerId, CLAUDE_PROCESS_PATTERN, 'INT');
  }
  return true;
}

export function isClaudeRunning(sessionId: string): boolean {
  return runningProcesses.has(sessionId);
}

/**
 * Check if Claude is running, including checking the DB for persistent records.
 * More thorough than isClaudeRunning() but involves a DB query.
 * Also verifies the container actually exists and cleans up stale records if not.
 */
export async function isClaudeRunningAsync(sessionId: string): Promise<boolean> {
  // Check in-memory first, but verify container is still running
  const inMemoryProcess = runningProcesses.get(sessionId);
  if (inMemoryProcess) {
    const containerStatus = await getContainerStatus(inMemoryProcess.containerId);
    if (containerStatus === 'running') {
      return true;
    }
    // Container is gone - clean up stale in-memory and DB records
    log.info('isClaudeRunningAsync: Cleaning up stale in-memory process (container not running)', {
      sessionId,
      containerId: inMemoryProcess.containerId,
      containerStatus,
    });
    runningProcesses.delete(sessionId);
    await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
    return false;
  }

  const processRecord = await prisma.claudeProcess.findUnique({
    where: { sessionId },
  });

  if (!processRecord) {
    return false;
  }

  // Verify the container actually exists - if not, clean up the stale record
  const containerStatus = await getContainerStatus(processRecord.containerId);
  if (containerStatus === 'not_found') {
    log.info('isClaudeRunningAsync: Cleaning up stale process record (container not found)', {
      sessionId,
      containerId: processRecord.containerId,
    });
    await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
    return false;
  }

  // Container exists but is stopped - clean up the stale record
  if (containerStatus === 'stopped') {
    log.info('isClaudeRunningAsync: Cleaning up stale process record (container stopped)', {
      sessionId,
      containerId: processRecord.containerId,
    });
    await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
    return false;
  }

  // Container is running - check if the Claude exec is still active
  if (processRecord.execId) {
    try {
      const execStatus = await getExecStatus(processRecord.execId);
      if (!execStatus.running) {
        log.info('isClaudeRunningAsync: Cleaning up stale process record (exec finished)', {
          sessionId,
          execId: processRecord.execId,
        });
        await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
        return false;
      }
    } catch {
      // Exec not found - clean up
      log.info('isClaudeRunningAsync: Cleaning up stale process record (exec not found)', {
        sessionId,
        execId: processRecord.execId,
      });
      await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});
      return false;
    }
  }

  return true;
}

/**
 * Reconcile all orphaned Claude processes on startup.
 * Should be called once when the server starts.
 */
export async function reconcileOrphanedProcesses(): Promise<{
  total: number;
  reconnected: number;
  cleaned: number;
}> {
  const orphanedProcesses = await prisma.claudeProcess.findMany({
    include: { session: true },
  });

  let reconnected = 0;
  let cleaned = 0;

  for (const processRecord of orphanedProcesses) {
    log.info('Reconciling orphaned process', { sessionId: processRecord.sessionId });

    try {
      const result = await reconnectToClaudeProcess(processRecord.sessionId);
      if (result.reconnected) {
        reconnected++;
        log.info('Reconnected to running process', { sessionId: processRecord.sessionId });
      } else {
        cleaned++;
        log.info('Cleaned up finished process', { sessionId: processRecord.sessionId });
      }
    } catch (err) {
      log.error('Error reconciling session', toError(err), { sessionId: processRecord.sessionId });
      // Clean up the record to avoid infinite retry
      await prisma.claudeProcess.delete({ where: { id: processRecord.id } }).catch(() => {});
      cleaned++;
    }
  }

  return {
    total: orphanedProcesses.length,
    reconnected,
    cleaned,
  };
}
