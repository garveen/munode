# Multi-stage Dockerfile for MuNode Rust servers (Edge + Hub)
# Build context must be the repository root (parent of rust/).
# Use: docker build -f rust/Dockerfile .
# Or via docker-compose.yml with context: ..

ARG http_proxy
ARG https_proxy
ARG no_proxy

# Stage 1: Build
FROM rust:alpine3.23 AS builder
RUN apk add --no-cache protobuf-dev cmake musl-dev openssl-dev openssl-libs-static pkgconf
run cargo install cargo-chef --locked
WORKDIR /build
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/munode-protocol/Cargo.toml rust/munode-protocol/build.rs munode-protocol/
COPY rust/munode-common/Cargo.toml munode-common/
COPY rust/munode-edge/Cargo.toml munode-edge/
COPY rust/munode-hub/Cargo.toml munode-hub/
COPY rust/munode-client/Cargo.toml munode-client/
COPY rust/munode-tests/Cargo.toml munode-tests/
# Dummy sources for cargo metadata + prepare + cook dependencies (cached until Cargo.* changes)
RUN mkdir -p munode-protocol/src munode-common/src munode-edge/src munode-hub/src munode-client/src munode-tests/src
RUN touch munode-protocol/src/lib.rs munode-common/src/lib.rs \
           munode-edge/src/lib.rs munode-edge/src/main.rs \
           munode-hub/src/lib.rs munode-hub/src/main.rs \
           munode-client/src/lib.rs munode-tests/src/lib.rs
RUN cargo chef prepare --recipe-path recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# Proto files only needed at actual build time (build.rs codegen), not during dependency cook
COPY packages/protocol/proto/ /proto/
ENV MUNODE_PROTO_DIR=/proto

# Copy full source (overwrites dummy files) and build application
COPY rust/munode-protocol/ munode-protocol/
COPY rust/munode-common/ munode-common/
COPY rust/munode-edge/ munode-edge/
COPY rust/munode-hub/ munode-hub/
COPY rust/munode-client/ munode-client/
COPY rust/munode-tests/ munode-tests/
RUN cargo build --release --bin munode-edge --bin munode-hub

# Stage 3: Minimal runtime image
FROM alpine:3.23 AS runtime
RUN apk add --no-cache ca-certificates netcat-openbsd su-exec \
    && mkdir -p /app/config /app/certs /app/data /app/logs
WORKDIR /app
COPY --from=builder /build/target/release/munode-edge /build/target/release/munode-hub /app/
COPY rust/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 64738/tcp 64738/udp 8443/tcp

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD nc -z localhost 64738 || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/munode-edge", "config/edge.toml"]
