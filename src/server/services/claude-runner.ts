import {
  execInContainerWithOutputFile,
  getExecStatus,
  tailFileInContainer,
  readFileInContainer,
  getContainerStatus,
  fileExistsInContainer,
  killProcessesByPattern,
  signalProcessesByPattern,
  findProcessInContainer,
  sendSignalToExec,
} from './docker';
import { prisma } from '@/lib/prisma';
import { getMessageType } from '@/lib/claude-messages';
import { DockerStreamDemuxer } from './docker-stream-demuxer';
import { v4 as uuid, v5 as uuidv5 } from 'uuid';
import { sseEvents } from './events';

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

Never leave uncommitted or unpushed changes - the user cannot see them otherwise.`;

// Logging helper for debugging
function log(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] [claude-runner:${context}] ${message}${dataStr}`);
}

function getOutputFileName(sessionId: string): string {
  return `${OUTPUT_FILE_PREFIX}${sessionId}.jsonl`;
}

function getOutputFilePath(sessionId: string): string {
  return `/workspace/${getOutputFileName(sessionId)}`;
}

export async function runClaudeCommand(
  sessionId: string,
  containerId: string,
  prompt: string
): Promise<void> {
  log('runClaudeCommand', 'Starting', { sessionId, containerId, promptLength: prompt.length });

  // Check if session already has a running process (in-memory check first for speed)
  if (runningProcesses.has(sessionId)) {
    log('runClaudeCommand', 'Process already running in memory', { sessionId });
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

  // Get the next sequence number for this session
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  let sequence = (lastMessage?.sequence ?? -1) + 1;

  // Store the user prompt first
  await prisma.message.create({
    data: {
      id: uuid(),
      sessionId,
      sequence: sequence++,
      type: 'user',
      content: JSON.stringify({ type: 'user', content: prompt }),
    },
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

  // Start Claude with output to file (for recovery) and get exec ID (for status checking)
  log('runClaudeCommand', 'Executing command in container', { command, outputFile });
  const { execId } = await execInContainerWithOutputFile(containerId, command, outputFile);
  log('runClaudeCommand', 'Command started', { sessionId, execId });

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
  log('runClaudeCommand', 'Process registered', { sessionId });

  // Emit Claude running event
  sseEvents.emitClaudeRunning(sessionId, true);

  try {
    // Wait for file to exist
    let attempts = 0;
    while (attempts < 50) {
      const exists = await fileExistsInContainer(containerId, outputFile);
      if (exists) break;
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }

    // Find and store the PID of the Claude process for direct signal delivery
    const pid = await findProcessInContainer(containerId, CLAUDE_PROCESS_PATTERN);
    if (pid) {
      log('runClaudeCommand', 'Found Claude process PID', { sessionId, pid });
      runningProcesses.set(sessionId, { containerId, pid });
      await prisma.claudeProcess.update({
        where: { sessionId },
        data: { pid },
      });
    } else {
      log('runClaudeCommand', 'Could not find Claude process PID', { sessionId });
    }

    // Tail the output file for real-time streaming
    log('runClaudeCommand', 'Starting tail', { sessionId, outputFile });
    const { stream } = await tailFileInContainer(containerId, outputFile, 0);
    const demuxer = new DockerStreamDemuxer();

    let buffer = '';
    let totalLines = 0;

    // Process output and poll for completion
    await new Promise<void>((resolve, reject) => {
      stream.on('data', async (chunk: Buffer) => {
        // Demux the Docker multiplexed stream to extract actual content
        const data = demuxer.push(chunk);
        buffer += data;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          totalLines++;

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            log('runClaudeCommand', 'Failed to parse JSON', {
              sessionId,
              line: line.slice(0, 100),
            });
            continue;
          }

          const messageType = getMessageType(parsed);
          const msgId =
            (parsed as { uuid?: string; id?: string }).uuid ||
            (parsed as { uuid?: string; id?: string }).id ||
            uuid();

          log('runClaudeCommand', 'Saving message', { sessionId, sequence, messageType });

          const message = await prisma.message.create({
            data: {
              id: msgId,
              sessionId,
              sequence: sequence++,
              type: messageType,
              content: line,
            },
          });

          // Emit new message event
          sseEvents.emitNewMessage(sessionId, { ...message, content: parsed });

          // Update last processed sequence for recovery
          await prisma.claudeProcess
            .update({ where: { sessionId }, data: { lastSequence: sequence - 1 } })
            .catch(() => {});
        }
      });

      // Poll exec status instead of pgrep (much more reliable)
      const pollInterval = setInterval(async () => {
        try {
          const status = await getExecStatus(execId);
          log('runClaudeCommand', 'Exec status', { sessionId, ...status, totalLines });

          if (!status.running) {
            clearInterval(pollInterval);
            // Wait for final output to flush
            await new Promise((r) => setTimeout(r, 500));
            stream.destroy();

            // Read any remaining content from file
            const fileContent = await readFileInContainer(containerId, outputFile);
            const allLines = fileContent.split('\n').filter((l) => l.trim());

            for (let i = totalLines; i < allLines.length; i++) {
              const line = allLines[i];
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                continue;
              }
              const messageType = getMessageType(parsed);
              const msgId =
                (parsed as { uuid?: string; id?: string }).uuid ||
                (parsed as { uuid?: string; id?: string }).id ||
                uuid();

              const message = await prisma.message.create({
                data: {
                  id: msgId,
                  sessionId,
                  sequence: sequence++,
                  type: messageType,
                  content: line,
                },
              });

              // Emit new message event
              sseEvents.emitNewMessage(sessionId, { ...message, content: parsed });
              totalLines++;
            }

            log('runClaudeCommand', 'Completed', {
              sessionId,
              totalLines,
              exitCode: status.exitCode,
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
    runningProcesses.delete(sessionId);
    await killProcessesByPattern(containerId, outputFile).catch(() => {});
    await prisma.claudeProcess.delete({ where: { sessionId } }).catch(() => {});

    // Emit Claude stopped event
    sseEvents.emitClaudeRunning(sessionId, false);
    log('runClaudeCommand', 'Cleanup complete', { sessionId });
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
      console.error(`Error processing reconnected Claude output for ${sessionId}:`, err);
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
    console.log(`Output file ${outputFile} not found for session ${sessionId}`);
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
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

    const messageType = getMessageType(parsed);
    const msgId =
      (parsed as { uuid?: string; id?: string }).uuid ||
      (parsed as { uuid?: string; id?: string }).id ||
      uuid();

    // Check if this message already exists by ID (could have been processed before)
    const existingById = await prisma.message.findUnique({
      where: { id: msgId },
      select: { id: true },
    });
    if (existingById) {
      // Already processed, skip
      linesSkipped++;
      continue;
    }

    // Check if a message exists at this sequence (could be from a different processing run)
    const existingBySequence = await prisma.message.findUnique({
      where: { sessionId_sequence: { sessionId, sequence } },
      select: { id: true },
    });
    if (existingBySequence) {
      // Sequence already taken, increment and try again
      sequence++;
      // Re-check at new sequence
      const existingAtNewSeq = await prisma.message.findUnique({
        where: { sessionId_sequence: { sessionId, sequence } },
        select: { id: true },
      });
      if (existingAtNewSeq) {
        // Skip this line, sequence tracking is off
        continue;
      }
    }

    await prisma.message.create({
      data: {
        id: msgId,
        sessionId,
        sequence: sequence++,
        type: messageType,
        content: line,
      },
    });
    linesProcessed++;
  }

  console.log(
    `Caught up for session ${sessionId}: ${linesProcessed} new, ${linesSkipped} skipped (already in DB)`
  );
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
  log('processOutputFile', 'Starting', { sessionId, execId, outputFile, startSequence });

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
    const demuxer = new DockerStreamDemuxer();

    await new Promise<void>((resolve, reject) => {
      stream.on('data', async (chunk: Buffer) => {
        // Demux the Docker multiplexed stream to extract actual content
        const data = demuxer.push(chunk);
        buffer += data;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          totalLines++;

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          const messageType = getMessageType(parsed);
          const msgId =
            (parsed as { uuid?: string; id?: string }).uuid ||
            (parsed as { uuid?: string; id?: string }).id ||
            uuid();

          const message = await prisma.message.create({
            data: { id: msgId, sessionId, sequence: sequence++, type: messageType, content: line },
          });

          // Emit new message event
          sseEvents.emitNewMessage(sessionId, { ...message, content: parsed });
          await updateLastSequence(sessionId, sequence - 1);
        }
      });

      // Poll exec status (much more reliable than pgrep)
      const pollInterval = setInterval(async () => {
        try {
          const status = await getExecStatus(execId);
          log('processOutputFile', 'Exec status', { sessionId, ...status, totalLines });

          if (!status.running) {
            clearInterval(pollInterval);
            await new Promise((r) => setTimeout(r, 500));
            stream.destroy();

            // Read remaining content
            const fileContent = await readFileInContainer(containerId, outputFile);
            const allLines = fileContent.split('\n').filter((l) => l.trim());

            for (let i = totalLines; i < allLines.length; i++) {
              const line = allLines[i];
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                continue;
              }
              const messageType = getMessageType(parsed);
              const msgId =
                (parsed as { uuid?: string; id?: string }).uuid ||
                (parsed as { uuid?: string; id?: string }).id ||
                uuid();

              const message = await prisma.message.create({
                data: {
                  id: msgId,
                  sessionId,
                  sequence: sequence++,
                  type: messageType,
                  content: line,
                },
              });

              // Emit new message event
              sseEvents.emitNewMessage(sessionId, { ...message, content: parsed });
              totalLines++;
            }

            log('processOutputFile', 'Completed', { sessionId, totalLines });
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

export async function interruptClaude(sessionId: string): Promise<boolean> {
  log('interruptClaude', 'Interrupt requested', { sessionId });

  // Check in-memory first
  const process = runningProcesses.get(sessionId);
  if (process) {
    log('interruptClaude', 'Found in-memory process', {
      sessionId,
      containerId: process.containerId,
      pid: process.pid,
    });
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
    log('interruptClaude', 'No process found', { sessionId });
    return false;
  }

  log('interruptClaude', 'Found DB process record', {
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
 */
export async function isClaudeRunningAsync(sessionId: string): Promise<boolean> {
  if (runningProcesses.has(sessionId)) {
    return true;
  }

  const processRecord = await prisma.claudeProcess.findUnique({
    where: { sessionId },
  });

  return processRecord !== null;
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
    console.log(`Reconciling orphaned process for session ${processRecord.sessionId}`);

    try {
      const result = await reconnectToClaudeProcess(processRecord.sessionId);
      if (result.reconnected) {
        reconnected++;
        console.log(`Reconnected to running process for session ${processRecord.sessionId}`);
      } else {
        cleaned++;
        console.log(`Cleaned up finished process for session ${processRecord.sessionId}`);
      }
    } catch (err) {
      console.error(`Error reconciling session ${processRecord.sessionId}:`, err);
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
