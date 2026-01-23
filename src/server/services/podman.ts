import { spawn, ChildProcess } from 'child_process';
import { Readable, PassThrough } from 'stream';
import { existsSync } from 'fs';
import { env } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';
import { v4 as uuid } from 'uuid';

const log = createLogger('podman');

// Use env variable if set, otherwise default to local build
const CLAUDE_CODE_IMAGE = env.CLAUDE_RUNNER_IMAGE;

/**
 * Convert a container path to a host path for bind mounts.
 * In container-in-container setups, DATA_DIR is the path inside this container,
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
 * Track spawned exec processes so we can check their status later.
 */
interface TrackedProcess {
  process: ChildProcess;
  running: boolean;
  exitCode: number | null;
}
const trackedProcesses = new Map<string, TrackedProcess>();

/**
 * Check if we're running inside a container.
 * Podman creates /run/.containerenv, Docker creates /.dockerenv.
 */
function isRunningInContainer(): boolean {
  return existsSync('/run/.containerenv') || existsSync('/.dockerenv');
}

/**
 * Environment for podman commands.
 * In container-in-container setups, sets CONTAINER_HOST to use the Docker socket
 * mounted from the host. This is necessary because the inner Podman has limited
 * UID/GID mappings. In local dev, we don't set CONTAINER_HOST so podman uses
 * its default socket.
 */
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const podmanEnv: NodeJS.ProcessEnv = isRunningInContainer()
  ? { ...process.env, CONTAINER_HOST: `unix://${DOCKER_SOCKET_PATH}` }
  : { ...process.env };

/**
 * Run a podman command and return a promise that resolves with stdout.
 */
async function runPodman(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    log.debug('runPodman: Executing', { args });
    const proc = spawn('podman', args, { env: podmanEnv });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        log.debug('runPodman: Command failed', { args, code, stderr });
        reject(new Error(`podman command failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Run a podman command, ignoring non-zero exit codes.
 */
async function runPodmanIgnoreErrors(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    log.debug('runPodmanIgnoreErrors: Executing', { args });
    const proc = spawn('podman', args, { env: podmanEnv });
    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', () => {
      resolve(stdout);
    });

    proc.on('error', () => {
      resolve('');
    });
  });
}

/**
 * Ensure an image is up-to-date by pulling it.
 * Pulls are rate-limited to once per 5 minutes per image to avoid excessive pulls.
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

  try {
    await runPodman(['pull', imageName]);
    log.info('Image pull complete', { imageName });
    lastPullTime.set(imageName, Date.now());
  } catch (error) {
    log.error('Failed to pull image', toError(error), { imageName });
    throw error;
  }
}

export interface ContainerConfig {
  sessionId: string;
  workspacePath: string;
  repoPath: string; // Relative path to repo within workspace (e.g., "my-repo")
  githubToken?: string;
}

export async function createAndStartContainer(config: ContainerConfig): Promise<string> {
  const containerName = `claude-session-${config.sessionId}`;
  log.info('Creating container', { sessionId: config.sessionId, containerName });

  try {
    // Check if container already exists
    const existingOutput = await runPodmanIgnoreErrors([
      'ps',
      '-a',
      '--filter',
      `name=^${containerName}$`,
      '--format',
      '{{.ID}}\t{{.State}}',
    ]);

    const lines = existingOutput.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const [containerId, state] = lines[0].split('\t');
      log.info('Found existing container', {
        sessionId: config.sessionId,
        containerId,
        state,
      });

      if (state !== 'running') {
        await runPodman(['start', containerId]);
        log.info('Started existing container', {
          sessionId: config.sessionId,
          containerId,
        });
      }
      return containerId;
    }

    // Build environment variables
    const envArgs: string[] = [];
    if (config.githubToken) {
      envArgs.push('-e', `GITHUB_TOKEN=${config.githubToken}`);
    }
    // Set Gradle user home if shared cache is configured
    if (env.GRADLE_USER_HOME) {
      envArgs.push('-e', 'GRADLE_USER_HOME=/gradle-cache');
    }
    // Add NVIDIA environment variables for GPU access
    envArgs.push('-e', 'NVIDIA_VISIBLE_DEVICES=all');
    envArgs.push('-e', 'NVIDIA_DRIVER_CAPABILITIES=all');
    // Set CONTAINER_HOST so podman/docker commands inside the container use the host's socket
    if (env.PODMAN_SOCKET_PATH) {
      envArgs.push('-e', 'CONTAINER_HOST=unix:///var/run/docker.sock');
    }

    // Build volume binds
    // Use toHostPath() to convert container paths to host paths for container-in-container
    const volumeArgs: string[] = [
      '-v',
      `${toHostPath(config.workspacePath)}:/workspace`,
      '-v',
      `${env.CLAUDE_AUTH_PATH}:/home/claudeuser/.claude`,
    ];

    // Mount shared pnpm store if configured
    if (env.PNPM_STORE_PATH) {
      volumeArgs.push('-v', `${env.PNPM_STORE_PATH}:/pnpm-store`);
    }

    // Mount shared Gradle cache if configured
    if (env.GRADLE_USER_HOME) {
      volumeArgs.push('-v', `${env.GRADLE_USER_HOME}:/gradle-cache`);
    }

    // Mount host's podman socket for container-in-container support
    if (env.PODMAN_SOCKET_PATH) {
      volumeArgs.push('-v', `${env.PODMAN_SOCKET_PATH}:/var/run/docker.sock`);
    }

    // Working directory is the repo path inside the container workspace
    const workingDir = config.repoPath ? `/workspace/${config.repoPath}` : '/workspace';

    log.info('Creating new container', {
      sessionId: config.sessionId,
      image: CLAUDE_CODE_IMAGE,
      workingDir,
    });

    // Ensure the image is pulled before creating the container
    await ensureImagePulled(CLAUDE_CODE_IMAGE);

    // Create the container with --userns=keep-id for proper UID mapping
    // GPU access via CDI (Container Device Interface) - requires nvidia-container-toolkit
    // and CDI specs generated via: nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
    const createArgs = [
      'create',
      '--name',
      containerName,
      '--userns=keep-id',
      '--security-opt',
      'label=disable',
      '--device',
      'nvidia.com/gpu=all',
      '-w',
      workingDir,
      ...envArgs,
      ...volumeArgs,
      CLAUDE_CODE_IMAGE,
      'tail',
      '-f',
      '/dev/null', // Keep container running
    ];

    const containerId = (await runPodman(createArgs)).trim();
    log.info('Container created', { sessionId: config.sessionId, containerId });

    // Start the container
    await runPodman(['start', containerId]);
    log.info('Container started', { sessionId: config.sessionId, containerId });

    // Configure git credential helper if token is provided
    if (config.githubToken) {
      await configureGitCredentials(containerId);
    }

    // Configure pnpm to use shared store if mounted
    if (env.PNPM_STORE_PATH) {
      await configurePnpmStore(containerId);
    }

    return containerId;
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
  // Configure git to use a credential helper that reads from GITHUB_TOKEN env var
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
  await runPodman([
    'exec',
    containerId,
    'sh',
    '-c',
    `cat > /home/claudeuser/.git-credential-helper << 'SCRIPT'\n${credentialHelper}\nSCRIPT`,
  ]);

  // Make it executable
  await runPodman(['exec', containerId, 'chmod', '+x', '/home/claudeuser/.git-credential-helper']);

  // Configure git to use the credential helper
  await runPodman([
    'exec',
    containerId,
    'git',
    'config',
    '--global',
    'credential.helper',
    '/home/claudeuser/.git-credential-helper',
  ]);
}

/**
 * Configure pnpm to use the shared store mounted at /pnpm-store.
 */
async function configurePnpmStore(containerId: string): Promise<void> {
  await runPodman(['exec', containerId, 'pnpm', 'config', 'set', 'store-dir', '/pnpm-store']);
  log.info('Configured pnpm store-dir', { containerId });
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    await runPodman(['stop', '-t', '10', containerId]);
  } catch (error) {
    // Container might already be stopped
    if (!(error instanceof Error && error.message.includes('not running'))) {
      throw error;
    }
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  try {
    await runPodmanIgnoreErrors(['stop', '-t', '5', containerId]);
  } catch {
    // Ignore stop errors
  }
  try {
    await runPodmanIgnoreErrors(['rm', '-f', containerId]);
  } catch {
    // Ignore remove errors if already removed
  }
}

export async function execInContainer(
  containerId: string,
  command: string[]
): Promise<{ stream: Readable; execId: string }> {
  const execId = uuid();
  log.debug('execInContainer: Starting', { containerId, command, execId });

  const proc = spawn('podman', ['exec', containerId, ...command], { env: podmanEnv });

  // Combine stdout and stderr into a single stream
  const combinedStream = new PassThrough();
  proc.stdout.pipe(combinedStream, { end: false });
  proc.stderr.pipe(combinedStream, { end: false });

  // Track when both streams are done
  let stdoutEnded = false;
  let stderrEnded = false;
  const checkEnd = () => {
    if (stdoutEnded && stderrEnded) {
      combinedStream.end();
    }
  };
  proc.stdout.on('end', () => {
    stdoutEnded = true;
    checkEnd();
  });
  proc.stderr.on('end', () => {
    stderrEnded = true;
    checkEnd();
  });

  // Track the process
  const tracked: TrackedProcess = { process: proc, running: true, exitCode: null };
  trackedProcesses.set(execId, tracked);

  proc.on('close', (code) => {
    tracked.running = false;
    tracked.exitCode = code;
  });

  proc.on('error', (err) => {
    log.error('execInContainer: Process error', toError(err), { containerId, execId });
    tracked.running = false;
    tracked.exitCode = 1;
  });

  return { stream: combinedStream, execId };
}

export async function getContainerStatus(
  containerId: string
): Promise<'running' | 'stopped' | 'not_found'> {
  try {
    const output = await runPodman(['inspect', '--format', '{{.State.Running}}', containerId]);
    const isRunning = output.trim() === 'true';
    return isRunning ? 'running' : 'stopped';
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
  try {
    await runPodman(['exec', containerId, 'kill', `-${signal}`, pid.toString()]);
    log.debug('sendSignalToExec: Signal sent', { containerId, pid, signal });
  } catch (error) {
    log.warn('sendSignalToExec: Error sending signal', {
      containerId,
      pid,
      signal,
      error: toError(error).message,
    });
  }
}

/**
 * Kill all processes matching a pattern in a container using pkill.
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
  try {
    await runPodmanIgnoreErrors(['exec', containerId, 'pkill', `-${signal}`, '-f', pattern]);
    log.debug('signalProcessesByPattern: Signal sent', { containerId, pattern, signal });
  } catch {
    log.debug('signalProcessesByPattern: Could not send signal (process may not exist)', {
      containerId,
      pattern,
      signal,
    });
  }
}

export async function findProcessInContainer(
  containerId: string,
  processPattern: string
): Promise<number | null> {
  try {
    const output = await runPodmanIgnoreErrors([
      'exec',
      containerId,
      'pgrep',
      '-f',
      processPattern,
    ]);
    const pid = parseInt(output.trim().split('\n')[0], 10);
    const result = isNaN(pid) ? null : pid;
    log.debug('findProcessInContainer: Search complete', {
      containerId,
      processPattern,
      pid: result,
    });
    return result;
  } catch {
    log.warn('findProcessInContainer: Error', { containerId, processPattern });
    return null;
  }
}

/**
 * Check if a specific process is running in a container
 */
export async function isProcessRunning(containerId: string, processName: string): Promise<boolean> {
  const pid = await findProcessInContainer(containerId, processName);
  return pid !== null;
}
/**
 * Execute a command in attached mode, streaming output while also writing to a file for recovery.
 * Uses `tee` to write to both stdout (which we capture) and a file (for crash recovery).
 * Uses `stdbuf -oL` to disable buffering so output flows immediately.
 */
export async function execInContainerWithTee(
  containerId: string,
  command: string[],
  outputFile: string
): Promise<{ stream: Readable; execId: string }> {
  log.info('execInContainerWithTee: Starting', {
    containerId,
    command: command.slice(0, 3),
    outputFile,
  });

  const execId = uuid();

  // Build the command with tee and line-buffered output
  const wrappedCommand = `stdbuf -oL ${command.map(escapeShellArg).join(' ')} 2>&1 | tee "${outputFile}"`;
  log.info('execInContainerWithTee: Spawning podman exec', { containerId, wrappedCommand });

  const proc = spawn('podman', ['exec', containerId, 'sh', '-c', wrappedCommand], {
    env: podmanEnv,
  });

  log.info('execInContainerWithTee: Spawn returned', { execId, pid: proc.pid });

  // Track the process
  const tracked: TrackedProcess = { process: proc, running: true, exitCode: null };
  trackedProcesses.set(execId, tracked);

  proc.on('close', (code) => {
    tracked.running = false;
    tracked.exitCode = code;
  });

  proc.on('error', (err) => {
    log.error('execInContainerWithTee: Process error', toError(err), { containerId, execId });
    tracked.running = false;
    tracked.exitCode = 1;
  });

  log.debug('execInContainerWithTee: Started', { execId });

  // Return stdout as the stream (stderr is merged via 2>&1 in the command)
  return { stream: proc.stdout, execId };
}

/**
 * Check the status of a tracked exec process by its ID.
 * Returns running state and exit code (if finished).
 */
export async function getExecStatus(
  execId: string
): Promise<{ running: boolean; exitCode: number | null }> {
  const tracked = trackedProcesses.get(execId);
  if (!tracked) {
    // Process not found - assume it finished
    return { running: false, exitCode: null };
  }
  return {
    running: tracked.running,
    exitCode: tracked.running ? null : tracked.exitCode,
  };
}

/**
 * Tail a file in a container, streaming new content as it's written.
 */
export async function tailFileInContainer(
  containerId: string,
  filePath: string,
  startLine: number = 0
): Promise<{ stream: Readable; execId: string }> {
  log.debug('tailFileInContainer: Starting', { containerId, filePath, startLine });

  const execId = uuid();

  // Use tail -f to follow the file, starting from line N
  const proc = spawn(
    'podman',
    ['exec', containerId, 'tail', '-n', `+${startLine + 1}`, '-f', filePath],
    { env: podmanEnv }
  );

  // Track the process
  const tracked: TrackedProcess = { process: proc, running: true, exitCode: null };
  trackedProcesses.set(execId, tracked);

  proc.on('close', (code) => {
    tracked.running = false;
    tracked.exitCode = code;
  });

  log.debug('tailFileInContainer: Tail stream started', { execId });

  return { stream: proc.stdout, execId };
}

/**
 * Read the current contents of a file in a container.
 */
export async function readFileInContainer(containerId: string, filePath: string): Promise<string> {
  return runPodman(['exec', containerId, 'cat', filePath]);
}

/**
 * Check if a file exists in a container
 */
export async function fileExistsInContainer(
  containerId: string,
  filePath: string
): Promise<boolean> {
  try {
    await runPodman(['exec', containerId, 'test', '-f', filePath]);
    log.debug('fileExistsInContainer: Check complete', { containerId, filePath, exists: true });
    return true;
  } catch {
    log.debug('fileExistsInContainer: Check complete', { containerId, filePath, exists: false });
    return false;
  }
}

function escapeShellArg(arg: string): string {
  // Escape single quotes and wrap in single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
