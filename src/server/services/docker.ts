import Docker from 'dockerode';
import { env } from '@/lib/env';

const docker = new Docker();

const CLAUDE_CODE_IMAGE = 'claude-code-runner:latest';

export interface ContainerConfig {
  sessionId: string;
  worktreePath: string;
}

export async function createAndStartContainer(config: ContainerConfig): Promise<string> {
  const containerName = `claude-session-${config.sessionId}`;

  // Check if container already exists
  const existingContainers = await docker.listContainers({
    all: true,
    filters: { name: [containerName] },
  });

  if (existingContainers.length > 0) {
    const existing = existingContainers[0];
    if (existing.State !== 'running') {
      const container = docker.getContainer(existing.Id);
      await container.start();
    }
    return existing.Id;
  }

  const container = await docker.createContainer({
    Image: CLAUDE_CODE_IMAGE,
    name: containerName,
    HostConfig: {
      Binds: [
        `${config.worktreePath}:/workspace`,
        `/var/run/docker.sock:/var/run/docker.sock`,
        `${env.CLAUDE_AUTH_PATH}:/home/claudeuser/.claude:ro`,
      ],
      DeviceRequests: [
        {
          Driver: 'nvidia',
          Count: -1, // all GPUs
          Capabilities: [['gpu']],
        },
      ],
    },
    WorkingDir: '/workspace',
  });

  await container.start();
  return container.id;
}

export async function stopContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 10 });
  } catch (error) {
    // Container might already be stopped
    if (!(error instanceof Error && error.message.includes('not running'))) {
      throw error;
    }
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 5 });
  } catch {
    // Ignore stop errors
  }
  try {
    await container.remove({ force: true });
  } catch {
    // Ignore remove errors if already removed
  }
}

export async function execInContainer(
  containerId: string,
  command: string[]
): Promise<{ stream: NodeJS.ReadableStream; execId: string }> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return { stream: stream, execId: exec.id };
}

export async function getContainerStatus(
  containerId: string
): Promise<'running' | 'stopped' | 'not_found'> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info.State.Running ? 'running' : 'stopped';
  } catch {
    return 'not_found';
  }
}

export async function sendSignalToExec(
  containerId: string,
  pid: number,
  signal: string = 'SIGINT'
): Promise<void> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['kill', `-${signal}`, pid.toString()],
    AttachStdout: true,
    AttachStderr: true,
  });

  await exec.start({ Detach: false });
}

export async function findProcessInContainer(
  containerId: string,
  processName: string
): Promise<number | null> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['pgrep', '-f', processName],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false });

  return new Promise((resolve) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    stream.on('end', () => {
      const pid = parseInt(output.trim().split('\n')[0], 10);
      resolve(isNaN(pid) ? null : pid);
    });
    stream.on('error', () => resolve(null));
  });
}
