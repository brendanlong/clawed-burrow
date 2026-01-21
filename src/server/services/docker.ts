import Docker from 'dockerode';
import { Readable } from 'stream';
import { env } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';

const docker = new Docker();
const log = createLogger('docker');

// Use env variable if set, otherwise default to local build
const CLAUDE_CODE_IMAGE = env.CLAUDE_RUNNER_IMAGE;

/**
 * Convert a container path to a host path for Docker bind mounts.
 * In Docker-in-Docker setups, DATA_DIR is the path inside this container,
 * but we need the host path for bind mounts in session containers.
 */
function toHostPath(containerPath: string): string {
  if (!env.DATA_HOST_PATH) {
    // No host path configured, use the path as-is (local dev mode)
    return containerPath;
  }
  // Replace the DATA_DIR prefix with DATA_HOST_PATH
  if (containerPath.startsWith(env.DATA_DIR)) {
    return containerPath.replace(env.DATA_DIR, env.DATA_HOST_PATH);
  }
  return containerPath;
}

// Track last pull time per image to avoid pulling too frequently
const lastPullTime = new Map<string, number>();
const PULL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (matches Watchtower poll interval)

/**
 * Ensure a Docker image is up-to-date by pulling it.
 * Pulls are rate-limited to once per 5 minutes per image to avoid excessive API calls.
 * Docker pull is fast when the image is already current (just a manifest check).
 */
async function ensureImagePulled(imageName: string): Promise<void> {
  const lastPull = lastPullTime.get(imageName);
  const now = Date.now();

  // Skip if we've pulled recently
  if (lastPull && now - lastPull < PULL_INTERVAL_MS) {
    log.debug('Skipping pull, recently pulled', { imageName, msAgo: now - lastPull });
    return;
  }

  log.info('Pulling image', { imageName });

  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        log.error('Failed to pull image', err, { imageName });
        reject(err);
        return;
      }

      // Follow the pull progress and wait for completion
      docker.modem.followProgress(
        stream,
        (pullErr: Error | null) => {
          if (pullErr) {
            log.error('Image pull failed', pullErr, { imageName });
            reject(pullErr);
          } else {
            log.info('Image pull complete', { imageName });
            lastPullTime.set(imageName, Date.now());
            resolve();
          }
        },
        (event: { status?: string; progress?: string }) => {
          // Log progress periodically
          if (event.status && event.progress) {
            log.debug('Pull progress', {
              imageName,
              status: event.status,
              progress: event.progress,
            });
          }
        }
      );
    });
  });
}

export interface ContainerConfig {
  sessionId: string;
  workspacePath: string;
  githubToken?: string;
}

export async function createAndStartContainer(config: ContainerConfig): Promise<string> {
  const containerName = `claude-session-${config.sessionId}`;
  log.info('Creating container', { sessionId: config.sessionId, containerName });

  try {
    // Check if container already exists
    const existingContainers = await docker.listContainers({
      all: true,
      filters: { name: [containerName] },
    });

    if (existingContainers.length > 0) {
      const existing = existingContainers[0];
      log.info('Found existing container', {
        sessionId: config.sessionId,
        containerId: existing.Id,
        state: existing.State,
      });
      if (existing.State !== 'running') {
        const container = docker.getContainer(existing.Id);
        await container.start();
        log.info('Started existing container', {
          sessionId: config.sessionId,
          containerId: existing.Id,
        });
      }
      return existing.Id;
    }

    // Build environment variables
    const envVars: string[] = [];
    if (config.githubToken) {
      envVars.push(`GITHUB_TOKEN=${config.githubToken}`);
    }
    // Set Gradle user home if shared cache is configured
    if (env.GRADLE_USER_HOME) {
      envVars.push('GRADLE_USER_HOME=/gradle-cache');
    }

    // Build volume binds
    // Use toHostPath() to convert container paths to host paths for Docker-in-Docker
    const binds = [
      `${toHostPath(config.workspacePath)}:/workspace`,
      `/var/run/docker.sock:/var/run/docker.sock`,
      `${env.CLAUDE_AUTH_PATH}:/home/claudeuser/.claude`,
    ];

    // Mount shared pnpm store if configured
    // pnpm's store is safe for concurrent access (atomic operations)
    if (env.PNPM_STORE_PATH) {
      binds.push(`${env.PNPM_STORE_PATH}:/pnpm-store`);
    }

    // Mount shared Gradle cache if configured
    // Gradle's cache is safe for concurrent access (file locking)
    if (env.GRADLE_USER_HOME) {
      binds.push(`${env.GRADLE_USER_HOME}:/gradle-cache`);
    }

    log.info('Creating new container', {
      sessionId: config.sessionId,
      image: CLAUDE_CODE_IMAGE,
      binds,
    });

    // Ensure the image is pulled before creating the container
    await ensureImagePulled(CLAUDE_CODE_IMAGE);

    const container = await docker.createContainer({
      Image: CLAUDE_CODE_IMAGE,
      name: containerName,
      Env: envVars,
      HostConfig: {
        Binds: binds,
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
    log.info('Container started', { sessionId: config.sessionId, containerId: container.id });

    // Configure git credential helper if token is provided
    if (config.githubToken) {
      await configureGitCredentials(container.id);
    }

    // Configure pnpm to use shared store if mounted
    if (env.PNPM_STORE_PATH) {
      await configurePnpmStore(container.id);
    }

    return container.id;
  } catch (error) {
    log.error('Failed to create/start container', toError(error), {
      sessionId: config.sessionId,
      containerName,
      image: CLAUDE_CODE_IMAGE,
    });
    throw error;
  }
}

async function configureGitCredentials(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);

  // Configure git to use a credential helper that reads from GITHUB_TOKEN env var
  // This script echoes the token for GitHub URLs
  // Note: git sends multiple lines (protocol=https, host=github.com, etc.)
  // so we must read all input with cat, not just one line with read
  const credentialHelper = `#!/bin/sh
if [ "$1" = "get" ]; then
  input=$(cat)
  if echo "$input" | grep -q "host=github.com"; then
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=$GITHUB_TOKEN"
  fi
fi`;

  // Write credential helper script
  const writeExec = await container.exec({
    Cmd: [
      'sh',
      '-c',
      `cat > /home/claudeuser/.git-credential-helper << 'SCRIPT'\n${credentialHelper}\nSCRIPT`,
    ],
    AttachStdout: true,
    AttachStderr: true,
    User: 'claudeuser',
  });
  await execAndWait(writeExec);

  // Make it executable
  const chmodExec = await container.exec({
    Cmd: ['chmod', '+x', '/home/claudeuser/.git-credential-helper'],
    AttachStdout: true,
    AttachStderr: true,
    User: 'claudeuser',
  });
  await execAndWait(chmodExec);

  // Configure git to use the credential helper
  const gitConfigExec = await container.exec({
    Cmd: [
      'git',
      'config',
      '--global',
      'credential.helper',
      '/home/claudeuser/.git-credential-helper',
    ],
    AttachStdout: true,
    AttachStderr: true,
    User: 'claudeuser',
  });
  await execAndWait(gitConfigExec);
}

async function execAndWait(exec: Docker.Exec): Promise<void> {
  const stream = await exec.start({ Detach: false, Tty: false });
  await new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('error', resolve);
    stream.resume(); // Consume the stream
  });
}

/**
 * Configure pnpm to use the shared store mounted at /pnpm-store.
 * pnpm's store is safe for concurrent access (atomic operations).
 */
async function configurePnpmStore(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);

  // Set pnpm global store-dir to use the mounted shared store
  const configExec = await container.exec({
    Cmd: ['pnpm', 'config', 'set', 'store-dir', '/pnpm-store'],
    AttachStdout: true,
    AttachStderr: true,
    User: 'claudeuser',
  });
  await execAndWait(configExec);

  log.info('Configured pnpm store-dir', { containerId });
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
): Promise<{ stream: Readable; execId: string }> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return { stream: stream as unknown as Readable, execId: exec.id };
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
  signal: string = 'INT'
): Promise<void> {
  log.debug('sendSignalToExec: Sending signal to PID', { containerId, pid, signal });
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['kill', `-${signal}`, pid.toString()],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  stream.resume();
  await new Promise<void>((resolve) => {
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        log.debug('sendSignalToExec: Signal sent', {
          containerId,
          pid,
          signal,
          exitCode: info.ExitCode,
        });
      } catch {
        log.debug('sendSignalToExec: Could not get exit code', { containerId, pid, signal });
      }
      resolve();
    });
    stream.on('error', (err) => {
      log.warn('sendSignalToExec: Error sending signal', {
        containerId,
        pid,
        signal,
        error: err.message,
      });
      resolve();
    });
  });
}

/**
 * Kill all processes matching a pattern in a container using pkill.
 * Useful for cleaning up background processes like tail -f.
 */
export async function killProcessesByPattern(containerId: string, pattern: string): Promise<void> {
  await signalProcessesByPattern(containerId, pattern, 'TERM');
}

/**
 * Send a signal to all processes matching a pattern in a container.
 */
export async function signalProcessesByPattern(
  containerId: string,
  pattern: string,
  signal: string = 'TERM'
): Promise<void> {
  log.debug('signalProcessesByPattern: Sending signal', { containerId, pattern, signal });
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['pkill', `-${signal}`, '-f', pattern],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  stream.resume(); // Consume stream so it ends
  await new Promise<void>((resolve) => {
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        log.debug('signalProcessesByPattern: Signal sent', {
          containerId,
          pattern,
          signal,
          exitCode: info.ExitCode,
        });
      } catch {
        log.debug('signalProcessesByPattern: Could not get exit code', {
          containerId,
          pattern,
          signal,
        });
      }
      resolve();
    });
    stream.on('error', (err) => {
      log.warn('signalProcessesByPattern: Error sending signal', {
        containerId,
        pattern,
        signal,
        error: err.message,
      });
      resolve();
    });
  });
}

export async function findProcessInContainer(
  containerId: string,
  processPattern: string
): Promise<number | null> {
  const container = docker.getContainer(containerId);

  // Use pgrep -f to match against the full command line
  const exec = await container.exec({
    Cmd: ['pgrep', '-f', processPattern],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false });

  return new Promise((resolve) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      // Strip Docker stream header if present
      output += stripDockerStreamHeader(chunk);
    });
    stream.on('end', () => {
      const pid = parseInt(output.trim().split('\n')[0], 10);
      const result = isNaN(pid) ? null : pid;
      log.debug('findProcessInContainer: Search complete', {
        containerId,
        processPattern,
        pid: result,
        rawOutput: output.trim().slice(0, 100),
      });
      resolve(result);
    });
    stream.on('error', () => {
      log.warn('findProcessInContainer: Stream error', { containerId, processPattern });
      resolve(null);
    });
  });
}

/**
 * Check if a specific process is running in a container
 */
export async function isProcessRunning(containerId: string, processName: string): Promise<boolean> {
  const pid = await findProcessInContainer(containerId, processName);
  return pid !== null;
}

/**
 * Execute a command in the background that writes output to a file.
 * Returns the exec ID which can be used with getExecStatus() to check completion.
 */
export async function execInContainerWithOutputFile(
  containerId: string,
  command: string[],
  outputFile: string
): Promise<{ execId: string }> {
  log.debug('execInContainerWithOutputFile: Starting', { containerId, command, outputFile });
  const container = docker.getContainer(containerId);

  // Wrap the command to redirect output to a file
  // Use sh -c to handle the redirection, with exec to replace sh with the actual command
  // This ensures signals (like SIGINT) go directly to the claude process, not to sh
  const wrappedCommand = [
    'sh',
    '-c',
    `exec ${command.map(escapeShellArg).join(' ')} > "${outputFile}" 2>&1`,
  ];
  log.debug('execInContainerWithOutputFile: Wrapped command', { wrappedCommand });

  const exec = await container.exec({
    Cmd: wrappedCommand,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    User: 'claudeuser',
  });

  // Start in detached mode
  await exec.start({ Detach: true, Tty: false });
  log.debug('execInContainerWithOutputFile: Started in detached mode', { execId: exec.id });

  return { execId: exec.id };
}

/**
 * Check the status of a Docker exec by its ID.
 * Returns running state and exit code (if finished).
 */
export async function getExecStatus(
  execId: string
): Promise<{ running: boolean; exitCode: number | null }> {
  const exec = docker.getExec(execId);
  const info = await exec.inspect();
  return {
    running: info.Running,
    exitCode: info.Running ? null : info.ExitCode,
  };
}

/**
 * Tail a file in a container, streaming new content as it's written.
 * Returns a readable stream of the file content.
 */
export async function tailFileInContainer(
  containerId: string,
  filePath: string,
  startLine: number = 0
): Promise<{ stream: Readable; execId: string }> {
  log.debug('tailFileInContainer: Starting', { containerId, filePath, startLine });
  const container = docker.getContainer(containerId);

  // Use tail -f to follow the file, starting from line N
  // +1 because tail uses 1-based line numbers and we want to skip 'startLine' lines
  const tailCmd = ['tail', '-n', `+${startLine + 1}`, '-f', filePath];
  log.debug('tailFileInContainer: Running tail command', { tailCmd });

  const exec = await container.exec({
    Cmd: tailCmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  log.debug('tailFileInContainer: Tail stream started', { execId: exec.id });

  return { stream: stream as unknown as Readable, execId: exec.id };
}

/**
 * Read the current contents of a file in a container.
 * Useful for catching up on missed output after reconnecting.
 */
export async function readFileInContainer(containerId: string, filePath: string): Promise<string> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['cat', filePath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      // Strip Docker header if present
      output += stripDockerStreamHeader(chunk);
    });
    stream.on('end', () => resolve(output));
    stream.on('error', reject);
  });
}

/**
 * Count lines in a file in a container
 */
export async function countLinesInContainer(
  containerId: string,
  filePath: string
): Promise<number> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['wc', '-l', filePath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += stripDockerStreamHeader(chunk);
    });
    stream.on('end', () => {
      const lineCount = parseInt(output.trim().split(/\s+/)[0], 10);
      resolve(isNaN(lineCount) ? 0 : lineCount);
    });
    stream.on('error', reject);
  });
}

/**
 * Check if a file exists in a container
 */
export async function fileExistsInContainer(
  containerId: string,
  filePath: string
): Promise<boolean> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['test', '-f', filePath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise((resolve) => {
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        const exists = info.ExitCode === 0;
        log.debug('fileExistsInContainer: Check complete', { containerId, filePath, exists });
        resolve(exists);
      } catch {
        log.warn('fileExistsInContainer: Check failed', { containerId, filePath });
        resolve(false);
      }
    });
    stream.on('error', () => {
      log.warn('fileExistsInContainer: Stream error', { containerId, filePath });
      resolve(false);
    });
    stream.resume(); // Consume the stream so 'end' event fires
  });
}

function escapeShellArg(arg: string): string {
  // Escape single quotes and wrap in single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function stripDockerStreamHeader(chunk: Buffer): string {
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
