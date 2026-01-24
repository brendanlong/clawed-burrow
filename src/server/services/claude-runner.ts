import {
  execInContainerWithTee,
  getExecStatus,
  tailFileInContainer,
  readFileInContainer,
  getContainerStatus,
  fileExistsInContainer,
  killProcessesByPattern,
  signalProcessesByPattern,
  findProcessInContainer,
  sendSignalToExec,
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
  | { saved: false; reason: 'parse_error' | 'duplicate' };

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

  const messageType = getMessageType(parsed);
  const msgId =
    (parsed as { uuid?: string; id?: string }).uuid ||
    (parsed as { uuid?: string; id?: string }).id ||
    uuid();

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
    log.error('runClaudeCommand: Container not running', {
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
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    SYSTEM_PROMPT,
  ];

  const outputFile = getOutputFilePath(sessionId);

  // Start Claude with attached output stream (also writes to file for crash recovery)
  log.info('runClaudeCommand: Executing command in container', { command, outputFile });
  const { stream, execId } = await execInContainerWithTee(containerId, command, outputFile);
  log.info('runClaudeCommand: Command started with attached stream', { sessionId, execId });

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

    // Process output directly from the attached stream (no tailing needed)
    let buffer = '';
    let totalLines = 0;

    // Process output - stream ends when process completes
    await new Promise<void>((resolve, reject) => {
      stream.on('data', async (chunk: Buffer) => {
        // With Podman CLI, output is plain text (no Docker multiplexing)
        const data = chunk.toString('utf-8');
        buffer += data;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          totalLines++;

          const result = await saveMessageIfNotExists(sessionId, line, sequence);
          if (result.saved) {
            sequence = result.sequence + 1;
            log.debug('runClaudeCommand: Saved message', { sessionId, sequence: result.sequence });
            // Emit new message event
            sseEvents.emitNewMessage(sessionId, result.message);
            // Update last processed sequence for recovery
            await prisma.claudeProcess
              .update({ where: { sessionId }, data: { lastSequence: result.sequence } })
              .catch(() => {});
          } else if (result.reason === 'parse_error') {
            log.warn('runClaudeCommand: Failed to parse JSON', {
              sessionId,
              line: line.slice(0, 100),
            });
          }
        }
      });

      stream.on('end', async () => {
        // Process any remaining buffered content
        if (buffer.trim()) {
          const result = await saveMessageIfNotExists(sessionId, buffer, sequence);
          if (result.saved) {
            sequence = result.sequence + 1;
            sseEvents.emitNewMessage(sessionId, result.message);
          }
          totalLines++;
        }

        // Get final exit code for logging
        try {
          const status = await getExecStatus(execId);
          log.info('runClaudeCommand: Completed', {
            sessionId,
            totalLines,
            exitCode: status.exitCode,
          });
        } catch {
          log.info('runClaudeCommand: Completed (could not get exit code)', {
            sessionId,
            totalLines,
          });
        }

        resolve();
      });

      stream.on('error', (err) => {
        log.error('runClaudeCommand: Stream error', toError(err), { sessionId });
        reject(err);
      });
    });
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
    // Container stopped - just read remaining output
    await catchUpFromOutputFile(sessionId, containerId, getOutputFilePath(sessionId));
    await prisma.claudeProcess.delete({ where: { sessionId } });
    return { reconnected: false, stillRunning: false };
  }

  // Check if Claude exec is still running using the stored execId
  let claudeRunning = false;
  try {
    const status = await getExecStatus(processRecord.execId);
    claudeRunning = status.running;
  } catch {
    // Exec not found (container was recreated, etc)
    claudeRunning = false;
  }

  if (!claudeRunning) {
    // Process finished - just read remaining output
    await catchUpFromOutputFile(sessionId, containerId, getOutputFilePath(sessionId));
    await prisma.claudeProcess.delete({ where: { sessionId } });
    return { reconnected: false, stillRunning: false };
  }

  // Process is still running - reconnect to it
  if (runningProcesses.has(sessionId) || activeStreamProcessors.has(sessionId)) {
    // Already being processed
    return { reconnected: true, stillRunning: true };
  }

  runningProcesses.set(sessionId, { containerId, pid: null });

  // Emit Claude running event for reconnection
  sseEvents.emitClaudeRunning(sessionId, true);

  // Start processing the output file in the background using the stored execId
  processOutputFileWithExecId(
    sessionId,
    containerId,
    processRecord.execId,
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

/**
 * Process the output file by tailing it and saving messages to DB.
 * Uses execId to check for completion (more reliable than pgrep).
 */
async function processOutputFileWithExecId(
  sessionId: string,
  containerId: string,
  execId: string,
  outputFile: string,
  startSequence: number
): Promise<void> {
  log.info('processOutputFile: Starting', { sessionId, execId, outputFile, startSequence });

  if (activeStreamProcessors.has(sessionId)) {
    throw new Error('Stream processor already active for this session');
  }

  activeStreamProcessors.add(sessionId);
  let sequence = startSequence;
  let buffer = '';
  let totalLines = 0;

  try {
    // Wait for file to exist
    let attempts = 0;
    while (attempts < 50) {
      const exists = await fileExistsInContainer(containerId, outputFile);
      if (exists) break;
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }

    const { stream } = await tailFileInContainer(containerId, outputFile, 0);

    await new Promise<void>((resolve, reject) => {
      stream.on('data', async (chunk: Buffer) => {
        // With Podman CLI, output is plain text (no Docker multiplexing)
        const data = chunk.toString('utf-8');
        buffer += data;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          totalLines++;

          const result = await saveMessageIfNotExists(sessionId, line, sequence);
          if (result.saved) {
            sequence = result.sequence + 1;
            // Emit new message event
            sseEvents.emitNewMessage(sessionId, result.message);
            await updateLastSequence(sessionId, result.sequence);
          }
        }
      });

      // Poll exec status (much more reliable than pgrep)
      const pollInterval = setInterval(async () => {
        try {
          const status = await getExecStatus(execId);
          log.debug('processOutputFile: Exec status', { sessionId, ...status, totalLines });

          if (!status.running) {
            clearInterval(pollInterval);
            await new Promise((r) => setTimeout(r, 500));
            stream.destroy();

            // Read remaining content
            const fileContent = await readFileInContainer(containerId, outputFile);
            const allLines = fileContent.split('\n').filter((l) => l.trim());

            for (let i = totalLines; i < allLines.length; i++) {
              const line = allLines[i];
              const result = await saveMessageIfNotExists(sessionId, line, sequence);
              if (result.saved) {
                sequence = result.sequence + 1;
                // Emit new message event
                sseEvents.emitNewMessage(sessionId, result.message);
              }
              totalLines++;
            }

            log.info('processOutputFile: Completed', { sessionId, totalLines });
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

async function updateLastSequence(sessionId: string, sequence: number): Promise<void> {
  await prisma.claudeProcess
    .update({
      where: { sessionId },
      data: { lastSequence: sequence },
    })
    .catch(() => {}); // Ignore if record doesn't exist
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
