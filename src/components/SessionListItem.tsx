'use client';

import Link from 'next/link';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';
import { SessionActionButton } from '@/components/SessionActionButton';
import type { Session } from '@/hooks/useSessionList';
import type { SessionActions } from '@/hooks/useSessionActions';

export interface SessionListItemProps {
  session: Session;
  actions: SessionActions;
}

/**
 * Pure presentation component for a single session list item.
 * Receives session data and actions as props, making it easily testable.
 */
export function SessionListItem({ session, actions }: SessionListItemProps) {
  const repoName = session.repoUrl.replace('https://github.com/', '').replace('.git', '');

  const isArchiving = actions.isArchiving(session.id);
  const isStarting = actions.isStarting(session.id);
  const isStopping = actions.isStopping(session.id);
  const isArchived = session.status === 'archived';

  return (
    <li
      className={`p-4 hover:bg-muted/50 transition-all ${isArchiving ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <Link href={`/session/${session.id}`} className="block">
            <p className="text-sm font-medium text-primary truncate hover:underline">
              {session.name}
            </p>
            <p className="mt-1 text-sm text-muted-foreground truncate">
              {repoName}
              <span className="mx-1">·</span>
              {session.branch}
            </p>
          </Link>
        </div>

        <div className="flex items-center gap-4">
          <SessionStatusBadge status={session.status} />

          <div className="flex items-center gap-2">
            {/* No controls for archived sessions - they're read-only */}
            {!isArchived && (
              <>
                {session.status === 'stopped' && (
                  <SessionActionButton
                    action="start"
                    onClick={() => actions.start(session.id)}
                    isPending={isStarting}
                    variant="ghost"
                  />
                )}
                {session.status === 'running' && (
                  <SessionActionButton
                    action="stop"
                    onClick={() => actions.stop(session.id)}
                    isPending={isStopping}
                    variant="ghost"
                  />
                )}
                <SessionActionButton
                  action="archive"
                  onClick={() => actions.archive(session.id)}
                  isPending={isArchiving}
                  variant="ghost"
                  sessionName={session.name}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Last updated: {new Date(session.updatedAt).toLocaleString()}
      </div>
    </li>
  );
}
