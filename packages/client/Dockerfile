# Headless Client Dockerfile
FROM node:22-alpine AS base

# Install dependencies for audio processing
RUN apk add --no-cache \
    ffmpeg \
    opus \
    opus-dev \
    python3 \
    make \
    g++

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
COPY packages/client/package.json ./packages/client/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/common ./packages/common
COPY packages/protocol ./packages/protocol
COPY packages/client ./packages/client

# Build all required packages
RUN pnpm --filter @munode/common build && \
    pnpm --filter @munode/protocol build && \
    pnpm --filter @munode/client build

# Production stage
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy package.json files
COPY packages/common/package.json ./packages/common/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/client/package.json ./packages/client/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/packages/common/dist ./packages/common/dist
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/client/dist ./packages/client/dist

# Create necessary directories
RUN mkdir -p /app/config /app/logs

# Expose ports
# 3000: HTTP API
# 3001: WebSocket
EXPOSE 3000 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

WORKDIR /app/packages/client

CMD ["node", "dist/index.js"]
