'use client';

import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { trpc } from '@/lib/trpc';
import { Plus, Trash2, Eye, EyeOff, Star } from 'lucide-react';
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

interface RepoSettingsEditorProps {
  repoFullName: string;
  onClose: () => void;
}

export function RepoSettingsEditor({ repoFullName, onClose }: RepoSettingsEditorProps) {
  const { data, isLoading, refetch } = trpc.repoSettings.get.useQuery({ repoFullName });
  const toggleFavorite = trpc.repoSettings.toggleFavorite.useMutation({
    onSuccess: () => refetch(),
  });

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{repoFullName}</SheetTitle>
          <SheetDescription>Configure environment variables and MCP servers</SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {/* Favorite toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Star
                  className={`h-4 w-4 ${data?.isFavorite ? 'text-yellow-500 fill-yellow-500' : 'text-muted-foreground'}`}
                />
                <Label>Favorite</Label>
              </div>
              <Switch
                checked={data?.isFavorite ?? false}
                onCheckedChange={(checked) =>
                  toggleFavorite.mutate({ repoFullName, isFavorite: checked })
                }
              />
            </div>

            <Separator />

            {/* Environment Variables */}
            <EnvVarsSection
              repoFullName={repoFullName}
              envVars={data?.envVars ?? []}
              onUpdate={refetch}
            />

            <Separator />

            {/* MCP Servers */}
            <McpServersSection
              repoFullName={repoFullName}
              mcpServers={data?.mcpServers ?? []}
              onUpdate={refetch}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

interface EnvVar {
  id: string;
  name: string;
  value: string;
  isSecret: boolean;
}

function EnvVarsSection({
  repoFullName,
  envVars,
  onUpdate,
}: {
  repoFullName: string;
  envVars: EnvVar[];
  onUpdate: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteEnvVar, setDeleteEnvVar] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());

  const deleteMutation = trpc.repoSettings.deleteEnvVar.useMutation({
    onSuccess: () => {
      onUpdate();
      setDeleteEnvVar(null);
    },
  });

  const toggleSecretVisibility = (name: string) => {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Environment Variables</h3>
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {envVars.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">No environment variables configured.</p>
      ) : (
        <ul className="space-y-2">
          {envVars.map((envVar) => (
            <li key={envVar.id} className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm">{envVar.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  {envVar.isSecret ? (
                    <>
                      <span>{visibleSecrets.has(envVar.name) ? envVar.value : '••••••••'}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={() => toggleSecretVisibility(envVar.name)}
                      >
                        {visibleSecrets.has(envVar.name) ? (
                          <EyeOff className="h-3 w-3" />
                        ) : (
                          <Eye className="h-3 w-3" />
                        )}
                      </Button>
                    </>
                  ) : (
                    <span className="truncate">{envVar.value}</span>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditingId(envVar.id)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteEnvVar(envVar.name)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(showForm || editingId) && (
        <EnvVarForm
          repoFullName={repoFullName}
          existingEnvVar={editingId ? envVars.find((e) => e.id === editingId) : undefined}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
          onSuccess={() => {
            setShowForm(false);
            setEditingId(null);
            onUpdate();
          }}
        />
      )}

      <AlertDialog open={!!deleteEnvVar} onOpenChange={(open) => !open && setDeleteEnvVar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete environment variable?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the environment variable <strong>{deleteEnvVar}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteEnvVar && deleteMutation.mutate({ repoFullName, name: deleteEnvVar })
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EnvVarForm({
  repoFullName,
  existingEnvVar,
  onClose,
  onSuccess,
}: {
  repoFullName: string;
  existingEnvVar?: EnvVar;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(existingEnvVar?.name ?? '');
  const [value, setValue] = useState(existingEnvVar?.isSecret ? '' : (existingEnvVar?.value ?? ''));
  const [isSecret, setIsSecret] = useState(existingEnvVar?.isSecret ?? false);
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.repoSettings.setEnvVar.useMutation({
    onSuccess,
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      setError(
        'Name must start with a letter or underscore and contain only alphanumeric characters and underscores'
      );
      return;
    }

    // For secrets being edited, only require value if it's a new secret or value was changed
    if (!existingEnvVar?.isSecret && !value) {
      setError('Value is required');
      return;
    }

    mutation.mutate({
      repoFullName,
      envVar: {
        name,
        value: existingEnvVar?.isSecret && !value ? existingEnvVar.value : value,
        isSecret,
      },
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor="env-name">Name</Label>
        <Input
          id="env-name"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="MY_API_KEY"
          disabled={!!existingEnvVar}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="env-value">Value</Label>
        <Input
          id="env-value"
          type={isSecret ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={existingEnvVar?.isSecret ? '(unchanged)' : 'Enter value'}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch id="env-secret" checked={isSecret} onCheckedChange={setIsSecret} />
        <Label htmlFor="env-secret">Secret (encrypted at rest)</Label>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner size="sm" /> : existingEnvVar ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, { value: string; isSecret: boolean }>;
}

function McpServersSection({
  repoFullName,
  mcpServers,
  onUpdate,
}: {
  repoFullName: string;
  mcpServers: McpServer[];
  onUpdate: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteMcpServer, setDeleteMcpServer] = useState<string | null>(null);

  const deleteMutation = trpc.repoSettings.deleteMcpServer.useMutation({
    onSuccess: () => {
      onUpdate();
      setDeleteMcpServer(null);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">MCP Servers</h3>
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {mcpServers.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
      ) : (
        <ul className="space-y-2">
          {mcpServers.map((server) => (
            <li key={server.id} className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm">{server.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {server.command} {server.args.join(' ')}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditingId(server.id)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteMcpServer(server.name)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(showForm || editingId) && (
        <McpServerForm
          repoFullName={repoFullName}
          existingServer={editingId ? mcpServers.find((s) => s.id === editingId) : undefined}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
          onSuccess={() => {
            setShowForm(false);
            setEditingId(null);
            onUpdate();
          }}
        />
      )}

      <AlertDialog
        open={!!deleteMcpServer}
        onOpenChange={(open) => !open && setDeleteMcpServer(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the MCP server <strong>{deleteMcpServer}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteMcpServer && deleteMutation.mutate({ repoFullName, name: deleteMcpServer })
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function McpServerForm({
  repoFullName,
  existingServer,
  onClose,
  onSuccess,
}: {
  repoFullName: string;
  existingServer?: McpServer;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(existingServer?.name ?? '');
  const [command, setCommand] = useState(existingServer?.command ?? '');
  const [args, setArgs] = useState(existingServer?.args.join(' ') ?? '');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string; isSecret: boolean }>>(
    existingServer?.env
      ? Object.entries(existingServer.env).map(([key, { value, isSecret }]) => ({
          key,
          value: isSecret ? '' : value,
          isSecret,
        }))
      : []
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.repoSettings.setMcpServer.useMutation({
    onSuccess,
    onError: (err) => setError(err.message),
  });

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '', isSecret: false }]);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const updateEnvVar = (
    index: number,
    field: 'key' | 'value' | 'isSecret',
    value: string | boolean
  ) => {
    setEnvVars(envVars.map((env, i) => (i === index ? { ...env, [field]: value } : env)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name) {
      setError('Name is required');
      return;
    }

    if (!command) {
      setError('Command is required');
      return;
    }

    const env = envVars.reduce(
      (acc, { key, value, isSecret }) => {
        if (key) {
          // For existing secrets with empty value, keep the old value
          const existingEnv = existingServer?.env[key];
          const finalValue = existingEnv?.isSecret && !value ? existingEnv.value : value;
          acc[key] = { value: finalValue, isSecret };
        }
        return acc;
      },
      {} as Record<string, { value: string; isSecret: boolean }>
    );

    mutation.mutate({
      repoFullName,
      mcpServer: {
        name,
        command,
        args: args.split(/\s+/).filter(Boolean),
        env: Object.keys(env).length > 0 ? env : undefined,
      },
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="memory"
          disabled={!!existingServer}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-command">Command</Label>
        <Input
          id="mcp-command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npx"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="mcp-args">Arguments (space-separated)</Label>
        <Input
          id="mcp-args"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder="@anthropic/mcp-server-memory"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Environment Variables</Label>
          <Button type="button" variant="outline" size="sm" onClick={addEnvVar}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {envVars.map((env, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={env.key}
              onChange={(e) => updateEnvVar(index, 'key', e.target.value.toUpperCase())}
              placeholder="KEY"
              className="flex-1"
            />
            <Input
              type={env.isSecret ? 'password' : 'text'}
              value={env.value}
              onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
              placeholder={existingServer?.env[env.key]?.isSecret ? '(unchanged)' : 'value'}
              className="flex-1"
            />
            <Switch
              checked={env.isSecret}
              onCheckedChange={(checked) => updateEnvVar(index, 'isSecret', checked)}
              title="Secret"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeEnvVar(index)}
              className="text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner size="sm" /> : existingServer ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
