'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { Spinner } from '@/components/ui/spinner';
import type { AuthSession } from '@/hooks/useAuthSessions';

interface AuthSessionListItemProps {
  session: AuthSession;
  onRevoke: (sessionId: string) => Promise<void>;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(date));
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function parseUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  // Simple browser and OS detection
  let browser = 'Unknown browser';
  let os = 'Unknown OS';

  if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
    browser = 'Chrome';
  } else if (userAgent.includes('Firefox')) {
    browser = 'Firefox';
  } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
    browser = 'Safari';
  } else if (userAgent.includes('Edg')) {
    browser = 'Edge';
  }

  if (userAgent.includes('Windows')) {
    os = 'Windows';
  } else if (userAgent.includes('Mac OS')) {
    os = 'macOS';
  } else if (userAgent.includes('Linux')) {
    os = 'Linux';
  } else if (userAgent.includes('Android')) {
    os = 'Android';
  } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
    os = 'iOS';
  }

  return `${browser} on ${os}`;
}

export function AuthSessionListItem({ session, onRevoke }: AuthSessionListItemProps) {
  const [isRevoking, setIsRevoking] = useState(false);

  const now = new Date();
  const isRevoked = !!session.revokedAt;
  const isExpired = new Date(session.expiresAt) <= now;
  const isActive = !isRevoked && !isExpired;

  const handleRevoke = async () => {
    setIsRevoking(true);
    try {
      await onRevoke(session.id);
    } finally {
      setIsRevoking(false);
    }
  };

  return (
    <li className="px-4 py-4 hover:bg-muted/50 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{parseUserAgent(session.userAgent)}</span>
            {session.isCurrent && (
              <Badge variant="secondary" className="text-xs">
                Current session
              </Badge>
            )}
            {isRevoked && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Revoked
              </Badge>
            )}
            {isExpired && !isRevoked && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Expired
              </Badge>
            )}
          </div>

          <div className="text-xs text-muted-foreground space-y-0.5">
            {session.ipAddress && <p>IP: {session.ipAddress}</p>}
            <p>Last active: {formatRelativeTime(session.lastActivityAt)}</p>
            {isRevoked && session.revokedAt && <p>Revoked: {formatDate(session.revokedAt)}</p>}
            <p>
              {isExpired ? 'Expired' : 'Expires'}: {formatDate(session.expiresAt)}
            </p>
            <p>Created: {formatDate(session.createdAt)}</p>
          </div>
        </div>

        {!session.isCurrent && isActive && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={isRevoking}>
                {isRevoking ? <Spinner size="sm" /> : 'Revoke'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke this session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will immediately log out this session. The device will need to log in again
                  to access the application.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleRevoke}>Revoke session</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </li>
  );
}
