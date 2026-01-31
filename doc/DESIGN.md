# Clawed Abode - Design Document

## Overview

A self-hosted web application that provides mobile-friendly access to Claude Code running on local machines with GPU support. The system exposes Claude Code sessions through a web interface, with persistent sessions tied to git clones in Podman containers.

The system uses **rootless Podman** for container management, which provides:

- **Safe sudo access**: Claude Code agents have passwordless sudo inside containers without root on the host
- **Container-in-container support**: Podman-in-Podman allows agents to build and run containers
- **GPU access via CDI**: NVIDIA GPUs are exposed using Container Device Interface (CDI)
- **No Docker daemon**: Podman runs daemonless, reducing attack surface

## Goals

- Run Claude Code sessions from mobile devices without a terminal
- Access local GPU resources not available in Claude Code Web
- Persistent sessions that survive disconnections
- Clean session lifecycle tied to git clones
- Secure access without VPN

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│   Mobile/Web    │     │   Tailscale     │     │      Home Server            │
│   Browser       │────►│  Serve/Funnel   │────►│  ┌─────────────────────┐    │
│                 │     │                 │     │  │   Next.js + tRPC    │    │
└─────────────────┘     └─────────────────┘     │  │   - Auth            │    │
                                                │  │   - Session mgmt    │    │
                                                │  │   - WebSocket/SSE   │    │
                                                │  └──────────┬──────────┘    │
                                                │             │               │
                                                │  ┌──────────▼──────────┐    │
                                                │  │  Podman Containers  │    │
                                                │  │  ┌───────────────┐  │    │
                                                │  │  │ Claude Code   │  │    │
                                                │  │  │ + Git Clone   │  │    │
                                                │  │  │ + GPU (CDI)   │  │    │
                                                │  │  │ + sudo access │  │    │
                                                │  │  └───────────────┘  │    │
                                                │  └─────────────────────┘    │
                                                └─────────────────────────────┘
```

## Data Model

The database schema is defined in [`prisma/schema.prisma`](../prisma/schema.prisma). Key models:

- **Session**: Claude Code sessions tied to git clones
- **Message**: Chat messages with sequence numbers for cursor-based pagination
- **AuthSession**: Login sessions with tokens and audit info
- **ClaudeProcess**: Tracks running Claude processes for interrupt/resume
- **RepoSettings**: Per-repository settings (favorites, env vars, MCP servers)
- **EnvVar**: Environment variables for a repository (encrypted if secret)
- **McpServer**: MCP server configurations for a repository

### Session Archiving

When a session is deleted, it is archived rather than permanently removed. This preserves the message history for later viewing. Archived sessions:

- Have status set to `archived` and archivedAt timestamp recorded
- Have their container removed and workspace volume deleted
- Keep all messages in the database for viewing
- Are excluded from the session list by default (toggle available to show them)
- Are read-only: no start/stop controls, no prompt input

### Data Storage

The system uses **named Docker volumes** to avoid permission issues with rootless Podman:

1. **Database** (`clawed-abode-db`): SQLite database for the service container at `/data/db`.

2. **Session Workspaces** (`clawed-abode-workspace-{sessionId}`): Each session gets its own dedicated volume. This provides complete isolation between sessions and makes cleanup trivial (just delete the volume).

3. **pnpm Store** (`clawed-abode-pnpm-store`): Shared pnpm cache at `/pnpm-store` in runner containers. Speeds up package installs.

4. **Gradle Cache** (`clawed-abode-gradle-cache`): Shared Gradle cache at `/gradle-cache` in runner containers. Speeds up builds.

5. **Git Cache** (`clawed-abode-git-cache`): Shared bare repository cache at `/cache` in clone containers. Used as `--reference` during clones to avoid re-downloading git objects for repos that have been cloned before.

Using named volumes instead of bind mounts:

- Avoids the slow startup caused by `--userns=keep-id` (Podman re-chowning the image)
- Avoids permission issues since volumes are owned by the container user
- Simplifies the architecture by removing the need for host path translation
- Each volume can be managed independently (cleared, backed up, etc.)

### Workspace Structure

Each session has a dedicated volume that contains the cloned repository:

```
/workspace/                # Session's volume mounted here
├── {repo-name}/          # The cloned git repository (working directory)
├── .worktrees/           # Optional: git worktrees for parallel work
└── ...                   # Agent can create other files/directories as needed
```

Each runner container mounts only its own session's volume at `/workspace`, with the working directory set to `/workspace/{repo-name}`. This provides complete session isolation - each agent can only access its own workspace. This gives the agent:

- Full write access to the workspace for worktrees, temp files, etc.
- Clean separation between the repo and working files
- The repo as the default working directory for Claude

## API Design (tRPC)

### Authentication

Single-user authentication using password stored in `PASSWORD_HASH` environment variable (base64-encoded Argon2 hash).

```typescript
auth.login({ password })
  → { token }

auth.logout()
  → { success: true }

auth.logoutAll()
  → { success: true }
  // Deletes all sessions

auth.listSessions()
  → { sessions: AuthSession[] }
  // View all login sessions with IP/user agent

auth.deleteSession({ sessionId })
  → { success: true }
  // Revoke a specific session
```

### GitHub Integration

```typescript
github.listRepos({ search?: string, cursor?: string })
  → { repos: Repo[], nextCursor?: string }

github.listBranches({ repoFullName: string })
  → { branches: Branch[], defaultBranch: string }

github.listIssues({
  repoFullName: string,
  search?: string,
  state?: 'open' | 'closed' | 'all',  // default: 'open'
  cursor?: string,
  perPage?: number
})
  → { issues: Issue[], nextCursor?: string }
  // Lists issues for a repository with optional search and pagination

github.getIssue({ repoFullName: string, issueNumber: number })
  → { issue: Issue }
  // Get full details of a specific issue
```

### Session Management

```typescript
sessions.create({
  name: string,
  repoFullName: string,    // e.g., "brendanlong/math-llm"
  branch: string,
  initialPrompt?: string   // Optional prompt to auto-send when session starts
})
  → { session: Session }
  // Returns immediately with session in "creating" status
  // Cloning and container setup continues in background
  // UI polls session.get() to track progress via statusMessage
  // If initialPrompt is provided, it will be sent automatically when session becomes running

sessions.list({ status?: SessionStatus })
  → { sessions: Session[] }

sessions.get({ sessionId: string })
  → { session: Session }

sessions.start({ sessionId: string })
  → { session: Session }
  // Starts stopped container

sessions.stop({ sessionId: string })
  → { session: Session }
  // Stops container but preserves workspace

sessions.delete({ sessionId: string })
  → { success: true }
  // Stops container, deletes workspace
```

### Claude Interaction

```typescript
claude.send({ sessionId: string, prompt: string })
  → ReadableStream<Message>
  // Spawns: claude -p <prompt> --resume <sessionId> --output-format stream-json
  // Streams parsed JSON lines as they arrive

claude.interrupt({ sessionId: string })
  → { success: true }
  // Sends SIGINT to running claude process

claude.getHistory({
  sessionId: string,
  cursor?: number,        // sequence number
  direction: 'before' | 'after',
  limit?: number          // default 50
})
  → { messages: Message[], nextCursor?: number, hasMore: boolean }
```

## Session Lifecycle

### Creation Flow

1. User selects repo and branch from UI
2. Server calls `sessions.create()`
3. Server creates session record with status `creating` and returns immediately
4. UI navigates to session page, polls for status updates
5. Background: Server updates or creates the git reference cache for the repo (see Git Cache below)
6. Background: Server creates a dedicated volume for the session (`clawed-abode-workspace-{sessionId}`)
7. Background: Server spawns a temporary container with the session's volume and cache mounted
8. Background: Clone runs inside the container via `git clone --reference` to `/workspace/{repo-name}` (uses cache if available, falls back to normal clone)
9. Background: Temporary container is removed
10. Background: Server starts the session container with:

- Session's volume mounted at `/workspace`
- Working directory set to `/workspace/{repo-name}` (the cloned repo)
- GPU access via CDI (`--device nvidia.com/gpu=all`)
- Claude auth copied into container (not bind mounted)
- Podman socket mounted (for podman-in-podman)
- GITHUB_TOKEN env var for push/pull access
- Git credential helper configured automatically
- Passwordless sudo for package installation

11. Session status → `running`, statusMessage → null

### Interaction Flow

1. User sends prompt via `claude.send()`
2. Server executes command in container (via Podman's Docker-compatible API):
   ```bash
   claude -p "<prompt>" \
     --session-id <sessionId> \      # or --resume on subsequent
     --output-format stream-json \
     --dangerously-skip-permissions \
     --append-system-prompt "<system-prompt>"
   ```
3. Server reads stdout line by line, parses JSON
4. Each line saved to database with incrementing sequence number
5. Lines streamed to client via SSE/WebSocket
6. On completion, `result` message marks end of turn

### System Prompt

A system prompt is appended to all Claude sessions to ensure proper workflow. Since users interact through the web interface and have no local access to files, Claude must always commit, push, and open PRs for changes to be visible.

The system prompt instructs Claude to:

1. Always commit changes with clear, descriptive commit messages
2. Always push commits to the remote repository
3. Open a Pull Request (using `gh pr create`) for new branches or changes that benefit from review
4. If a PR already exists, just push to update it

This ensures users can see all changes through GitHub, which is their only way to access the codebase.

#### Container Issue Reporting

The system prompt also instructs Claude to report container issues (missing tools, misconfigured environments) to the clawed-abode repository. Before creating an issue, Claude should:

1. Search existing issues to avoid duplicates: `gh issue list --repo brendanlong/clawed-abode --search "<issue>" --state all`
2. If no matching issue exists, create one with labels `bug` and `reported-by-claude`
3. Continue with workarounds if possible, or inform the user if the task cannot be completed

### Interruption Flow

1. User clicks "Stop" in UI
2. Server calls `claude.interrupt()`
3. Server sends SIGINT to the `claude` process inside container
4. Claude Code cleans up, doesn't persist the interrupted tool call
5. User can send new prompt to continue

### Reconnection Flow

1. Client reconnects after disconnect
2. Client calls `claude.getHistory({ sessionId, cursor: lastSeenSequence, direction: 'after' })`
3. Server returns all messages after that sequence
4. Client merges into local state
5. If a `claude` process is still running, client re-subscribes to stream

### Deletion Flow

1. User deletes session
2. Server stops container if running
3. Server removes container
4. Server deletes workspace directory at `/data/workspaces/{sessionId}`
5. Server deletes messages from database
6. Server deletes session record

## Podman Setup

### Base Image

The runner container image is defined in [`docker/Dockerfile.claude-code`](../docker/Dockerfile.claude-code). Key features:

- NVIDIA CUDA base for GPU workloads
- Podman for container-in-container operations
- Common development tools (Node.js, Python, JDK, Android SDK)
- Passwordless sudo for package installation
- Docker/docker-compose aliases pointing to Podman equivalents
- Rootless Podman configured with fuse-overlayfs

### Container Launch

The application uses Podman CLI commands to manage containers, routing them through the Docker-compatible socket via `CONTAINER_HOST` env var.

Runner containers are created with (see [`createAndStartContainer`](../src/server/services/podman.ts) for implementation):

- **Network mode**: Configurable via `CONTAINER_NETWORK_MODE` (default: `host`). Host networking allows containers to connect to services started via podman-compose on localhost. See [issue #147](https://github.com/brendanlong/clawed-abode/issues/147) for details.
- **Workspace**: Session's dedicated volume mounted at `/workspace`
- **Claude auth**: OAuth token passed via `CLAUDE_CODE_OAUTH_TOKEN` environment variable
- **Podman socket**: Bind-mounted for container-in-container support (read-only)
- **pnpm store**: Named volume mounted at `/pnpm-store` for shared package cache
- **Gradle cache**: Named volume mounted at `/gradle-cache` for shared build cache

## Message Storage & Pagination

Messages are stored with a monotonically increasing sequence number per session (see `Message` model in [`prisma/schema.prisma`](../prisma/schema.prisma)). This enables efficient cursor-based pagination.

### Pagination Queries

**Load recent (initial view):**

```sql
SELECT * FROM messages
WHERE session_id = ?
ORDER BY sequence DESC
LIMIT 50;
```

**Load older (scroll up):**

```sql
SELECT * FROM messages
WHERE session_id = ? AND sequence < ?
ORDER BY sequence DESC
LIMIT 50;
```

**Poll for new (after reconnect):**

```sql
SELECT * FROM messages
WHERE session_id = ? AND sequence > ?
ORDER BY sequence ASC;
```

## Security

### Authentication Layers

1. **Tailscale Serve/Funnel** — Traffic encrypted over HTTPS, no exposed ports
2. **Password Authentication** — Single-user auth with:
   - Password stored as base64-encoded Argon2 hash in `PASSWORD_HASH` env var
   - Database-backed sessions with 256-bit random tokens
   - 7-day session expiration
   - Session tracking (IP address, user agent) for audit

### Container Isolation

- Each session runs in its own container
- Containers can't access each other's workspaces
- Podman socket access is intentional for podman-in-podman capability
- **Rootless Podman**: Claude Code agents have passwordless sudo inside containers, but:
  - The container user is not root on the host
  - User namespace isolation prevents host privilege escalation
  - This solves [issue #39](https://github.com/brendanlong/clawed-abode/issues/39) (no sudo for package installation)
- `--dangerously-skip-permissions` is acceptable because:
  - Only authenticated user can access
  - Container provides isolation boundary
  - Workspace is disposable

### GitHub Token Security

- Use a **fine-grained Personal Access Token** for minimum required permissions
- Scope the token to only the repositories you want to use
- Grant only "Contents: Read and write" permission (for push/pull)
- Create at: https://github.com/settings/personal-access-tokens/new
- The token is passed as an environment variable to containers
- A git credential helper is configured automatically inside containers

### Shared pnpm Store

- Set `PNPM_STORE_PATH` to the host's pnpm store path (e.g., `/home/user/.local/share/pnpm/store`)
- The store is mounted at `/pnpm-store` in containers and pnpm is configured to use it
- pnpm's store is safe for concurrent access (atomic operations)
- Only `pnpm store prune` should not run while installs are in progress

### Shared Gradle Cache

- Set `GRADLE_USER_HOME` to the host's Gradle user home (e.g., `/home/user/.gradle`)
- The cache is mounted at `/gradle-cache` in containers and `GRADLE_USER_HOME` env var is set
- Gradle's cache is safe for concurrent access (uses file locking)
- Includes downloaded dependencies, wrapper distributions, and build caches

### Git Reference Cache

The system maintains a cache of bare git repositories to speed up session creation:

- **Volume**: `clawed-abode-git-cache` (configurable via `GIT_CACHE_VOLUME` env var)
- **Cache path format**: `/cache/{owner}--{repo}.git` (e.g., `/cache/brendanlong--clawed-abode.git`)
- **How it works**:
  1. Before cloning, the system fetches the latest refs into the cached bare repo (or creates it if missing)
  2. Clone uses `git clone --reference <cache-path> --dissociate` to share objects with the cache
  3. The `--dissociate` flag ensures cloned repos are independent - they work even if the cache is deleted
- **Benefits**:
  - Subsequent sessions for the same repo only download new commits (typically a few MB instead of the full history)
  - First clone still works normally if caching fails
- **Git handles concurrent access**: Multiple fetches/clones can safely use the same cache
- **Cleanup**: Old cached repos can be pruned by deleting files from the volume; sessions already cloned are unaffected

### Podman Socket (Container-in-Container)

- Set `PODMAN_SOCKET_PATH` to the host's Podman socket path (e.g., `/run/user/1000/podman/podman.sock`)
- The socket is mounted at `/var/run/docker.sock` in runner containers
- `CONTAINER_HOST=unix:///var/run/docker.sock` is set in runner containers so `podman`/`docker` commands use the host's Podman
- This enables Claude Code agents to build and run containers inside their sessions
- Without this, agents would need to use nested Podman which has UID/GID mapping limitations

### Per-Repository Settings & Secrets

Users can configure per-repository settings that are automatically applied when creating sessions:

- **Favorites**: Mark repositories as favorites so they appear at the top of the repo selector
- **Environment Variables**: Custom env vars passed to the container (e.g., API keys, config values)
- **MCP Servers**: Configure [MCP servers](https://modelcontextprotocol.io/) for Claude to use

**Secret Encryption**: Environment variables and MCP server env vars can be marked as "secret", which:

- Encrypts the value at rest using AES-256-GCM with the `ENCRYPTION_KEY` env var
- Displays masked values (`••••••••`) in the UI
- Decrypts values only when creating/starting containers (values are passed to containers in plaintext)

**Configuration**:

1. Set `ENCRYPTION_KEY` to a 32+ character random string (generate with: `openssl rand -base64 32`)
2. Go to Settings → Repositories to manage per-repo settings
3. Or use the star icon in the new session repo selector to toggle favorites

**Implementation**: See [`src/server/routers/repoSettings.ts`](../src/server/routers/repoSettings.ts) for the API and [`src/lib/crypto.ts`](../src/lib/crypto.ts) for encryption.

## UI Screens

### Session List (Home)

- List of sessions with name, repo, status, last activity
- "New Session" button
- Quick actions: resume, stop, delete

### New Session

- Search/select GitHub repo
- Select branch (defaults to default branch)
- Optional: Select a GitHub issue to work on
  - Searchable dropdown with open issues
  - When selected, auto-fills session name with issue title
  - Generates initial prompt asking Claude to fix the issue
- Name the session (auto-filled from issue if selected)
- Create button

### Session View (Chat)

- Message history with lazy loading on scroll up
- Input field for new prompts
- Stop button (visible during Claude execution)
- Tool calls rendered with expandable input/output
- Status indicator (running, waiting, stopped)
- Session info in header (repo, branch)

## File Structure

```
claude-code-web/
├── src/
│   ├── server/
│   │   ├── routers/
│   │   │   ├── auth.ts
│   │   │   ├── github.ts
│   │   │   ├── sessions.ts
│   │   │   └── claude.ts
│   │   ├── services/
│   │   │   ├── docker.ts
│   │   │   ├── git.ts
│   │   │   ├── claude-runner.ts
│   │   │   └── message-store.ts
│   │   └── trpc.ts
│   ├── app/
│   │   ├── page.tsx              # Session list
│   │   ├── new/page.tsx          # New session
│   │   ├── session/[id]/page.tsx # Session view
│   │   └── login/page.tsx
│   └── components/
│       ├── MessageList.tsx
│       ├── MessageBubble.tsx
│       ├── ToolCallDisplay.tsx
│       └── PromptInput.tsx
├── docker/
│   ├── Dockerfile.claude-code
│   └── docker-compose.yml
├── prisma/
│   └── schema.prisma
└── package.json
```

## Testing

### Test Categories

- **Unit tests** (`*.test.ts`): Pure functions and isolated logic. Run with `pnpm test:unit`.
- **Integration tests** (`*.integration.test.ts`): Tests using real external systems (git, SQLite). Run with `pnpm test:integration`.

### Test File Locations

Tests are co-located with source files:

- `src/lib/auth.ts` → `src/lib/auth.test.ts`
- `src/server/services/git.ts` → `src/server/services/git.integration.test.ts`

### Running Tests

```bash
pnpm test          # Watch mode
pnpm test:run      # Single run
pnpm test:unit     # Unit tests only
pnpm test:integration  # Integration tests only
pnpm test:coverage # With coverage report
```

## Implementation Phases

### Phase 1: Core MVP

- Basic auth (username/password only)
- Session CRUD
- Docker container lifecycle
- Claude Code integration with streaming
- Basic chat UI
- Tailscale Serve/Funnel setup

### Phase 2: Polish

- Two-factor authentication
- Better mobile UI/UX
- Message search within session
- Session templates (pre-configured repos)
- Cost tracking display (from Claude Code JSON)

### Phase 3: Nice-to-haves

- Multiple machine support (coordinator pattern)
- Shared sessions / collaboration
- Scheduled tasks ("run tests every morning")
- Integration with GitHub PRs

## Open Questions

1. **Container reuse** — Keep one container per session always running, or start/stop on demand? Leaning toward always-running for simplicity (low resource cost when idle).

2. **Claude auth refresh** — Monitor for auth failures and surface in UI, or try to automate re-auth? Starting with manual re-auth on host seems fine.

3. **Message retention** — Keep forever, or prune old sessions? Probably configurable per-session or global setting.

4. **Workspace cleanup** — Consider periodic cleanup of old workspaces for deleted sessions that weren't cleaned up properly.
