import { watch, type FSWatcher } from 'fs';
import { existsSync, statSync } from 'fs';
import { env } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';
import { listSessionContainers, copyClaudeAuth } from './podman';

const log = createLogger('credential-watcher');

// Debounce interval for credential updates (avoid rapid file system events)
const DEBOUNCE_INTERVAL_MS = 1000;

// Essential credential files to watch
const CREDENTIAL_FILES = ['.credentials.json', 'settings.json'];

// Track the file watcher
let watcher: FSWatcher | null = null;

// Track debounce timer
let debounceTimer: NodeJS.Timeout | null = null;

// Track last push time to avoid duplicate pushes
let lastPushTime = 0;

/**
 * Push credentials to all running containers.
 */
export async function pushCredentialsToAllContainers(): Promise<{
  updated: number;
  failed: number;
}> {
  const containers = await listSessionContainers();
  const runningContainers = containers.filter((c) => c.status === 'running');

  log.info('Pushing credentials to all running containers', {
    count: runningContainers.length,
  });

  let updated = 0;
  let failed = 0;

  for (const container of runningContainers) {
    try {
      await copyClaudeAuth(container.containerId);
      updated++;
    } catch (error) {
      log.error('Failed to push credentials to container', toError(error), {
        containerId: container.containerId,
        sessionId: container.sessionId,
      });
      failed++;
    }
  }

  log.info('Finished pushing credentials to containers', { updated, failed });
  return { updated, failed };
}

/**
 * Handle a credential file change event.
 * Debounces rapid changes to avoid pushing credentials multiple times.
 */
function handleCredentialChange(filename: string | null): void {
  // Only process changes to our credential files
  if (filename && !CREDENTIAL_FILES.includes(filename)) {
    return;
  }

  log.info('Credential file changed', { filename });

  // Clear any existing debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Set a new debounce timer
  debounceTimer = setTimeout(async () => {
    const now = Date.now();
    // Avoid duplicate pushes within the debounce interval
    if (now - lastPushTime < DEBOUNCE_INTERVAL_MS) {
      log.debug('Skipping credential push, too soon after last push');
      return;
    }

    lastPushTime = now;

    try {
      const result = await pushCredentialsToAllContainers();
      if (result.updated > 0 || result.failed > 0) {
        log.info('Credential update complete', result);
      }
    } catch (error) {
      log.error('Failed to push credentials after file change', toError(error));
    }
  }, DEBOUNCE_INTERVAL_MS);
}

/**
 * Start watching the Claude auth directory for changes.
 * When credential files change, they are automatically pushed to all running containers.
 */
export function startCredentialWatcher(): void {
  if (watcher) {
    log.warn('Credential watcher already running');
    return;
  }

  const claudeAuthDir = env.CLAUDE_AUTH_PATH;

  // Check if the directory exists
  if (!existsSync(claudeAuthDir)) {
    log.warn('Claude auth directory does not exist, skipping credential watcher', {
      path: claudeAuthDir,
    });
    return;
  }

  // Verify it's a directory
  const stats = statSync(claudeAuthDir);
  if (!stats.isDirectory()) {
    log.warn('Claude auth path is not a directory, skipping credential watcher', {
      path: claudeAuthDir,
    });
    return;
  }

  log.info('Starting credential watcher', { path: claudeAuthDir });

  watcher = watch(claudeAuthDir, { persistent: false }, (eventType, filename) => {
    log.debug('File system event', { eventType, filename });

    // Only handle 'change' and 'rename' events for our credential files
    if (eventType === 'change' || eventType === 'rename') {
      handleCredentialChange(filename);
    }
  });

  watcher.on('error', (error) => {
    log.error('Credential watcher error', toError(error));
    // Try to restart the watcher
    stopCredentialWatcher();
    setTimeout(() => {
      startCredentialWatcher();
    }, 5000);
  });

  // Clean up on process exit
  process.on('beforeExit', () => {
    stopCredentialWatcher();
  });
}

/**
 * Stop watching the Claude auth directory.
 */
export function stopCredentialWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    log.info('Stopped credential watcher');
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
