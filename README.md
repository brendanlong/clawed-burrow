# Claude Code Local Web

A self-hosted web application that provides mobile-friendly access to Claude Code running on your local machine with GPU support.

## Features

- Run Claude Code sessions from any device with a web browser
- Access local GPU resources for AI workloads
- Persistent sessions tied to git worktrees
- Simple password-based authentication (single user)
- Session tracking with IP addresses and login history
- Clean session lifecycle management
- Mobile-friendly interface

## Prerequisites

- Node.js 20+
- Docker with NVIDIA Container Toolkit (for GPU support)
- A GitHub Personal Access Token (with `repo` scope)
- Claude Code installed and authenticated on your host machine

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/claude-code-local-web.git
cd claude-code-local-web
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set:

- `PASSWORD_HASH`: Argon2-hashed password for authentication (see below)
- `GITHUB_TOKEN`: Your GitHub Personal Access Token
- `CLAUDE_AUTH_PATH`: Path to your Claude Code auth (usually `~/.claude`)

### Generate Password Hash

Generate an Argon2 hash of your password:

```bash
node -e "require('argon2').hash('your-secure-password').then(console.log)"
```

Add the output to your `.env` file:

```bash
PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$...'
```

**Note:** Logins will fail if `PASSWORD_HASH` is not set.

### 3. Initialize Database

```bash
npx prisma migrate dev
```

### 4. Build the Claude Code Runner Image

```bash
pnpm run docker:build
```

### 5. Start the Application

```bash
pnpm run dev
```

Visit `http://localhost:3000` to access the application.

## Production Deployment

### Using Docker Compose

```bash
# Set environment variables
export GITHUB_TOKEN=your_github_token
export CLAUDE_AUTH_PATH=~/.claude

# Start services
cd docker
docker compose up -d
```

### With Cloudflare Tunnel (for secure remote access)

1. Create a Cloudflare Tunnel at https://one.dash.cloudflare.com/
2. Get your tunnel token
3. Add to your environment:
   ```bash
   export CLOUDFLARE_TUNNEL_TOKEN=your_tunnel_token
   ```
4. Start with the tunnel profile:
   ```bash
   docker compose --profile tunnel up -d
   ```

## Configuration

### Environment Variables

| Variable           | Description                        | Default                  |
| ------------------ | ---------------------------------- | ------------------------ |
| `PASSWORD_HASH`    | Argon2-hashed password for auth    | None (required)          |
| `DATABASE_URL`     | SQLite database path               | `file:./data/dev.db`     |
| `GITHUB_TOKEN`     | GitHub Personal Access Token       | Required for repo access |
| `CLAUDE_AUTH_PATH` | Path to Claude Code auth directory | `/root/.claude`          |
| `DATA_DIR`         | Directory for repos and worktrees  | `/data`                  |
| `NODE_ENV`         | Node environment                   | `development`            |

### GPU Support

The application uses NVIDIA Container Toolkit for GPU access. Ensure you have:

1. **NVIDIA drivers installed** - verify with `nvidia-smi`

2. **NVIDIA Container Toolkit installed:**

   ```bash
   # Add the NVIDIA container toolkit repository
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
     sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

   curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
     sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
     sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

   # Install the toolkit
   sudo apt-get update
   sudo apt-get install -y nvidia-container-toolkit

   # Configure Docker to use the NVIDIA runtime
   sudo nvidia-ctk runtime configure --runtime=docker

   # Restart Docker
   sudo systemctl restart docker
   ```

3. **Verify GPU access in Docker:**

   ```bash
   docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
   ```

   This should display your GPU information if everything is configured correctly.

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

## Development

```bash
# Run in development mode
pnpm run dev

# Run database migrations
pnpm run db:migrate

# Generate Prisma client
pnpm run db:generate

# Build for production
pnpm run build

# Start production server
pnpm start
```

## Security Considerations

- Single-user authentication via Argon2-hashed password stored in environment variable
- Database-backed sessions with random tokens (256-bit entropy)
- Session tracking includes IP addresses and user agents for audit purposes
- Claude Code runs with `--dangerously-skip-permissions` inside isolated containers
- Each session has its own container with a separate git worktree
- Docker socket access is provided for docker-in-docker capability
- Use Cloudflare Tunnel or similar for secure remote access (don't expose port 3000 directly)

## Troubleshooting

### Container won't start with GPU

Ensure NVIDIA Container Toolkit is properly installed:

```bash
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```

### Claude Code authentication errors

Make sure your Claude Code auth is properly mounted:

```bash
# Check if auth exists
ls -la ~/.claude/

# The directory should contain authentication tokens
```

### Database errors

Reset the database:

```bash
rm -rf prisma/data
npx prisma migrate dev
```

## License

MIT
