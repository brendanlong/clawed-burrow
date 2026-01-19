# Claude Code Local Web

A self-hosted web application that provides mobile-friendly access to Claude Code running on your local machine with GPU support.

## Features

- Run Claude Code sessions from any device with a web browser
- Access local GPU resources for AI workloads
- Persistent sessions tied to git worktrees
- Secure authentication with username/password
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

- `GITHUB_TOKEN`: Your GitHub Personal Access Token
- `CLAUDE_AUTH_PATH`: Path to your Claude Code auth (usually `~/.claude`)

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
| `DATABASE_URL`     | SQLite database path               | `file:./data/dev.db`     |
| `GITHUB_TOKEN`     | GitHub Personal Access Token       | Required for repo access |
| `CLAUDE_AUTH_PATH` | Path to Claude Code auth directory | `/root/.claude`          |
| `DATA_DIR`         | Directory for repos and worktrees  | `/data`                  |
| `NODE_ENV`         | Node environment                   | `development`            |

### GPU Support

The application uses NVIDIA Container Toolkit for GPU access. Ensure you have:

1. NVIDIA drivers installed
2. NVIDIA Container Toolkit installed:
   ```bash
   # Ubuntu/Debian
   distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
   curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
   curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
     sudo tee /etc/apt/sources.list.d/nvidia-docker.list
   sudo apt-get update
   sudo apt-get install -y nvidia-container-toolkit
   sudo systemctl restart docker
   ```

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

- The application uses database-backed sessions with random tokens for authentication
- First user to register becomes the admin (registration is then disabled)
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
