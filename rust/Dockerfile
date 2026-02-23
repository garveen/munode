# Multi-stage Dockerfile for MuNode Rust Edge Server
# Stage 1: Build the Rust binary
FROM rust:1.86-bookworm AS builder

# Install protobuf compiler
RUN apt-get update && apt-get install -y protobuf-compiler cmake && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy workspace files
COPY Cargo.toml Cargo.lock ./
COPY munode-protocol/ munode-protocol/
COPY munode-common/ munode-common/
COPY munode-edge/ munode-edge/
COPY munode-hub/ munode-hub/

# Copy proto files from the parent packages directory (needed for prost-build)
COPY ../packages/protocol/proto/ /proto/

# Build in release mode
RUN cargo build --release --bin munode-edge

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r munode && useradd -r -g munode munode

WORKDIR /app

# Copy the binary from the builder stage
COPY --from=builder /build/target/release/munode-edge /app/munode-edge

# Create directories for config, certs, and logs
RUN mkdir -p /app/config /app/certs /app/logs && chown -R munode:munode /app

USER munode

# Default Mumble port (TCP + UDP)
EXPOSE 64738/tcp
EXPOSE 64738/udp

# Health check: try to connect to the TLS port
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD timeout 3 bash -c '</dev/tcp/localhost/64738' 2>/dev/null || exit 1

ENTRYPOINT ["/app/munode-edge"]
CMD ["config/edge.json"]
