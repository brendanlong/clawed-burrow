'use client';

import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { SessionListItem } from '@/components/SessionListItem';

export function SessionList() {
  const { data, isLoading, refetch } = trpc.sessions.list.useQuery();

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const sessions = data?.sessions || [];

  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>No sessions yet</CardTitle>
          <CardDescription>Get started by creating a new session.</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/new">New Session</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {sessions.map((session) => (
            <SessionListItem key={session.id} session={session} onMutationSuccess={refetch} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
