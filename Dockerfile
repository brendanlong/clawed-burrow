FROM node:20-slim

# Install dependencies for Prisma
RUN apt-get update && apt-get install -y \
    openssl \
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

# Create data directory
RUN mkdir -p /data/db /data/repos /data/worktrees

# Expose port
EXPOSE 3000

# Start the application
CMD ["pnpm", "start"]
