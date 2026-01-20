'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Issue } from '@/lib/types';

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
      <div className="space-y-2">
        <Label>Search repositories</Label>
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your repositories..."
        />
      </div>

      <div className="border rounded-lg max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No repositories found</div>
        ) : (
          <ul className="divide-y divide-border">
            {repos.map((repo) => (
              <li
                key={repo.id}
                onClick={() => onSelect(repo)}
                className={cn(
                  'px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors',
                  selectedRepo?.id === repo.id && 'bg-primary/10'
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{repo.fullName}</p>
                    {repo.description && (
                      <p className="text-xs text-muted-foreground truncate max-w-md">
                        {repo.description}
                      </p>
                    )}
                  </div>
                  {repo.private && <span className="text-xs text-muted-foreground">Private</span>}
                </div>
              </li>
            ))}
            {hasNextPage && (
              <li className="px-4 py-3 text-center">
                <Button
                  variant="link"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load more'}
                </Button>
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

  const handleSelect = useCallback(
    (branch: string) => {
      onSelect(branch);
    },
    [onSelect]
  );

  useEffect(() => {
    if (data?.defaultBranch && !selectedBranch) {
      handleSelect(data.defaultBranch);
    }
  }, [data, selectedBranch, handleSelect]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Spinner size="sm" />
        <span>Loading branches...</span>
      </div>
    );
  }

  const branches = data?.branches || [];

  return (
    <div className="space-y-2">
      <Label>Branch</Label>
      <Select value={selectedBranch} onValueChange={onSelect}>
        <SelectTrigger>
          <SelectValue placeholder="Select a branch" />
        </SelectTrigger>
        <SelectContent>
          {branches.map((branch) => (
            <SelectItem key={branch.name} value={branch.name}>
              {branch.name}
              {branch.name === data?.defaultBranch ? ' (default)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function IssueSelector({
  repoFullName,
  selectedIssue,
  onSelect,
}: {
  repoFullName: string;
  selectedIssue: Issue | null;
  onSelect: (issue: Issue | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.github.listIssues.useInfiniteQuery(
      { repoFullName, search: debouncedSearch || undefined, perPage: 15 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        enabled: !!repoFullName,
      }
    );

  const issues = data?.pages.flatMap((p) => p.issues) || [];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Link to GitHub issue (optional)</Label>
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search issues..."
        />
      </div>

      <div className="border rounded-lg max-h-48 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : issues.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            {search ? 'No issues found' : 'No open issues'}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {selectedIssue && (
              <li
                onClick={() => onSelect(null)}
                className="px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors bg-muted/30"
              >
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Clear selection</span>
                </div>
              </li>
            )}
            {issues.map((issue) => (
              <li
                key={issue.id}
                onClick={() => onSelect(issue)}
                className={cn(
                  'px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors',
                  selectedIssue?.id === issue.id && 'bg-primary/10'
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">#{issue.number}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{issue.title}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {issue.labels.slice(0, 3).map((label) => (
                        <Badge
                          key={label.name}
                          variant="outline"
                          className="text-xs py-0"
                          style={{
                            borderColor: `#${label.color}`,
                            color: `#${label.color}`,
                          }}
                        >
                          {label.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </li>
            ))}
            {hasNextPage && (
              <li className="px-4 py-2 text-center">
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load more'}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function generateIssuePrompt(issue: Issue, repoFullName: string): string {
  const issueUrl = `https://github.com/${repoFullName}/issues/${issue.number}`;
  const labels = issue.labels.map((l) => l.name).join(', ');

  let prompt = `Please fix the following GitHub issue and commit and push your changes:\n\n`;
  prompt += `## Issue #${issue.number}: ${issue.title}\n`;
  prompt += `URL: ${issueUrl}\n`;
  if (labels) {
    prompt += `Labels: ${labels}\n`;
  }
  prompt += `\n### Description\n\n`;
  prompt += issue.body || '(No description provided)';
  prompt += `\n\n---\n\n`;
  prompt += `Please:\n`;
  prompt += `1. Analyze the issue and understand what needs to be fixed\n`;
  prompt += `2. Make the necessary code changes\n`;
  prompt += `3. Commit your changes with a descriptive message\n`;
  prompt += `4. Push the changes to the remote repository`;

  return prompt;
}

function NewSessionForm() {
  const router = useRouter();
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
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

  // When an issue is selected, use its title as the session name
  const handleIssueSelect = useCallback((issue: Issue | null) => {
    setSelectedIssue(issue);
    if (issue) {
      setSessionName(`#${issue.number}: ${issue.title}`);
    } else {
      setSessionName('');
    }
  }, []);

  // Handle repo selection: also reset issue and name
  const handleRepoSelect = useCallback((repo: Repo) => {
    setSelectedRepo(repo);
    setSelectedIssue(null);
    setSessionName('');
  }, []);

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

    const initialPrompt = selectedIssue
      ? generateIssuePrompt(selectedIssue, selectedRepo.fullName)
      : undefined;

    createMutation.mutate({
      name: sessionName || `${selectedRepo.name} - ${selectedBranch}`,
      repoFullName: selectedRepo.fullName,
      branch: selectedBranch,
      initialPrompt,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <RepoSelector selectedRepo={selectedRepo} onSelect={handleRepoSelect} />

      {selectedRepo && (
        <>
          <BranchSelector
            repoFullName={selectedRepo.fullName}
            selectedBranch={selectedBranch}
            onSelect={setSelectedBranch}
          />

          <IssueSelector
            repoFullName={selectedRepo.fullName}
            selectedIssue={selectedIssue}
            onSelect={handleIssueSelect}
          />

          <div className="space-y-2">
            <Label htmlFor="sessionName">Session name {selectedIssue ? '' : '(optional)'}</Label>
            <Input
              id="sessionName"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder={`${selectedRepo.name} - ${selectedBranch || 'branch'}`}
            />
            {selectedIssue && (
              <p className="text-xs text-muted-foreground">
                When the session starts, Claude will automatically be prompted to fix this issue.
              </p>
            )}
          </div>
        </>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="outline" asChild>
          <Link href="/">Cancel</Link>
        </Button>
        <Button
          type="submit"
          disabled={!selectedRepo || !selectedBranch || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" className="text-primary-foreground" />
              Creating...
            </span>
          ) : (
            'Create Session'
          )}
        </Button>
      </div>
    </form>
  );
}

export default function NewSessionPage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background">
        <Header />

        <main className="max-w-2xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <h1 className="text-2xl font-bold mb-6">New Session</h1>

            <Card>
              <CardHeader>
                <CardTitle>Create a new session</CardTitle>
              </CardHeader>
              <CardContent>
                <NewSessionForm />
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
