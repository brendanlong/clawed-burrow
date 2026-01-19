'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { trpc } from '@/lib/trpc';

interface Repo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

function RepoSelector({
  selectedRepo,
  onSelect,
}: {
  selectedRepo: Repo | null;
  onSelect: (repo: Repo) => void;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.github.listRepos.useInfiniteQuery(
      { search: debouncedSearch || undefined, perPage: 20 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  const repos = data?.pages.flatMap((p) => p.repos) || [];

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700">Search repositories</label>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your repositories..."
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div className="border border-gray-200 rounded-lg max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-8 text-gray-500">No repositories found</div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {repos.map((repo) => (
              <li
                key={repo.id}
                onClick={() => onSelect(repo)}
                className={`px-4 py-3 cursor-pointer hover:bg-gray-50 ${
                  selectedRepo?.id === repo.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{repo.fullName}</p>
                    {repo.description && (
                      <p className="text-xs text-gray-500 truncate max-w-md">{repo.description}</p>
                    )}
                  </div>
                  {repo.private && <span className="text-xs text-gray-400">Private</span>}
                </div>
              </li>
            ))}
            {hasNextPage && (
              <li className="px-4 py-3 text-center">
                <button
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load more'}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function BranchSelector({
  repoFullName,
  selectedBranch,
  onSelect,
}: {
  repoFullName: string;
  selectedBranch: string;
  onSelect: (branch: string) => void;
}) {
  const { data, isLoading } = trpc.github.listBranches.useQuery(
    { repoFullName },
    { enabled: !!repoFullName }
  );

  useEffect(() => {
    if (data?.defaultBranch && !selectedBranch) {
      onSelect(data.defaultBranch);
    }
  }, [data, selectedBranch, onSelect]);

  if (isLoading) {
    return (
      <div className="flex items-center space-x-2 text-gray-500">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
        <span>Loading branches...</span>
      </div>
    );
  }

  const branches = data?.branches || [];

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">Branch</label>
      <select
        value={selectedBranch}
        onChange={(e) => onSelect(e.target.value)}
        className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
      >
        {branches.map((branch) => (
          <option key={branch.name} value={branch.name}>
            {branch.name}
            {branch.name === data?.defaultBranch ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function NewSessionForm() {
  const router = useRouter();
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [error, setError] = useState('');

  const createMutation = trpc.sessions.create.useMutation({
    onSuccess: (data) => {
      router.push(`/session/${data.session.id}`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!selectedRepo) {
      setError('Please select a repository');
      return;
    }

    if (!selectedBranch) {
      setError('Please select a branch');
      return;
    }

    createMutation.mutate({
      name: sessionName || `${selectedRepo.name} - ${selectedBranch}`,
      repoFullName: selectedRepo.fullName,
      branch: selectedBranch,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <RepoSelector selectedRepo={selectedRepo} onSelect={setSelectedRepo} />

      {selectedRepo && (
        <>
          <BranchSelector
            repoFullName={selectedRepo.fullName}
            selectedBranch={selectedBranch}
            onSelect={setSelectedBranch}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Session name (optional)
            </label>
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder={`${selectedRepo.name} - ${selectedBranch || 'branch'}`}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </>
      )}

      <div className="flex justify-end space-x-3">
        <Link
          href="/"
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={!selectedRepo || !selectedBranch || createMutation.isPending}
          className="px-4 py-2 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {createMutation.isPending ? 'Creating...' : 'Create Session'}
        </button>
      </div>
    </form>
  );
}

export default function NewSessionPage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-gray-50">
        <Header />

        <main className="max-w-2xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <h1 className="text-2xl font-bold text-gray-900 mb-6">New Session</h1>

            <div className="bg-white shadow rounded-lg p-6">
              <NewSessionForm />
            </div>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
