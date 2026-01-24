FROM docker.io/node:24-slim

# Install dependencies for Prisma, git for cloning, and podman for container management
RUN apt-get update && apt-get install -y \
    openssl \
    git \
    podman \
    && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Generate Prisma client
RUN pnpm run db:generate

# Copy source code
COPY . .

# Build Next.js application
RUN pnpm run build

# Create data directory and set ownership to node user (UID 1000)
RUN mkdir -p /data/db /data/repos /data/worktrees && \
    chown -R node:node /data /app

# Switch to non-root user for security
USER node

# Expose port
EXPOSE 3000

# Start the application (run migrations first, then start)
CMD ["sh", "-c", "npx prisma migrate deploy && pnpm start"]
