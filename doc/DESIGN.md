# Claude Code Web - Design Document

## Overview

A self-hosted web application that provides mobile-friendly access to Claude Code running on local machines with GPU support. The system exposes Claude Code sessions through a web interface, with persistent sessions tied to git clones in Docker containers.

## Goals

- Run Claude Code sessions from mobile devices without a terminal
- Access local GPU resources not available in Claude Code Web
- Persistent sessions that survive disconnections
- Clean session lifecycle tied to git clones
- Secure access without VPN

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│   Mobile/Web    │     │   Cloudflare    │     │      Home Server            │
│   Browser       │────►│   Tunnel        │────►│  ┌─────────────────────┐    │
│                 │     │                 │     │  │   Next.js + tRPC    │    │
└─────────────────┘     └─────────────────┘     │  │   - Auth            │    │
                                                │  │   - Session mgmt    │    │
                                                │  │   - WebSocket/SSE   │    │
                                                │  └──────────┬──────────┘    │
                                                │             │               │
                                                │  ┌──────────▼──────────┐    │
                                                │  │  Docker Containers  │    │
                                                │  │  ┌───────────────┐  │    │
                                                │  │  │ Claude Code   │  │    │
                                                │  │  │ + Git Clone   │  │    │
                                                │  │  │ + GPU access  │  │    │
                                                │  │  └───────────────┘  │    │
                                                │  └─────────────────────┘    │
                                                └─────────────────────────────┘
```

## Data Model

### Session

```typescript
interface Session {
  id: string; // UUID, also used as Claude Code session ID
  name: string; // User-provided name
  repoUrl: string; // GitHub clone URL
  branch: string; // Branch name
  workspacePath: string; // Path to cloned repo on host filesystem
  containerId: string | null; // Docker container ID when running
  status: 'creating' | 'running' | 'stopped' | 'error';
  statusMessage: string | null; // Progress message during creation or error details
  initialPrompt: string | null; // Optional prompt to auto-send when session starts (e.g., from GitHub issue)
  createdAt: Date;
  updatedAt: Date;
}
```

### Message

```typescript
interface Message {
  id: string; // UUID from Claude Code JSON
  sessionId: string;
  sequence: number; // Monotonic ordering for cursor pagination
  type: 'system' | 'assistant' | 'user' | 'result';
  content: ClaudeCodeJsonLine; // Raw JSON from Claude Code
  createdAt: Date;
}
```

### AuthSession

```typescript
interface AuthSession {
  id: string;
  token: string; // 256-bit random token
  expiresAt: Date;
  createdAt: Date;
  ipAddress: string | null; // For audit logging
  userAgent: string | null; // For audit logging
}
```

### Issue

```typescript
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  author: string;
  labels: Array<{ name: string; color: string }>;
  createdAt: string;
  updatedAt: string;
}
```

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
  → { session: Session, lastMessage?: Message }

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
5. Background: Server clones repo to `/data/workspaces/{sessionId}`
6. Background: Server starts container with:
   - Workspace mounted at `/workspace`
   - GPU access (`--gpus all`)
   - Claude auth mounted from host
   - Docker socket mounted (for docker-in-docker)
   - GITHUB_TOKEN env var for push/pull access
   - Git credential helper configured automatically
7. Session status → `running`, statusMessage → null

### Interaction Flow

1. User sends prompt via `claude.send()`
2. Server `docker exec`s into container:
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

## Docker Setup

### Base Image (Dockerfile.claude-code)

```dockerfile
FROM nvidia/cuda:12.1.0-base-ubuntu22.04

# Install dependencies including Python, pip, and JDK
RUN apt-get update && apt-get install -y \
    curl git docker.io ca-certificates gnupg \
    python3 python3-pip python3-venv \
    openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

# Install Node.js 20.x
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
      gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | \
      tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && apt-get install -y nodejs

# Install GitHub CLI (gh)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
      dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
      tee /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh

# Install pnpm and Claude Code
RUN npm install -g pnpm @anthropic-ai/claude-code

# Create non-root user with docker group access
RUN useradd -m -s /bin/bash -u 1000 claudeuser && \
    usermod -aG docker claudeuser

WORKDIR /workspace
RUN chown claudeuser:claudeuser /workspace

USER claudeuser
ENV HOME=/home/claudeuser
ENV PATH="/home/claudeuser/.local/bin:${PATH}"

# Configure git identity for commits
RUN git config --global user.email "claude@anthropic.com" && \
    git config --global user.name "Claude"

# Install uv package manager for Python
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

CMD ["tail", "-f", "/dev/null"]
```

### Container Launch

```typescript
async function startSessionContainer(session: Session, githubToken?: string): Promise<string> {
  const binds = [
    `${session.workspacePath}:/workspace`,
    `/var/run/docker.sock:/var/run/docker.sock`,
    `${CLAUDE_AUTH_PATH}:/home/claudeuser/.claude`,
  ];

  // Mount shared pnpm store if configured (safe for concurrent access)
  if (PNPM_STORE_PATH) {
    binds.push(`${PNPM_STORE_PATH}:/pnpm-store`);
  }

  const container = await docker.createContainer({
    Image: 'claude-code-runner:latest',
    name: `claude-session-${session.id}`,
    Env: githubToken ? [`GITHUB_TOKEN=${githubToken}`] : [],
    HostConfig: {
      Binds: binds,
      DeviceRequests: [
        {
          Driver: 'nvidia',
          Count: -1, // all GPUs
          Capabilities: [['gpu']],
        },
      ],
    },
    WorkingDir: '/workspace',
  });

  await container.start();

  // Configure git credential helper if token is provided
  if (githubToken) {
    await configureGitCredentials(container.id);
  }

  // Configure pnpm to use shared store if mounted
  if (PNPM_STORE_PATH) {
    await configurePnpmStore(container.id);
  }

  return container.id;
}
```

## Message Storage & Pagination

Messages are stored with a monotonically increasing sequence number per session. This enables efficient cursor-based pagination:

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_messages_session_sequence ON messages(session_id, sequence);
```

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

1. **Cloudflare Tunnel** — Traffic encrypted, no exposed ports
2. **Optional: Cloudflare Access** — Additional auth layer at edge
3. **Password Authentication** — Single-user auth with:
   - Password stored as base64-encoded Argon2 hash in `PASSWORD_HASH` env var
   - Database-backed sessions with 256-bit random tokens
   - 7-day session expiration
   - Session tracking (IP address, user agent) for audit

### Container Isolation

- Each session runs in its own container
- Containers can't access each other's workspaces
- Docker socket access is intentional for docker-in-docker capability
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

## Implementation Phases

### Phase 1: Core MVP

- Basic auth (username/password only)
- Session CRUD
- Docker container lifecycle
- Claude Code integration with streaming
- Basic chat UI
- Cloudflare Tunnel setup

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
