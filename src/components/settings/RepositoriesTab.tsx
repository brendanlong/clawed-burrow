'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { trpc } from '@/lib/trpc';
import { RepoSettingsEditor } from './RepoSettingsEditor';
import { Star, Settings, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function RepositoriesTab() {
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [deleteRepo, setDeleteRepo] = useState<string | null>(null);
  const { data, isLoading, refetch } = trpc.repoSettings.listWithSettings.useQuery();
  const deleteMutation = trpc.repoSettings.delete.useMutation({
    onSuccess: () => {
      refetch();
      setDeleteRepo(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const settings = data?.settings || [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Repository Settings</CardTitle>
          <CardDescription>
            Configure per-repository favorites, environment variables, and MCP servers. These
            settings are applied when creating new sessions for the repository.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No repository settings yet. Star a repository when creating a new session, or add
              settings by selecting a repository from the new session page.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {settings.map((setting) => (
                <li key={setting.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {setting.isFavorite && (
                      <Star className="h-4 w-4 text-yellow-500 fill-yellow-500 shrink-0" />
                    )}
                    <span className="font-mono text-sm truncate">{setting.repoFullName}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {setting.envVarCount > 0 && `${setting.envVarCount} env vars`}
                      {setting.envVarCount > 0 && setting.mcpServerCount > 0 && ', '}
                      {setting.mcpServerCount > 0 && `${setting.mcpServerCount} MCP servers`}
                      {setting.envVarCount === 0 && setting.mcpServerCount === 0 && 'No settings'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedRepo(setting.repoFullName)}
                      title="Edit settings"
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteRepo(setting.repoFullName)}
                      title="Delete all settings"
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selectedRepo && (
        <RepoSettingsEditor
          repoFullName={selectedRepo}
          onClose={() => {
            setSelectedRepo(null);
            refetch();
          }}
        />
      )}

      <AlertDialog open={!!deleteRepo} onOpenChange={(open) => !open && setDeleteRepo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete repository settings?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete all settings for <strong>{deleteRepo}</strong>, including environment
              variables and MCP server configurations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteRepo && deleteMutation.mutate({ repoFullName: deleteRepo })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? <Spinner size="sm" /> : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
