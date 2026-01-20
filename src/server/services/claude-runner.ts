import { execInContainer, findProcessInContainer, sendSignalToExec } from './docker';
import { prisma } from '@/lib/prisma';
import { parseClaudeStreamLine, getMessageType } from '@/lib/claude-messages';
import { v4 as uuid } from 'uuid';

// Track running Claude processes per session
const runningProcesses = new Map<string, { containerId: string; pid: number | null }>();

export async function runClaudeCommand(
  sessionId: string,
  containerId: string,
  prompt: string
): Promise<void> {
  // Check if session already has a running process
  if (runningProcesses.has(sessionId)) {
    throw new Error('A Claude process is already running for this session');
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
  ];

  runningProcesses.set(sessionId, { containerId, pid: null });

  try {
    const { stream } = await execInContainer(containerId, command);

    // Try to find the PID of the claude process
    setTimeout(async () => {
      const pid = await findProcessInContainer(containerId, 'claude');
      const process = runningProcesses.get(sessionId);
      if (process && pid) {
        process.pid = pid;
      }
    }, 500);

    await processClaudeStream(stream, sessionId, sequence);
  } finally {
    runningProcesses.delete(sessionId);
  }
}

async function processClaudeStream(
  stream: NodeJS.ReadableStream,
  sessionId: string,
  startSequence: number
): Promise<void> {
  let sequence = startSequence;
  let buffer = '';
  let errorLines: string[] = [];

  // Helper to save an error message
  const saveErrorMessage = async (errorText: string) => {
    const errorContent = JSON.stringify({
      type: 'system',
      subtype: 'error',
      content: [{ type: 'text', text: errorText }],
    });
    await prisma.message.create({
      data: {
        id: uuid(),
        sessionId,
        sequence: sequence++,
        type: 'system',
        content: errorContent,
      },
    });
  };

  // Flush accumulated error lines as a single message
  const flushErrorLines = async () => {
    if (errorLines.length > 0) {
      const combinedError = errorLines.join('\n');
      console.error('Failed to parse Claude output:', combinedError);
      await saveErrorMessage(combinedError);
      errorLines = [];
    }
  };

  return new Promise((resolve, reject) => {
    stream.on('data', async (chunk: Buffer) => {
      // Docker multiplexed stream has 8-byte header
      // Skip header bytes and get actual content
      const data = stripDockerHeader(chunk);
      buffer += data;

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Accumulate unparseable lines to batch them together
          errorLines.push(line);
          continue;
        }

        // Flush any accumulated errors before saving valid message
        await flushErrorLines();

        // Validate the parsed JSON against our schemas
        const parseResult = parseClaudeStreamLine(parsed);
        const messageType = getMessageType(parsed);

        if (!parseResult.success) {
          // Log validation failure but still save the message with the raw content
          // This allows the UI to display it as collapsed raw JSON
          console.warn(`Failed to validate ${messageType} message:`, parseResult.error);
        }

        // Extract ID from parsed content if available
        const msgId =
          (parsed as { uuid?: string; id?: string }).uuid ||
          (parsed as { uuid?: string; id?: string }).id ||
          uuid();

        await prisma.message.create({
          data: {
            id: msgId,
            sessionId,
            sequence: sequence++,
            type: messageType,
            content: line,
          },
        });
      }
    });

    stream.on('end', async () => {
      // Flush any remaining error lines
      await flushErrorLines();
      resolve();
    });

    stream.on('error', async (err) => {
      await flushErrorLines();
      await saveErrorMessage(`Stream error: ${err.message}`);
      reject(err);
    });
  });
}

function stripDockerHeader(chunk: Buffer): string {
  // Docker multiplexed streams have an 8-byte header
  // [stream type (1), 0, 0, 0, size (4 bytes big-endian)]
  if (chunk.length > 8) {
    const streamType = chunk[0];
    if (streamType === 1 || streamType === 2) {
      // stdout or stderr
      return chunk.slice(8).toString('utf-8');
    }
  }
  return chunk.toString('utf-8');
}

export async function interruptClaude(sessionId: string): Promise<boolean> {
  const process = runningProcesses.get(sessionId);

  if (!process) {
    return false;
  }

  if (process.pid) {
    await sendSignalToExec(process.containerId, process.pid, 'SIGINT');
    return true;
  }

  // Try to find the process if PID wasn't captured earlier
  const pid = await findProcessInContainer(process.containerId, 'claude');
  if (pid) {
    await sendSignalToExec(process.containerId, pid, 'SIGINT');
    return true;
  }

  return false;
}

export function isClaudeRunning(sessionId: string): boolean {
  return runningProcesses.has(sessionId);
}
