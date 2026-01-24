'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';
import { SessionActionButton } from '@/components/SessionActionButton';

interface SessionHeaderProps {
  session: {
    id: string;
    name: string;
    repoUrl: string;
    branch: string;
    status: string;
    statusMessage?: string | null;
    initialPrompt?: string | null;
  };
  onStart: () => void;
  onStop: () => void;
  onArchive?: () => void;
  isStarting: boolean;
  isStopping: boolean;
  isArchiving?: boolean;
}

export function SessionHeader({
  session,
  onStart,
  onStop,
  onArchive,
  isStarting,
  isStopping,
  isArchiving = false,
}: SessionHeaderProps) {
  const repoName = session.repoUrl.replace('https://github.com/', '').replace('.git', '');

  return (
    <div className="border-b bg-background px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Link>
          </Button>
          <div>
            <h1 className="font-semibold">{session.name}</h1>
            <p className="text-sm text-muted-foreground">
              {repoName} · {session.branch}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Container:</span>
          <SessionStatusBadge status={session.status} />

          {session.status === 'stopped' && (
            <SessionActionButton action="start" onClick={onStart} isPending={isStarting} />
          )}
          {session.status === 'running' && (
            <SessionActionButton
              action="stop"
              onClick={onStop}
              isPending={isStopping}
              variant="secondary"
            />
          )}
          {(session.status === 'stopped' || session.status === 'running') && onArchive && (
            <SessionActionButton
              action="archive"
              onClick={onArchive}
              isPending={isArchiving}
              variant="secondary"
              sessionName={session.name}
            />
          )}
        </div>
      </div>
    </div>
  );
}
