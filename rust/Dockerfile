# Multi-stage Dockerfile for MuNode Rust servers (Edge + Hub)
# Build context must be the repository root (parent of rust/).
# Use: docker build -f rust/Dockerfile .
# Or via docker-compose.yml with context: ..

# Stage 0: Install cargo-chef
FROM rust:1.86-bookworm AS chef
RUN cargo install cargo-chef --locked
RUN apt-get update && apt-get install -y protobuf-compiler cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /build

# Stage 1: Compute the dependency recipe
FROM chef AS planner
# Copy proto files (build.rs may inspect them at plan time)
COPY packages/protocol/proto/ /proto/
ENV MUNODE_PROTO_DIR=/proto
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/munode-protocol/ munode-protocol/
COPY rust/munode-common/ munode-common/
COPY rust/munode-edge/ munode-edge/
COPY rust/munode-hub/ munode-hub/
RUN cargo chef prepare --recipe-path recipe.json

# Stage 2: Cache dependency compilation
FROM chef AS builder
COPY packages/protocol/proto/ /proto/
ENV MUNODE_PROTO_DIR=/proto
COPY --from=planner /build/recipe.json recipe.json
# Build only dependencies - this layer is cached unless Cargo.toml/Cargo.lock changes
RUN cargo chef cook --release --recipe-path recipe.json

# Stage 3: Build the application binaries
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/munode-protocol/ munode-protocol/
COPY rust/munode-common/ munode-common/
COPY rust/munode-edge/ munode-edge/
COPY rust/munode-hub/ munode-hub/

# Build in release mode (dependencies already compiled above)
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
