'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';

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
  isStarting: boolean;
  isStopping: boolean;
}

export function SessionHeader({
  session,
  onStart,
  onStop,
  isStarting,
  isStopping,
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
            <Button size="sm" onClick={onStart} disabled={isStarting}>
              {isStarting ? 'Starting...' : 'Start'}
            </Button>
          )}
          {session.status === 'running' && (
            <Button variant="secondary" size="sm" onClick={onStop} disabled={isStopping}>
              {isStopping ? 'Stopping...' : 'Stop'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
