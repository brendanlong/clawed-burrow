import { execInContainer, findProcessInContainer, sendSignalToExec } from './docker';
import { prisma } from '@/lib/prisma';
import type { MessageType } from '@/lib/types';
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
  const command = [
    'claude',
    '-p',
    prompt,
    '--session-id',
    sessionId,
    '--output-format',
    'stream-json',
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

  // Helper to save an error message
  const saveErrorMessage = async (errorText: string) => {
    const errorContent = JSON.stringify({
      type: 'system',
      error: true,
      message: errorText,
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

        try {
          const parsed = JSON.parse(line);
          const messageType = mapClaudeMessageType(parsed.type);

          await prisma.message.create({
            data: {
              id: parsed.id || uuid(),
              sessionId,
              sequence: sequence++,
              type: messageType,
              content: line,
            },
          });
        } catch {
          // Save unparseable output as an error message visible to the user
          console.error('Failed to parse Claude output:', line);
          await saveErrorMessage(line);
        }
      }
    });

    stream.on('end', () => {
      resolve();
    });

    stream.on('error', async (err) => {
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

function mapClaudeMessageType(type: string): MessageType {
  switch (type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'result':
      return 'result';
    case 'system':
    default:
      return 'system';
  }
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
