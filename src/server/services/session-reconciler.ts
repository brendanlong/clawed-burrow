import { prisma } from '@/lib/prisma';
import { getContainerStatus, listSessionContainers, removeContainer } from './podman';
import { createLogger, toError } from '@/lib/logger';
import type { SessionStatus } from '@/lib/types';

const log = createLogger('session-reconciler');

// Polling interval for background reconciliation (5 minutes)
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

// Track if background polling is active
let reconciliationIntervalId: NodeJS.Timeout | null = null;

/**
 * Result of reconciling sessions with Podman containers.
 */
export interface ReconciliationResult {
  /** Total sessions checked */
  sessionsChecked: number;
  /** Sessions updated to match container state */
  sessionsUpdated: number;
  /** Orphaned containers found (running but no DB session) */
  orphanedContainersCleaned: number;
  /** Sessions that were marked as stopped because container was gone */
  sessionsMarkedStopped: number;
  /** Sessions that were marked as running because container was running */
  sessionsMarkedRunning: number;
}

/**
 * Reconcile all sessions with actual Podman container states.
 * This function:
 * 1. Updates DB session status to match actual container state
 * 2. Cleans up orphaned containers (running containers with no matching session)
 * 3. Does NOT delete sessions - just marks them as stopped if container is gone
 *
 * Should be called at startup and periodically to stay in sync.
 */
export async function reconcileSessionsWithPodman(): Promise<ReconciliationResult> {
  log.info('Starting session reconciliation with Podman');

  const result: ReconciliationResult = {
    sessionsChecked: 0,
    sessionsUpdated: 0,
    orphanedContainersCleaned: 0,
    sessionsMarkedStopped: 0,
    sessionsMarkedRunning: 0,
  };

  try {
    // Get all sessions from DB that have container IDs
    // (ignore 'creating' sessions as they may be in the process of starting)
    const sessions = await prisma.session.findMany({
      where: {
        status: {
          notIn: ['creating'],
        },
      },
    });

    // Get all actual containers from Podman
    const containers = await listSessionContainers();
    const containersBySessionId = new Map(containers.map((c) => [c.sessionId, c]));

    // Check each DB session against actual container state
    for (const session of sessions) {
      result.sessionsChecked++;

      const container = containersBySessionId.get(session.id);
      let newStatus: SessionStatus | null = null;

      if (!container && session.containerId) {
        // Container doesn't exist but session thinks it's running/stopped with a containerId
        // Check container status directly by ID to handle name mismatches
        const containerStatus = await getContainerStatus(session.containerId);

        if (containerStatus === 'not_found') {
          // Container truly doesn't exist - mark session as stopped
          if (session.status === 'running') {
            newStatus = 'stopped';
            result.sessionsMarkedStopped++;
            log.info('Container not found, marking session as stopped', {
              sessionId: session.id,
              previousStatus: session.status,
              containerId: session.containerId,
            });
          }
        } else if (containerStatus === 'running' && session.status === 'stopped') {
          // Container is running but session marked as stopped - update status
          newStatus = 'running';
          result.sessionsMarkedRunning++;
          log.info('Container running but session marked stopped, updating', {
            sessionId: session.id,
            previousStatus: session.status,
          });
        } else if (containerStatus === 'stopped' && session.status === 'running') {
          // Container is stopped but session marked as running - update status
          newStatus = 'stopped';
          result.sessionsMarkedStopped++;
          log.info('Container stopped but session marked running, updating', {
            sessionId: session.id,
            previousStatus: session.status,
          });
        }
      } else if (container) {
        // Container exists - sync status
        if (container.status === 'running' && session.status === 'stopped') {
          newStatus = 'running';
          result.sessionsMarkedRunning++;
          log.info('Container running but session marked stopped, updating', {
            sessionId: session.id,
            previousStatus: session.status,
          });
        } else if (container.status === 'stopped' && session.status === 'running') {
          newStatus = 'stopped';
          result.sessionsMarkedStopped++;
          log.info('Container stopped but session marked running, updating', {
            sessionId: session.id,
            previousStatus: session.status,
          });
        }

        // Also update container ID if it doesn't match (container was recreated)
        if (session.containerId !== container.containerId) {
          log.info('Updating session container ID', {
            sessionId: session.id,
            oldContainerId: session.containerId,
            newContainerId: container.containerId,
          });
          await prisma.session.update({
            where: { id: session.id },
            data: { containerId: container.containerId },
          });
          result.sessionsUpdated++;
        }
      }

      // Update session status if changed
      if (newStatus !== null) {
        await prisma.session.update({
          where: { id: session.id },
          data: { status: newStatus },
        });
        result.sessionsUpdated++;
      }
    }

    // Find orphaned containers (containers with no matching session in DB)
    const sessionIds = new Set(sessions.map((s) => s.id));
    for (const container of containers) {
      if (!sessionIds.has(container.sessionId)) {
        // This container has no matching session - it's orphaned
        // Check if session exists at all (might be in 'creating' state)
        const sessionExists = await prisma.session.findUnique({
          where: { id: container.sessionId },
          select: { id: true },
        });

        if (!sessionExists) {
          log.info('Found orphaned container, removing', {
            containerId: container.containerId,
            sessionId: container.sessionId,
            status: container.status,
          });

          try {
            await removeContainer(container.containerId);
            result.orphanedContainersCleaned++;
          } catch (error) {
            log.warn(
              'Failed to remove orphaned container',
              { containerId: container.containerId },
              toError(error)
            );
          }
        }
      }
    }

    log.info('Session reconciliation complete', { ...result });
    return result;
  } catch (error) {
    log.error('Session reconciliation failed', toError(error));
    throw error;
  }
}

/**
 * Sync a single session's status with its actual container state.
 * Called when interacting with a session to ensure we have accurate state.
 * Returns the updated session status if changed, null if no change needed.
 */
export async function syncSessionStatus(sessionId: string): Promise<SessionStatus | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session || !session.containerId) {
    return null;
  }

  // Skip sessions in transitional states
  if (session.status === 'creating') {
    return null;
  }

  const containerStatus = await getContainerStatus(session.containerId);
  let newStatus: SessionStatus | null = null;

  if (containerStatus === 'not_found') {
    if (session.status === 'running') {
      newStatus = 'stopped';
    }
  } else if (containerStatus === 'running' && session.status === 'stopped') {
    newStatus = 'running';
  } else if (containerStatus === 'stopped' && session.status === 'running') {
    newStatus = 'stopped';
  }

  if (newStatus !== null) {
    log.info('Syncing session status with container', {
      sessionId,
      previousStatus: session.status,
      newStatus,
      containerStatus,
    });

    await prisma.session.update({
      where: { id: sessionId },
      data: { status: newStatus },
    });
  }

  return newStatus;
}

/**
 * Start background polling for container state changes.
 * Runs reconciliation every RECONCILIATION_INTERVAL_MS.
 */
export function startBackgroundReconciliation(): void {
  if (reconciliationIntervalId) {
    log.warn('Background reconciliation already running');
    return;
  }

  log.info('Starting background reconciliation', {
    intervalMs: RECONCILIATION_INTERVAL_MS,
  });

  reconciliationIntervalId = setInterval(async () => {
    try {
      await reconcileSessionsWithPodman();
    } catch (error) {
      log.error('Background reconciliation failed', toError(error));
    }
  }, RECONCILIATION_INTERVAL_MS);

  // Ensure interval is cleaned up on process exit
  process.on('beforeExit', () => {
    stopBackgroundReconciliation();
  });
}

/**
 * Stop background polling for container state changes.
 */
export function stopBackgroundReconciliation(): void {
  if (reconciliationIntervalId) {
    clearInterval(reconciliationIntervalId);
    reconciliationIntervalId = null;
    log.info('Stopped background reconciliation');
  }
}
