# Clawed Burrow

A place for [clawed creatures](https://claude.ai/code) that run far from the cloud.

> **Note:** This is an unofficial community project and is not affiliated with, endorsed by, or supported by Anthropic. [Claude Code](https://claude.ai/code) is a product of Anthropic, but this web interface is an independent project.

A self-hosted web application that provides mobile-friendly access to Claude Code running on your local machine with GPU support.

## Features

- Run Claude Code sessions from any device with a web browser
- Access local GPU resources for AI workloads
- Persistent sessions with isolated git clones
- Simple password-based authentication (single user)
- Session tracking with IP addresses and login history
- Clean session lifecycle management
- Mobile-friendly interface
- **Rootless containers** - Claude Code agents have sudo access inside containers without root on the host

## Prerequisites

- Node.js 20+
- Podman with NVIDIA Container Toolkit (for GPU support)
- A GitHub Fine-grained Personal Access Token (recommended for security)
- Claude Code installed and authenticated on your host machine

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/brendanlong/clawed-burrow.git
cd clawed-burrow
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set:

- `PASSWORD_HASH`: Base64-encoded Argon2 hash for authentication (see below)
- `GITHUB_TOKEN`: Your GitHub Fine-grained Personal Access Token (see below)
- `CLAUDE_AUTH_PATH`: Path to your Claude Code auth (usually `~/.claude`)

### Generate GitHub Token

For security, use a **Fine-grained Personal Access Token** instead of a classic token:

1. Go to https://github.com/settings/personal-access-tokens/new
2. Select "Fine-grained personal access token"
3. Under "Repository access", select "Only select repositories" and choose the repos you want to use
4. Under "Permissions" → "Repository permissions", set:
   - **Contents**: Read and write (for push/pull)
   - **Metadata**: Read-only (automatically included)
5. Generate the token and add it to your `.env` file

### Generate Password Hash

Generate a base64-encoded Argon2 hash of your password:

```bash
pnpm hash-password your-secure-password
```

Add the output to your `.env` file:

```bash
PASSWORD_HASH="JGFyZ29uMmlkJHY9MTkkbT02NTUzNix0PTMscD00JC4uLg=="
```

The hash is base64-encoded to avoid issues with `$` characters in dotenv.

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

### Building Images Locally

If you want to build the images yourself instead of using the pre-built images from GitHub Container Registry:

```bash
# Build the main app (from root Dockerfile)
podman build -t ghcr.io/brendanlong/clawed-burrow:latest -f Dockerfile .

# Build the Claude runner (from docker/Dockerfile.claude-code)
podman build -t ghcr.io/brendanlong/clawed-burrow-runner:latest -f docker/Dockerfile.claude-code .
```

### Running with Podman

First, enable the Podman socket (required for container management):

```bash
systemctl --user enable --now podman.socket
```

Create the data directory:

```bash
mkdir -p ~/.clawed-burrow
```

Run the container:

```bash
podman run -d \
  --name clawed-burrow \
  --replace \
  --label io.containers.autoupdate=registry \
  -p 3000:3000 \
  -e DATABASE_URL=file:/data/db/prod.db \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -e CLAUDE_AUTH_PATH="$HOME/.claude" \
  -e NODE_ENV=production \
  -e PASSWORD_HASH="$PASSWORD_HASH" \
  -e PODMAN_SOCKET_PATH="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock" \
  -e CLAUDE_RUNNER_IMAGE=ghcr.io/brendanlong/clawed-burrow-runner:latest \
  ${PNPM_STORE_PATH:+-e PNPM_STORE_PATH="$PNPM_STORE_PATH"} \
  ${GRADLE_USER_HOME:+-e GRADLE_USER_HOME="$GRADLE_USER_HOME"} \
  -v clawed-burrow-db:/data/db \
  -v clawed-burrow-workspaces:/data/workspaces \
  -v "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock:/var/run/docker.sock" \
  -v "$HOME/.claude:/claude-auth" \
  --device nvidia.com/gpu=all \
  --security-opt label=disable \
  --restart always \
  ghcr.io/brendanlong/clawed-burrow:latest
```

### Installing as a systemd Service

For automatic startup and management, install as a user systemd service:

1. **Generate the systemd unit file** (after the container is running):

   ```bash
   mkdir -p ~/.config/systemd/user
   podman generate systemd --name clawed-burrow --new > ~/.config/systemd/user/clawed-burrow.service
   ```

2. **Reload systemd and enable the service:**

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable clawed-burrow.service
   ```

3. **Enable lingering** (so the service runs even when you're not logged in):

   ```bash
   loginctl enable-linger $USER
   ```

4. **Start the service:**

   ```bash
   systemctl --user start clawed-burrow.service
   ```

### Viewing Logs

View logs using journalctl:

```bash
# Follow logs in real-time
journalctl --user -u clawed-burrow.service -f

# View recent logs
journalctl --user -u clawed-burrow.service -n 100

# View logs since last boot
journalctl --user -u clawed-burrow.service -b

# View logs from a specific time
journalctl --user -u clawed-burrow.service --since "1 hour ago"
```

Or use podman directly:

```bash
podman logs -f clawed-burrow
```

### Automatic Updates with Podman

Podman can automatically pull and restart containers when new images are available. This works with the systemd service setup above.

1. **Enable the auto-update timer:**

   ```bash
   systemctl --user enable --now podman-auto-update.timer
   ```

   This checks for updates daily at midnight.

2. **Verify the timer is active:**

   ```bash
   systemctl --user list-timers | grep auto-update
   ```

3. **Run updates manually** (or check what would be updated):

   ```bash
   # Dry run - see what would be updated
   podman auto-update --dry-run

   # Actually update
   podman auto-update
   ```

4. **Check update logs:**

   ```bash
   journalctl --user -u podman-auto-update.service
   ```

The container includes the `io.containers.autoupdate=registry` label which tells Podman to check the registry for new images. When an update is found, Podman pulls the new image and restarts the systemd service.

**Note:** The `--new` flag in `podman generate systemd` is required for auto-updates to work. This ensures systemd creates a fresh container from the latest image on each restart rather than restarting the old container.

### Running as a Dedicated Unprivileged User

For improved isolation, you can run Clawed Burrow as a dedicated unprivileged user instead of your main user account. This provides a layer of security since the Podman socket gives Claude Code agents the ability to run arbitrary containers on your system.

**Note:** This is a partial solution to [issue #92](https://github.com/brendanlong/clawed-burrow/issues/92). The dedicated user can still run containers with GPU access, but cannot affect your main user's files or processes.

#### 1. Create the dedicated user

```bash
# Create a new user for running Clawed Burrow
sudo useradd -m -s /bin/bash clawedburrow

# Add subuid/subgid ranges for rootless Podman
sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 clawedburrow

# Enable lingering so user services run without login
sudo loginctl enable-linger clawedburrow
```

#### 2. Set up Podman for the new user

```bash
# Switch to the new user
sudo -u clawedburrow -i

# Enable the Podman socket
systemctl --user enable --now podman.socket

# Verify the socket is running
ls -la /run/user/$(id -u)/podman/podman.sock

# Exit back to your main user
exit
```

#### 3. Authenticate Claude Code

Claude Code needs to be authenticated as the dedicated user. You have two options:

**Option A: Authenticate interactively**

```bash
# Switch to the new user
sudo -u clawedburrow -i

# Run Claude Code to trigger authentication
claude --version

# If not authenticated, run any command to trigger the auth flow
# Note: You may need to copy the auth URL to a browser on another machine
claude -p "hello"

# Exit back to your main user
exit
```

**Option B: Copy existing authentication**

```bash
# Copy your existing Claude auth to the new user
sudo cp -r ~/.claude /home/clawedburrow/.claude
sudo chown -R clawedburrow:clawedburrow /home/clawedburrow/.claude
```

#### 4. Create the data directory

```bash
sudo mkdir -p /home/clawedburrow/.clawed-burrow
sudo chown clawedburrow:clawedburrow /home/clawedburrow/.clawed-burrow
```

#### 5. Pull the container images

```bash
sudo -u clawedburrow podman pull ghcr.io/brendanlong/clawed-burrow:latest
sudo -u clawedburrow podman pull ghcr.io/brendanlong/clawed-burrow-runner:latest
```

#### 6. Run the container as the dedicated user

Set the required environment variables first:

```bash
# Generate a password hash (run as any user with pnpm installed)
pnpm hash-password your-secure-password
# Save this hash for the next step
```

Create a script at `/home/clawedburrow/start-clawed-burrow.sh`:

```bash
#!/bin/bash
export GITHUB_TOKEN="ghp_your_token_here"
export PASSWORD_HASH="your_base64_hash_here"

podman run -d \
  --name clawed-burrow \
  --replace \
  --label io.containers.autoupdate=registry \
  -p 3000:3000 \
  -e DATABASE_URL=file:/data/db/prod.db \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -e CLAUDE_AUTH_PATH="/home/clawedburrow/.claude" \
  -e NODE_ENV=production \
  -e PASSWORD_HASH="$PASSWORD_HASH" \
  -e PODMAN_SOCKET_PATH="/run/user/$(id -u)/podman/podman.sock" \
  -e CLAUDE_RUNNER_IMAGE=ghcr.io/brendanlong/clawed-burrow-runner:latest \
  -v clawed-burrow-db:/data/db \
  -v clawed-burrow-workspaces:/data/workspaces \
  -v "/run/user/$(id -u)/podman/podman.sock:/var/run/docker.sock" \
  -v "/home/clawedburrow/.claude:/claude-auth" \
  --device nvidia.com/gpu=all \
  --security-opt label=disable \
  --restart always \
  ghcr.io/brendanlong/clawed-burrow:latest
```

Make it executable and run:

```bash
sudo chmod +x /home/clawedburrow/start-clawed-burrow.sh
sudo chown clawedburrow:clawedburrow /home/clawedburrow/start-clawed-burrow.sh

# Run as the dedicated user
sudo -u clawedburrow /home/clawedburrow/start-clawed-burrow.sh
```

#### 7. Set up as a systemd service

```bash
# Switch to the dedicated user
sudo -u clawedburrow -i

# Generate the systemd unit file
mkdir -p ~/.config/systemd/user
podman generate systemd --name clawed-burrow --new > ~/.config/systemd/user/clawed-burrow.service

# Reload systemd and enable the service
systemctl --user daemon-reload
systemctl --user enable clawed-burrow.service
systemctl --user start clawed-burrow.service

# Exit back to your main user
exit
```

#### 8. Set up automatic updates (optional)

```bash
sudo -u clawedburrow bash -c "systemctl --user enable --now podman-auto-update.timer"
```

#### Viewing logs

```bash
# View logs as the dedicated user
sudo -u clawedburrow journalctl --user -u clawed-burrow.service -f

# Or use podman directly
sudo -u clawedburrow podman logs -f clawed-burrow
```

### With Tailscale Funnel (for secure remote access)

Tailscale Funnel allows secure remote access without exposing ports or requiring traditional VPN setup.

1. **Install Tailscale** on your server: https://tailscale.com/download

2. **Enable Funnel** for your machine:

   ```bash
   # Enable HTTPS and Funnel in Tailscale admin console first
   # Then expose your app:
   tailscale funnel 3000
   ```

3. **Access your app** at `https://<machine-name>.<tailnet-name>.ts.net`

For persistent Funnel configuration, see the [Tailscale Funnel documentation](https://tailscale.com/kb/1223/funnel).

## Configuration

### Environment Variables

| Variable           | Description                             | Default              |
| ------------------ | --------------------------------------- | -------------------- |
| `PASSWORD_HASH`    | Base64-encoded Argon2 hash for auth     | None (required)      |
| `DATABASE_URL`     | SQLite database path                    | `file:./data/dev.db` |
| `GITHUB_TOKEN`     | GitHub Fine-grained PAT for repo access | Required             |
| `CLAUDE_AUTH_PATH` | Path to Claude Code auth directory      | `/root/.claude`      |
| `DATA_DIR`         | Directory for session workspaces        | `/data`              |
| `NODE_ENV`         | Node environment                        | `development`        |

### GPU Support

The application uses NVIDIA Container Toolkit with CDI (Container Device Interface) for GPU access. Ensure you have:

1. **NVIDIA drivers installed** - verify with `nvidia-smi`

2. **Podman installed:**

   ```bash
   # Ubuntu/Debian
   sudo apt-get install -y podman fuse-overlayfs slirp4netns uidmap

   # Fedora
   sudo dnf install -y podman
   ```

3. **NVIDIA Container Toolkit installed:**

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
   ```

4. **Generate CDI specification for Podman:**

   ```bash
   # Generate CDI spec (must be run as root)
   sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

   # Verify the spec was created
   ls -la /etc/cdi/nvidia.yaml
   ```

   **Note:** You need to regenerate the CDI spec after NVIDIA driver updates or GPU changes.

5. **Verify GPU access in Podman:**

   ```bash
   podman run --rm --device nvidia.com/gpu=all --security-opt=label=disable \
     nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
   ```

   This should display your GPU information if everything is configured correctly.

### Rootless Podman Setup

For rootless operation (recommended for security):

1. **Enable the user Podman socket:**

   ```bash
   systemctl --user enable --now podman.socket
   ```

2. **Verify the socket is running:**

   ```bash
   ls -la /run/user/$(id -u)/podman/podman.sock
   ```

3. **Configure subuid/subgid** (if not already done):

   ```bash
   # Check if your user has subuid/subgid ranges
   grep $USER /etc/subuid /etc/subgid

   # If not, add them:
   sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
   ```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│   Mobile/Web    │     │   Tailscale     │     │      Home Server            │
│   Browser       │────►│   Funnel        │────►│  ┌─────────────────────┐    │
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
                                                │  │  │ + GPU access  │  │    │
                                                │  │  │ + sudo access │  │    │
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
- Each session has its own container with an isolated git clone
- Use Fine-grained PATs scoped to specific repos with minimal permissions
- **Rootless Podman**: Claude Code agents have sudo access inside containers, but this doesn't grant root on the host
- Podman socket access is provided for container-in-container capability
- Use Tailscale Funnel or similar for secure remote access (don't expose port 3000 directly)

## Troubleshooting

### Container won't start with GPU

1. **Verify CDI spec exists:**

   ```bash
   ls -la /etc/cdi/nvidia.yaml
   ```

   If missing, generate it:

   ```bash
   sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
   ```

2. **Test GPU access directly:**

   ```bash
   podman run --rm --device nvidia.com/gpu=all --security-opt=label=disable \
     nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
   ```

3. **Check nvidia-container-toolkit version:**

   ```bash
   nvidia-ctk --version
   ```

   CDI support requires nvidia-container-toolkit 1.12.0 or later.

### Podman socket not found

```bash
# Enable and start the user socket
systemctl --user enable --now podman.socket

# Verify it's running
systemctl --user status podman.socket
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

### Podman auto-update not working

1. **Verify the container has the auto-update label:**

   ```bash
   podman inspect <container> | grep -A5 autoupdate
   ```

2. **Check the timer status:**

   ```bash
   systemctl --user status podman-auto-update.timer
   ```

3. **Run a dry-run to see what would be updated:**

   ```bash
   podman auto-update --dry-run
   ```

## License

MIT
