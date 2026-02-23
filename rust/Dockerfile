# Multi-stage Dockerfile for MuNode Rust servers (Edge + Hub)
# Build context must be the repository root (parent of rust/).
# Use: docker build -f rust/Dockerfile .
# Or via docker-compose.yml with context: ..

# Stage 1: Build the Rust binaries
FROM rust:1.86-bookworm AS builder

# Install protobuf compiler
RUN apt-get update && apt-get install -y protobuf-compiler cmake && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy proto files first (needed for prost-build)
COPY packages/protocol/proto/ /proto/

# Copy Rust workspace files
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/munode-protocol/ munode-protocol/
COPY rust/munode-common/ munode-common/
COPY rust/munode-edge/ munode-edge/
COPY rust/munode-hub/ munode-hub/

# Point build.rs at the proto directory via env var
ENV MUNODE_PROTO_DIR=/proto

# Build in release mode
RUN cargo build --release --bin munode-edge --bin munode-hub

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y ca-certificates netcat-openbsd && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r munode && useradd -r -g munode munode

WORKDIR /app

# Copy the binaries from the builder stage
COPY --from=builder /build/target/release/munode-edge /app/munode-edge
COPY --from=builder /build/target/release/munode-hub /app/munode-hub

# Create directories for config, certs, data, and logs
RUN mkdir -p /app/config /app/certs /app/data /app/logs && chown -R munode:munode /app

USER munode

# Default Mumble port (TCP + UDP)
EXPOSE 64738/tcp
EXPOSE 64738/udp
# Hub control port
EXPOSE 8443/tcp

# Health check: try to connect to the Mumble port
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD nc -z localhost 64738 || exit 1

ENTRYPOINT ["/app/munode-edge"]
CMD ["config/edge.json"]
