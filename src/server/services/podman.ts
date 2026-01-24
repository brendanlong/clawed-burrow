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
 * Run a podman command in the background without waiting for it to complete.
 * Fire-and-forget - no result is returned.
 * Useful for cleanup operations that don't need to block.
 */
function runPodmanBackground(args: string[]): void {
  log.debug('runPodmanBackground: Starting', { args });
  const proc = spawn('podman', args, {
    env: podmanEnv,
    stdio: 'ignore',
    detached: true,
  });
  // unref() allows the parent process to exit without waiting for this child
  proc.unref();
}

/**
 * Clean up a temporary container in the background.
 * Uses SIGKILL for instant termination since we don't need graceful shutdown.
 * This avoids the 10-second default stop timeout.
 */
function cleanupContainerBackground(containerId: string): void {
  log.debug('cleanupContainerBackground: Cleaning up', { containerId });
  // Use rm -f which sends SIGKILL and removes in one step
  // Much faster than stop (which waits for graceful shutdown) + rm
  runPodmanBackground(['rm', '-f', containerId]);
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

/**
 * Convert a repo full name (e.g., "owner/repo") to a cache-safe path.
 * Uses double-dash to separate owner and repo since slashes aren't valid in paths.
 */
function repoCachePath(repoFullName: string): string {
  return `/cache/${repoFullName.replace('/', '--')}.git`;
}

/**
 * Ensure the git cache volume exists, creating it if necessary.
 */
async function ensureGitCacheVolume(): Promise<void> {
  const volumeName = env.GIT_CACHE_VOLUME;
  try {
    // Check if volume exists
    await runPodman(['volume', 'inspect', volumeName]);
  } catch {
    // Volume doesn't exist, create it
    log.info('Creating git cache volume', { volumeName });
    await runPodman(['volume', 'create', volumeName]);
  }
}

/**
 * Update or create a bare repo cache for a given repository.
 * If the cache exists, fetches latest refs. If not, clones a new bare repo.
 * This is done in a temporary container to ensure proper permissions.
 *
 * @returns true if cache is ready to use as --reference, false if caching failed
 */
async function updateGitCache(repoFullName: string, githubToken?: string): Promise<boolean> {
  const containerName = `git-cache-${uuid().slice(0, 8)}`;
  const cachePath = repoCachePath(repoFullName);

  // Build the repo URL with token if provided
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  log.info('Updating git cache', { repoFullName, cachePath });

  try {
    await ensureGitCacheVolume();

    // Create a temporary container with the cache volume mounted
    const createArgs = [
      'create',
      '--name',
      containerName,
      '--rm',
      '-v',
      `${env.GIT_CACHE_VOLUME}:/cache`,
      '-w',
      '/cache',
      CLAUDE_CODE_IMAGE,
      'sleep',
      'infinity',
    ];

    const containerId = (await runPodman(createArgs)).trim();
    await runPodman(['start', containerId]);

    try {
      // Check if the cache repo already exists
      const lsResult = await runPodmanIgnoreErrors(['exec', containerId, 'ls', '-d', cachePath]);
      const cacheExists = lsResult.trim() === cachePath;

      if (cacheExists) {
        // Cache exists - fetch latest refs
        log.info('Fetching updates for cached repo', { repoFullName });
        await runPodman(['exec', containerId, 'git', '-C', cachePath, 'fetch', '--all', '--prune']);
      } else {
        // Cache doesn't exist - clone a bare repo
        log.info('Creating new bare repo cache', { repoFullName });

        // Ensure the parent directory exists
        const parentDir = cachePath.substring(0, cachePath.lastIndexOf('/'));
        await runPodman(['exec', containerId, 'mkdir', '-p', parentDir]);

        await runPodman(['exec', containerId, 'git', 'clone', '--bare', repoUrl, cachePath]);

        // Remove the token from the remote URL for security
        await runPodman([
          'exec',
          containerId,
          'git',
          '-C',
          cachePath,
          'remote',
          'set-url',
          'origin',
          `https://github.com/${repoFullName}.git`,
        ]);
      }

      log.info('Git cache updated successfully', { repoFullName });
      return true;
    } finally {
      // Clean up the temporary container in the background
      // This avoids the ~10 second stop timeout since we use rm -f (SIGKILL)
      cleanupContainerBackground(containerId);
    }
  } catch (error) {
    log.warn(
      'Failed to update git cache, will clone without reference',
      { repoFullName },
      toError(error)
    );
    return false;
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
 *
 * Uses a git reference cache when available to speed up clones.
 * The cache stores bare repos that are fetched on each clone to stay current.
 * If caching fails, falls back to a normal clone.
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

    // Update or create the git cache for this repo
    // This fetches latest refs so the clone will be fast and current
    const useCache = await updateGitCache(config.repoFullName, config.githubToken);
    const cachePath = repoCachePath(config.repoFullName);

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
    // Also mount the git cache volume if we're using it
    const createArgs = [
      'create',
      '--name',
      containerName,
      '--rm', // Auto-remove when stopped
      '-v',
      `${volumeName}:/workspace`,
      ...(useCache ? ['-v', `${env.GIT_CACHE_VOLUME}:/cache:ro`] : []),
      '-w',
      '/workspace',
      CLAUDE_CODE_IMAGE,
      'sleep',
      'infinity',
    ];

    const containerId = (await runPodman(createArgs)).trim();
    log.info('Clone container created', { sessionId: config.sessionId, containerId, useCache });

    // Start the container
    await runPodman(['start', containerId]);

    try {
      // Clone the repository, using --reference if cache is available
      // --dissociate ensures the clone is independent even if the cache is deleted later
      const cloneArgs = [
        'exec',
        containerId,
        'git',
        'clone',
        '--branch',
        config.branch,
        '--single-branch',
        ...(useCache ? ['--reference', cachePath, '--dissociate'] : []),
        repoUrl,
        repoName,
      ];
      await runPodman(cloneArgs);

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
      // Clean up the temporary container in the background
      // This avoids the ~10 second stop timeout since we use rm -f (SIGKILL)
      cleanupContainerBackground(containerId);
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
      'sleep',
      'infinity', // Keep container running (responds to SIGTERM unlike tail -f)
    ];

    const containerId = (await runPodman(createArgs)).trim();
    log.info('Container created', { sessionId: config.sessionId, containerId });

    // Start the container
    await runPodman(['start', containerId]);
    log.info('Container started', { sessionId: config.sessionId, containerId });

    // Configure the container - run independent setup tasks in parallel for speed
    // These tasks don't depend on each other and can all run concurrently
    const setupTasks: Promise<void>[] = [
      // Copy Claude auth files into the container (instead of bind mounting)
      // This avoids permission issues and prevents agents from modifying auth config
      copyClaudeAuth(containerId),
      // Configure pnpm to use the shared store volume
      configurePnpmStore(containerId),
      // Configure Gradle to use the shared cache volume
      configureGradleCache(containerId),
      // Fix sudo permissions (rootless Podman without --userns=keep-id can break setuid)
      fixSudoPermissions(containerId),
    ];

    // Configure git credential helper if token is provided
    if (config.githubToken) {
      setupTasks.push(configureGitCredentials(containerId));
    }

    // Fix podman socket permissions if mounted
    if (env.PODMAN_SOCKET_PATH) {
      setupTasks.push(fixPodmanSocketPermissions(containerId));
    }

    await Promise.all(setupTasks);

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

  // Handle .claude.json (contains MCP configs and other settings)
  // Only write this file if CLAUDE_CONFIG_JSON is explicitly set.
  // We do NOT copy from host by default because the host's file may contain
  // Claude.ai's automatically configured MCP server proxies, which aren't
  // appropriate for --dangerously-skip-permissions mode.
  // Claude Code will create a new .claude.json if one doesn't exist.
  if (env.CLAUDE_CONFIG_JSON) {
    // Write the explicit config to the container
    await runPodman([
      'exec',
      containerId,
      'sh',
      '-c',
      `cat > /home/claudeuser/.claude.json << 'CONFIGEOF'\n${env.CLAUDE_CONFIG_JSON}\nCONFIGEOF`,
    ]);
    log.info('Wrote explicit Claude config JSON', { containerId });
  } else {
    log.debug('CLAUDE_CONFIG_JSON not set - Claude Code will create .claude.json on first run');
  }

  // Fix ownership (podman cp preserves host ownership which may not match container user)
  // Use sh -c with conditional to handle case where .claude.json might not exist
  await runPodman([
    'exec',
    '--user',
    'root',
    containerId,
    'sh',
    '-c',
    'chown -R claudeuser:claudeuser /home/claudeuser/.claude && ' +
      '[ -f /home/claudeuser/.claude.json ] && chown claudeuser:claudeuser /home/claudeuser/.claude.json || true',
  ]);

  log.info('Set up Claude auth files', { containerId });
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
 * This may fail in nested container scenarios where the socket is a bind mount
 * that can't have its permissions changed - in that case, we log and continue.
 */
async function fixPodmanSocketPermissions(containerId: string): Promise<void> {
  try {
    // Make the socket world-readable/writable so claudeuser can access it
    await runPodman([
      'exec',
      '--user',
      'root',
      containerId,
      'chmod',
      '666',
      '/var/run/docker.sock',
    ]);
    log.info('Fixed podman socket permissions', { containerId });
  } catch (error) {
    // This can fail in nested container scenarios where the socket is a bind mount
    // from the host and can't have its permissions changed. Log and continue -
    // the socket may already have appropriate permissions.
    log.warn(
      'Could not change podman socket permissions (may already be accessible)',
      undefined,
      toError(error)
    );
  }
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

/**
 * Verify a container is fully initialized and healthy.
 * Runs a simple command to ensure the container can execute processes.
 * Returns true if healthy, throws an error if not.
 */
export async function verifyContainerHealth(containerId: string): Promise<void> {
  log.debug('Verifying container health', { containerId });

  // First check container status
  const state = await getContainerState(containerId);
  if (state.status !== 'running') {
    const logs = await getContainerLogs(containerId, { tail: 30 });
    throw new Error(
      `Container is not running (status: ${state.status}, exit code: ${state.exitCode}, error: ${state.error})${logs ? `\nLogs:\n${logs}` : ''}`
    );
  }

  // Try to run a simple command to verify the container is responsive
  try {
    await runPodman(['exec', containerId, 'echo', 'health-check']);
  } catch (error) {
    const logs = await getContainerLogs(containerId, { tail: 30 });
    throw new Error(
      `Container health check failed: ${toError(error).message}${logs ? `\nLogs:\n${logs}` : ''}`
    );
  }

  // Verify the claude command is available
  try {
    await runPodman(['exec', containerId, 'which', 'claude']);
  } catch (error) {
    throw new Error(`Claude CLI not available in container: ${toError(error).message}`);
  }

  log.debug('Container health verified', { containerId });
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

/**
 * Detailed container state information for diagnostics.
 */
export interface ContainerState {
  status: 'running' | 'stopped' | 'not_found';
  exitCode: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  oomKilled: boolean;
}

/**
 * Get detailed container state information.
 * Returns more diagnostic info than getContainerStatus for error investigation.
 */
export async function getContainerState(containerId: string): Promise<ContainerState> {
  try {
    // Use JSON format for reliable parsing of multiple fields
    const output = await runPodman(['inspect', '--format', '{{json .State}}', containerId]);
    const state = JSON.parse(output.trim());
    return {
      status: state.Running ? 'running' : 'stopped',
      exitCode: state.ExitCode ?? null,
      error: state.Error || null,
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
      oomKilled: state.OOMKilled ?? false,
    };
  } catch {
    return {
      status: 'not_found',
      exitCode: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      oomKilled: false,
    };
  }
}

/**
 * Get recent logs from a container.
 * Useful for diagnosing container failures or process crashes.
 *
 * @param containerId - The container ID
 * @param options - Options for log retrieval
 * @returns Container logs or null if unavailable
 */
export async function getContainerLogs(
  containerId: string,
  options: {
    tail?: number; // Number of lines from the end (default: 100)
    since?: string; // Show logs since timestamp (e.g., "10m" for 10 minutes ago)
  } = {}
): Promise<string | null> {
  const { tail = 100, since } = options;

  try {
    const args = ['logs', '--tail', tail.toString()];
    if (since) {
      args.push('--since', since);
    }
    args.push(containerId);

    const output = await runPodman(args);
    return output || null;
  } catch (error) {
    log.debug('Failed to get container logs', { containerId, error: toError(error).message });
    return null;
  }
}

/**
 * Container info returned from listSessionContainers.
 */
export interface SessionContainerInfo {
  containerId: string;
  sessionId: string;
  status: 'running' | 'stopped';
}

/**
 * List all claude-session-* containers and their status.
 * Returns container ID, session ID (extracted from name), and running status.
 */
export async function listSessionContainers(): Promise<SessionContainerInfo[]> {
  try {
    // Use filter to only get containers with our naming pattern
    // Format: ID<tab>Name<tab>State
    const output = await runPodman([
      'ps',
      '-a',
      '--filter',
      'name=^claude-session-',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.State}}',
    ]);

    const containers: SessionContainerInfo[] = [];
    const lines = output.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const [containerId, name, state] = line.split('\t');
      // Extract session ID from container name (format: claude-session-{sessionId})
      const sessionIdMatch = name?.match(/^claude-session-(.+)$/);
      if (sessionIdMatch && containerId) {
        // State can be either "running" (direct podman) or "Up X minutes" (via Docker socket)
        const isRunning = state === 'running' || state?.toLowerCase().startsWith('up ');
        containers.push({
          containerId: containerId.trim(),
          sessionId: sessionIdMatch[1],
          status: isRunning ? 'running' : 'stopped',
        });
      }
    }

    return containers;
  } catch (error) {
    log.error('Failed to list session containers', toError(error));
    return [];
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
 * Result of checking exec status.
 */
export interface ExecStatus {
  running: boolean;
  exitCode: number | null;
  /** True if the exec was not found (e.g., server restarted) */
  notFound: boolean;
}

/**
 * Check the status of a tracked exec process by its ID.
 * Returns running state and exit code (if finished).
 */
export async function getExecStatus(execId: string): Promise<ExecStatus> {
  const tracked = trackedProcesses.get(execId);
  if (!tracked) {
    // Process not found - could be server restart or exec ID from before restart
    return { running: false, exitCode: null, notFound: true };
  }
  return {
    running: tracked.running,
    exitCode: tracked.running ? null : tracked.exitCode,
    notFound: false,
  };
}

/**
 * Check if an exit code indicates an error.
 */
export function isErrorExitCode(exitCode: number | null): boolean {
  return exitCode !== null && exitCode !== 0;
}

/**
 * Get a human-readable description of an exit code.
 */
export function describeExitCode(exitCode: number | null): string {
  if (exitCode === null) {
    return 'unknown exit code';
  }
  if (exitCode === 0) {
    return 'success';
  }
  // Common signal exit codes (128 + signal number)
  if (exitCode === 137) {
    return 'killed (SIGKILL) - possibly out of memory';
  }
  if (exitCode === 139) {
    return 'segmentation fault (SIGSEGV)';
  }
  if (exitCode === 143) {
    return 'terminated (SIGTERM)';
  }
  if (exitCode === 130) {
    return 'interrupted (SIGINT)';
  }
  if (exitCode > 128) {
    return `killed by signal ${exitCode - 128}`;
  }
  return `error code ${exitCode}`;
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
