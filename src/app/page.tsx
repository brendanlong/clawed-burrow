'use client';

import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { trpc } from '@/lib/trpc';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-green-100 text-green-800',
    stopped: 'bg-gray-100 text-gray-800',
    creating: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        colors[status] || colors.stopped
      }`}
    >
      {status}
    </span>
  );
}

function SessionList() {
  const { data, isLoading, refetch } = trpc.sessions.list.useQuery();
  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: () => refetch(),
  });
  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: () => refetch(),
  });
  const deleteMutation = trpc.sessions.delete.useMutation({
    onSuccess: () => refetch(),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const sessions = data?.sessions || [];

  if (sessions.length === 0) {
    return (
      <div className="text-center py-12">
        <h3 className="text-lg font-medium text-gray-900">No sessions yet</h3>
        <p className="mt-1 text-sm text-gray-500">Get started by creating a new session.</p>
        <div className="mt-6">
          <Link
            href="/new"
            className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            New Session
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white shadow overflow-hidden sm:rounded-md">
      <ul className="divide-y divide-gray-200">
        {sessions.map((session) => (
          <li key={session.id}>
            <div className="px-4 py-4 sm:px-6 hover:bg-gray-50">
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <Link href={`/session/${session.id}`} className="block focus:outline-none">
                    <p className="text-sm font-medium text-blue-600 truncate hover:underline">
                      {session.name}
                    </p>
                    <p className="mt-1 text-sm text-gray-500 truncate">
                      {session.repoUrl.replace('https://github.com/', '').replace('.git', '')}
                      <span className="mx-1">•</span>
                      {session.branch}
                    </p>
                  </Link>
                </div>

                <div className="flex items-center space-x-4">
                  <StatusBadge status={session.status} />

                  <div className="flex items-center space-x-2">
                    {session.status === 'stopped' && (
                      <button
                        onClick={() => startMutation.mutate({ sessionId: session.id })}
                        disabled={startMutation.isPending}
                        className="text-sm text-green-600 hover:text-green-800 disabled:opacity-50"
                      >
                        Start
                      </button>
                    )}
                    {session.status === 'running' && (
                      <button
                        onClick={() => stopMutation.mutate({ sessionId: session.id })}
                        disabled={stopMutation.isPending}
                        className="text-sm text-yellow-600 hover:text-yellow-800 disabled:opacity-50"
                      >
                        Stop
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm('Are you sure you want to delete this session?')) {
                          deleteMutation.mutate({ sessionId: session.id });
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-2 text-xs text-gray-400">
                Last updated: {new Date(session.updatedAt).toLocaleString()}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function HomePage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-gray-50">
        <Header />

        <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <div className="flex justify-between items-center mb-6">
              <h1 className="text-2xl font-bold text-gray-900">Sessions</h1>
              <Link
                href="/new"
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                New Session
              </Link>
            </div>

            <SessionList />
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
