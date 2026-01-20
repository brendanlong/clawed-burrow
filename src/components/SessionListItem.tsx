'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';

interface Session {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  status: string;
  updatedAt: Date;
}

interface SessionListItemProps {
  session: Session;
  onMutationSuccess: () => void;
}

export function SessionListItem({ session, onMutationSuccess }: SessionListItemProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: onMutationSuccess,
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: onMutationSuccess,
  });

  const deleteMutation = trpc.sessions.delete.useMutation({
    onSuccess: () => {
      setDeleteDialogOpen(false);
      onMutationSuccess();
    },
  });

  const repoName = session.repoUrl.replace('https://github.com/', '').replace('.git', '');

  return (
    <li className="p-4 hover:bg-muted/50 transition-colors">
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
            {session.status === 'stopped' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startMutation.mutate({ sessionId: session.id })}
                disabled={startMutation.isPending}
              >
                {startMutation.isPending ? 'Starting...' : 'Start'}
              </Button>
            )}
            {session.status === 'running' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => stopMutation.mutate({ sessionId: session.id })}
                disabled={stopMutation.isPending}
              >
                {stopMutation.isPending ? 'Stopping...' : 'Stop'}
              </Button>
            )}
            <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive">
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete the session &quot;{session.name}&quot; and its
                    workspace. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteMutation.mutate({ sessionId: session.id })}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Last updated: {new Date(session.updatedAt).toLocaleString()}
      </div>
    </li>
  );
}
