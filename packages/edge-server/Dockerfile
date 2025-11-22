# Edge Server Dockerfile
FROM node:22-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.4 --activate

# Build stage
FROM base AS builder

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Copy all packages for workspace resolution
COPY packages/common/package.json ./packages/common/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/edge-server/package.json ./packages/edge-server/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/common ./packages/common
COPY packages/protocol ./packages/protocol
COPY packages/edge-server ./packages/edge-server

# Build all required packages
RUN pnpm --filter @munode/common build && \
    pnpm --filter @munode/protocol build && \
    pnpm --filter @munode/edge-server build

# Production stage
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy package.json files
COPY packages/common/package.json ./packages/common/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/edge-server/package.json ./packages/edge-server/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/edge-server/dist ./packages/edge-server/dist

# Create necessary directories
RUN mkdir -p /app/config /app/data /app/logs

# Expose ports
# 64738: Mumble TCP
# 64738: Mumble UDP (same port)
EXPOSE 64738/tcp 64738/udp

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('net').connect(64738, 'localhost').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"

WORKDIR /app/packages/edge-server

CMD ["node", "dist/cli.js", "start", "--config", "/app/config/edge.json"]
