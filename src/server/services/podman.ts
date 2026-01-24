import { spawn, ChildProcess } from 'child_process';
import { Readable, PassThrough } from 'stream';
import { existsSync } from 'fs';
import { env } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';
import { v4 as uuid } from 'uuid';

const log = createLogger('podman');

// Use env variable if set, otherwise default to local build
const CLAUDE_CODE_IMAGE = env.CLAUDE_RUNNER_IMAGE;

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
 * @param args - Arguments to pass to podman
 * @param useSudo - Run with sudo (needed when reading files with restricted permissions in containerized deployments)
 */
async function runPodman(args: string[], useSudo = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let command: string;
    let finalArgs: string[];

    if (useSudo) {
      // When using sudo, we need to preserve CONTAINER_HOST so sudo's podman
      // talks to the same Podman instance (via the socket) as the non-sudo commands.
      // Without this, sudo podman would use root's separate Podman instance.
      // The sudoers config allows CONTAINER_HOST via env_keep.
      command = 'sudo';
      finalArgs = ['--preserve-env=CONTAINER_HOST', 'podman', ...args];
    } else {
      command = 'podman';
      finalArgs = args;
    }

    log.debug('runPodman: Executing', { args: finalArgs, useSudo });
    const proc = spawn(command, finalArgs, { env: podmanEnv });
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
        log.debug('runPodman: Command failed', { args: finalArgs, code, stderr });
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
 * Set SKIP_IMAGE_PULL=true to skip pulling entirely (useful for testing local builds).
 */
async function ensureImagePulled(imageName: string): Promise<void> {
  // Skip pulling if explicitly disabled (useful for testing local image builds)
  if (env.SKIP_IMAGE_PULL) {
    log.debug('Skipping pull, SKIP_IMAGE_PULL is set', { imageName });
    return;
  }

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

export interface CloneConfig {
  sessionId: string;
  repoFullName: string;
  branch: string;
  githubToken?: string;
}

export interface CloneResult {
  repoPath: string; // Relative path to repo within workspace (e.g., "my-repo")
}

/**
 * Clone a repository into the workspaces volume using a temporary container.
 * This ensures the clone goes directly into the named volume, avoiding
 * permission issues between the service and runner containers.
 */
export async function cloneRepoInVolume(config: CloneConfig): Promise<CloneResult> {
  const containerName = `clone-${config.sessionId}`;
  log.info('Cloning repo in volume', {
    sessionId: config.sessionId,
    repoFullName: config.repoFullName,
    branch: config.branch,
  });

  const volumeName = `clawed-burrow-workspace-${config.sessionId}`;

  try {
    // Ensure the image is pulled before creating the container
    await ensureImagePulled(CLAUDE_CODE_IMAGE);

    // Create a dedicated volume for this session
    await runPodman(['volume', 'create', volumeName]);
    log.info('Created session volume', { sessionId: config.sessionId, volumeName });

    // Build the clone URL with token if provided
    const repoUrl = config.githubToken
      ? `https://${config.githubToken}@github.com/${config.repoFullName}.git`
      : `https://github.com/${config.repoFullName}.git`;

    // Extract repo name from full name (e.g., "owner/repo" -> "repo")
    const repoName = config.repoFullName.split('/')[1];

    // Create a temporary container with the session's volume mounted
    const createArgs = [
      'create',
      '--name',
      containerName,
      '--rm', // Auto-remove when stopped
      '-v',
      `${volumeName}:/workspace`,
      '-w',
      '/workspace',
      CLAUDE_CODE_IMAGE,
      'tail',
      '-f',
      '/dev/null',
    ];

    const containerId = (await runPodman(createArgs)).trim();
    log.info('Clone container created', { sessionId: config.sessionId, containerId });

    // Start the container
    await runPodman(['start', containerId]);

    try {
      // Clone the repository
      await runPodman([
        'exec',
        containerId,
        'git',
        'clone',
        '--branch',
        config.branch,
        '--single-branch',
        repoUrl,
        repoName,
      ]);

      // Configure the remote URL without the token for security
      await runPodman([
        'exec',
        containerId,
        'git',
        '-C',
        repoName,
        'remote',
        'set-url',
        'origin',
        `https://github.com/${config.repoFullName}.git`,
      ]);

      // Create and check out a session-specific branch
      const sessionBranch = `${env.SESSION_BRANCH_PREFIX}${config.sessionId}`;
      await runPodman([
        'exec',
        containerId,
        'git',
        '-C',
        repoName,
        'checkout',
        '-b',
        sessionBranch,
      ]);

      log.info('Repo cloned successfully', {
        sessionId: config.sessionId,
        repoName,
        branch: sessionBranch,
      });

      return { repoPath: repoName };
    } finally {
      // Always clean up the temporary container
      await runPodmanIgnoreErrors(['stop', containerId]);
      await runPodmanIgnoreErrors(['rm', '-f', containerId]);
    }
  } catch (error) {
    log.error('Failed to clone repo in volume', toError(error), {
      sessionId: config.sessionId,
      repoFullName: config.repoFullName,
    });
    // Clean up the volume if clone failed
    await runPodmanIgnoreErrors(['volume', 'rm', volumeName]);
    throw error;
  }
}

/**
 * Remove a session's workspace volume.
 */
export async function removeWorkspaceFromVolume(sessionId: string): Promise<void> {
  const volumeName = `clawed-burrow-workspace-${sessionId}`;
  log.info('Removing workspace volume', { sessionId, volumeName });

  try {
    await runPodman(['volume', 'rm', volumeName]);
    log.info('Workspace volume removed', { sessionId, volumeName });
  } catch (error) {
    log.error('Failed to remove workspace volume', toError(error), { sessionId, volumeName });
    // Don't throw - cleanup failures shouldn't block session deletion
  }
}

export interface ContainerConfig {
  sessionId: string;
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
    // Set Gradle user home to use the shared cache volume
    envArgs.push('-e', 'GRADLE_USER_HOME=/gradle-cache');
    // Add NVIDIA environment variables for GPU access
    envArgs.push('-e', 'NVIDIA_VISIBLE_DEVICES=all');
    envArgs.push('-e', 'NVIDIA_DRIVER_CAPABILITIES=all');
    // Set CONTAINER_HOST so podman/docker commands inside the container use the host's socket
    if (env.PODMAN_SOCKET_PATH) {
      envArgs.push('-e', 'CONTAINER_HOST=unix:///var/run/docker.sock');
    }

    // Build volume binds
    // Each session has its own dedicated volume for isolation
    const volumeName = `clawed-burrow-workspace-${config.sessionId}`;
    const volumeArgs: string[] = ['-v', `${volumeName}:/workspace`];

    // Mount shared pnpm store volume
    volumeArgs.push('-v', `${env.PNPM_STORE_VOLUME}:/pnpm-store`);
    // Mount shared Gradle cache volume
    volumeArgs.push('-v', `${env.GRADLE_CACHE_VOLUME}:/gradle-cache`);

    // Mount host's podman socket for container-in-container support (read-only)
    if (env.PODMAN_SOCKET_PATH) {
      volumeArgs.push('-v', `${env.PODMAN_SOCKET_PATH}:/var/run/docker.sock`);
    }

    // Working directory is the repo path inside the session's workspace
    // The session's workspace is mounted at /workspace, so the repo is at /workspace/{repoPath}
    const workingDir = config.repoPath ? `/workspace/${config.repoPath}` : '/workspace';

    log.info('Creating new container', {
      sessionId: config.sessionId,
      image: CLAUDE_CODE_IMAGE,
      workingDir,
    });

    // Ensure the image is pulled before creating the container
    await ensureImagePulled(CLAUDE_CODE_IMAGE);

    // GPU access via CDI (Container Device Interface) - requires nvidia-container-toolkit
    // and CDI specs generated via: nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
    const createArgs = [
      'create',
      '--name',
      containerName,
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

    // Copy Claude auth files into the container (instead of bind mounting)
    // This avoids permission issues and prevents agents from modifying auth config
    await copyClaudeAuth(containerId);

    // Configure git credential helper if token is provided
    if (config.githubToken) {
      await configureGitCredentials(containerId);
    }

    // Configure pnpm to use the shared store volume
    await configurePnpmStore(containerId);

    // Configure Gradle to use the shared cache volume
    await configureGradleCache(containerId);

    // Fix podman socket permissions if mounted
    if (env.PODMAN_SOCKET_PATH) {
      await fixPodmanSocketPermissions(containerId);
    }

    // Fix sudo permissions (rootless Podman without --userns=keep-id can break setuid)
    await fixSudoPermissions(containerId);

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

/**
 * Copy Claude auth files into the container.
 * We copy instead of bind mounting to:
 * 1. Avoid permission issues with rootless Podman
 * 2. Prevent agents from modifying the auth config
 * 3. Enable faster container startup (no --userns=keep-id needed for this)
 *
 * Uses sudo for the copy only when running inside a container, because the service
 * container may not have permission to read files like .credentials.json (which have
 * 600 permissions on the host). In local dev, the current user owns the files.
 *
 * Only copies essential auth files, not the entire .claude directory (which contains
 * large directories like file-history that aren't needed and can cause copy errors).
 */
async function copyClaudeAuth(containerId: string): Promise<void> {
  const claudeAuthDir = env.CLAUDE_AUTH_PATH;
  const claudeConfigFile = `${claudeAuthDir}.json`;

  // Only use sudo when running inside a container (where bind-mounted files may have
  // different ownership). In local dev, the current user can read their own files.
  const useSudo = isRunningInContainer();

  // Create the .claude directory in the container
  await runPodman(['exec', containerId, 'mkdir', '-p', '/home/claudeuser/.claude']);

  // Essential files for Claude auth - copy only what's needed
  const essentialFiles = ['.credentials.json', 'settings.json'];

  for (const file of essentialFiles) {
    const srcPath = `${claudeAuthDir}/${file}`;
    const destPath = `${containerId}:/home/claudeuser/.claude/${file}`;
    try {
      // Use sudo in container deployments to read files with restricted permissions
      await runPodman(['cp', srcPath, destPath], useSudo);
    } catch (error) {
      // settings.json may not exist, that's ok
      if (file !== '.credentials.json') {
        log.debug('Optional auth file not found', { file, error: toError(error).message });
      } else {
        throw error;
      }
    }
  }

  // Try to copy the .claude.json file (contains MCP configs and other settings)
  // This file is a sibling of .claude directory on the host, so it needs to be mounted separately
  // at /claude-auth.json (see README for the mount command)
  try {
    await runPodman(
      ['cp', claudeConfigFile, `${containerId}:/home/claudeuser/.claude.json`],
      useSudo
    );
  } catch (error) {
    log.warn('.claude.json file not found - MCP integrations will not work', {
      claudeConfigFile,
      error: toError(error).message,
    });
  }

  // Fix ownership (podman cp preserves host ownership which may not match container user)
  await runPodman([
    'exec',
    '--user',
    'root',
    containerId,
    'chown',
    '-R',
    'claudeuser:claudeuser',
    '/home/claudeuser/.claude',
    '/home/claudeuser/.claude.json',
  ]);

  log.info('Copied Claude auth files', { containerId });
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
 * Configure pnpm to use the shared store volume mounted at /pnpm-store.
 */
async function configurePnpmStore(containerId: string): Promise<void> {
  await runPodman(['exec', containerId, 'pnpm', 'config', 'set', 'store-dir', '/pnpm-store']);
  log.info('Configured pnpm store-dir', { containerId });
}

/**
 * Configure Gradle to use the shared cache volume mounted at /gradle-cache.
 */
async function configureGradleCache(containerId: string): Promise<void> {
  // Set GRADLE_USER_HOME in the container's environment profile
  await runPodman([
    'exec',
    containerId,
    'sh',
    '-c',
    'echo "export GRADLE_USER_HOME=/gradle-cache" >> /home/claudeuser/.profile',
  ]);
  log.info('Configured Gradle cache', { containerId });
}

/**
 * Fix podman socket permissions inside the container.
 * The mounted socket is owned by root, so we need to make it accessible to claudeuser.
 */
async function fixPodmanSocketPermissions(containerId: string): Promise<void> {
  // Make the socket world-readable/writable so claudeuser can access it
  await runPodman(['exec', '--user', 'root', containerId, 'chmod', '666', '/var/run/docker.sock']);
  log.info('Fixed podman socket permissions', { containerId });
}

/**
 * Fix sudo permissions inside the container.
 * In rootless Podman without --userns=keep-id, the sudo binary may lose its
 * setuid bit and root ownership from the container's perspective. This fixes
 * that by re-applying the correct ownership and permissions.
 */
async function fixSudoPermissions(containerId: string): Promise<void> {
  // Ensure sudo is owned by root and has the setuid bit set
  await runPodman([
    'exec',
    '--user',
    'root',
    containerId,
    'sh',
    '-c',
    'chown root:root /usr/bin/sudo && chmod 4755 /usr/bin/sudo',
  ]);
  log.info('Fixed sudo permissions', { containerId });
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
