'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
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

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline' | 'link';

interface SessionActionButtonProps {
  action: 'start' | 'stop' | 'archive';
  onClick: () => void;
  isPending: boolean;
  variant?: ButtonVariant;
  sessionName?: string;
}

const actionLabels = {
  start: { label: 'Start', pendingLabel: 'Starting...' },
  stop: { label: 'Stop', pendingLabel: 'Stopping...' },
  archive: { label: 'Archive', pendingLabel: 'Archiving...' },
} as const;

const archiveConfirmTitle = 'Archive session?';
const archiveConfirmDescription = (name: string) =>
  `This will archive the session "${name}" and remove its workspace. You can still view the message history in archived sessions.`;

/**
 * Reusable button component for session actions (start, stop, archive).
 * Archive action shows a confirmation dialog before proceeding.
 */
export function SessionActionButton({
  action,
  onClick,
  isPending,
  variant = 'default',
  sessionName,
}: SessionActionButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { label, pendingLabel } = actionLabels[action];

  // Archive requires confirmation dialog
  if (action === 'archive') {
    if (isPending) {
      return (
        <Button variant={variant} size="sm" disabled className="text-muted-foreground">
          <Spinner size="sm" className="mr-2" />
          {pendingLabel}
        </Button>
      );
    }

    return (
      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogTrigger asChild>
          <Button variant={variant} size="sm" className="text-muted-foreground">
            {label}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{archiveConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {archiveConfirmDescription(sessionName ?? 'this session')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onClick();
                setDialogOpen(false);
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  // Start/Stop are simple buttons
  return (
    <Button size="sm" variant={variant} onClick={onClick} disabled={isPending}>
      {isPending ? pendingLabel : label}
    </Button>
  );
}
