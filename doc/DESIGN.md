# Claude Code Web - Design Document

## Overview

A self-hosted web application that provides mobile-friendly access to Claude Code running on local machines with GPU support. The system exposes Claude Code sessions through a web interface, with persistent sessions tied to git worktrees in Docker containers.

## Goals

- Run Claude Code sessions from mobile devices without a terminal
- Access local GPU resources not available in Claude Code Web
- Persistent sessions that survive disconnections
- Clean session lifecycle tied to git worktrees
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
                                                │  │  │ + Worktree    │  │    │
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
  worktreePath: string; // Path on host filesystem
  containerId: string | null; // Docker container ID when running
  status: 'creating' | 'running' | 'stopped' | 'error';
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

## API Design (tRPC)

### Authentication

Single-user authentication using password stored in `PASSWORD_HASH` environment variable (Argon2-hashed).

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
```

### Session Management

```typescript
sessions.create({
  name: string,
  repoFullName: string,    // e.g., "brendanlong/math-llm"
  branch: string
})
  → { session: Session }
  // Internally: clones repo, creates worktree, builds/starts container

sessions.list({ status?: SessionStatus })
  → { sessions: Session[] }

sessions.get({ sessionId: string })
  → { session: Session, lastMessage?: Message }

sessions.start({ sessionId: string })
  → { session: Session }
  // Starts stopped container

sessions.stop({ sessionId: string })
  → { session: Session }
  // Stops container but preserves worktree

sessions.delete({ sessionId: string })
  → { success: true }
  // Stops container, deletes worktree
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
3. Server clones repo (or fetches if exists) to `/data/repos/{repoName}`
4. Server creates worktree at `/data/worktrees/{sessionId}` for the branch
5. Server builds/pulls Docker image with Claude Code
6. Server starts container with:
   - Worktree mounted at `/workspace`
   - GPU access (`--gpus all`)
   - Claude auth copied/mounted from host
   - Docker socket mounted (for docker-in-docker)
7. Session status → `running`

### Interaction Flow

1. User sends prompt via `claude.send()`
2. Server `docker exec`s into container:
   ```bash
   claude -p "<prompt>" \
     --session-id <sessionId> \      # or --resume on subsequent
     --output-format stream-json \
     --dangerously-skip-permissions
   ```
3. Server reads stdout line by line, parses JSON
4. Each line saved to database with incrementing sequence number
5. Lines streamed to client via SSE/WebSocket
6. On completion, `result` message marks end of turn

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
4. Server deletes worktree: `git worktree remove /data/worktrees/{sessionId}`
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

# Install Node.js 20.x and Claude Code
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
      gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | \
      tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && apt-get install -y nodejs && \
    npm install -g @anthropic-ai/claude-code

# Create non-root user with docker group access
RUN useradd -m -s /bin/bash -u 1000 claudeuser && \
    usermod -aG docker claudeuser

WORKDIR /workspace
RUN chown claudeuser:claudeuser /workspace

USER claudeuser
ENV HOME=/home/claudeuser
ENV PATH="/home/claudeuser/.local/bin:${PATH}"

# Install uv package manager for Python
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

CMD ["tail", "-f", "/dev/null"]
```

### Container Launch

```typescript
async function startSessionContainer(session: Session): Promise<string> {
  const containerId = await docker.createContainer({
    Image: 'claude-code-runner:latest',
    name: `claude-session-${session.id}`,
    HostConfig: {
      Binds: [
        `${session.worktreePath}:/workspace`,
        `/var/run/docker.sock:/var/run/docker.sock`,
        `${CLAUDE_AUTH_PATH}:/home/claudeuser/.claude:ro`,
      ],
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

  await docker.startContainer(containerId);
  return containerId;
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
   - Password stored as Argon2 hash in `PASSWORD_HASH` env var
   - Database-backed sessions with 256-bit random tokens
   - 7-day session expiration
   - Session tracking (IP address, user agent) for audit

### Container Isolation

- Each session runs in its own container
- Containers can't access each other's worktrees
- Docker socket access is intentional for docker-in-docker capability
- `--dangerously-skip-permissions` is acceptable because:
  - Only authenticated user can access
  - Container provides isolation boundary
  - Worktree is disposable

## UI Screens

### Session List (Home)

- List of sessions with name, repo, status, last activity
- "New Session" button
- Quick actions: resume, stop, delete

### New Session

- Search/select GitHub repo
- Select branch (defaults to default branch)
- Name the session
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

1. **Git worktree vs fresh clone** — Worktrees are faster but require a base clone. May want periodic garbage collection of old clones.

2. **Container reuse** — Keep one container per session always running, or start/stop on demand? Leaning toward always-running for simplicity (low resource cost when idle).

3. **Claude auth refresh** — Monitor for auth failures and surface in UI, or try to automate re-auth? Starting with manual re-auth on host seems fine.

4. **Message retention** — Keep forever, or prune old sessions? Probably configurable per-session or global setting.
