# Multi-stage Dockerfile for MuNode Rust servers (Edge + Hub)
# Build context must be the repository root (parent of rust/).
# Use: docker build -f rust/Dockerfile .
# Or via docker-compose.yml with context: ..
#
# syntax=docker/dockerfile:1
ARG http_proxy
ARG https_proxy
ARG no_proxy

# Stage 1: Build
FROM rust:alpine3.23 AS builder

RUN apk add --no-cache protobuf-dev cmake musl-dev openssl-dev openssl-libs-static pkgconf
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo install cargo-chef --locked
WORKDIR /build
COPY rust/Cargo.toml rust/Cargo.lock ./
# Strip client/tests from workspace so they are not compiled inside Docker
RUN sed -i '/"munode-client"/d; /"munode-tests"/d' Cargo.toml
COPY rust/munode-protocol/Cargo.toml rust/munode-protocol/build.rs munode-protocol/
COPY rust/munode-common/Cargo.toml munode-common/
COPY rust/munode-edge/Cargo.toml munode-edge/
COPY rust/munode-hub/Cargo.toml munode-hub/
# Dummy sources for cargo metadata + prepare + cook dependencies (cached until Cargo.* changes)
RUN mkdir -p munode-protocol/src munode-common/src munode-edge/src munode-hub/src
RUN touch munode-protocol/src/lib.rs munode-common/src/lib.rs \
           munode-edge/src/lib.rs munode-edge/src/main.rs \
           munode-hub/src/lib.rs munode-hub/src/main.rs
RUN cargo chef prepare --recipe-path recipe.json
# Cook dependencies — registry cache avoids re-downloading crates; target cache
# preserves incremental artefacts so only changed deps are recompiled.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=munode-target,target=/build/target \
    cargo chef cook --release --recipe-path recipe.json

# Proto files only needed at actual build time (build.rs codegen), not during dependency cook
COPY packages/protocol/proto/ /proto/
ENV MUNODE_PROTO_DIR=/proto

# Copy full source (overwrites dummy files) and build application.
# Binaries are copied to /usr/local/bin inside the same RUN so they survive
# outside the BuildKit target cache mount.
COPY rust/munode-protocol/ munode-protocol/
COPY rust/munode-common/ munode-common/
COPY rust/munode-edge/ munode-edge/
COPY rust/munode-hub/ munode-hub/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=munode-target,target=/build/target \
    cargo build --release --bin munode-edge --bin munode-hub \
    && cp target/release/munode-edge target/release/munode-hub /usr/local/bin/

# Stage 2: Minimal runtime image
FROM alpine:3.23 AS runtime
RUN apk add --no-cache ca-certificates netcat-openbsd su-exec \
    && mkdir -p /app/config /app/certs /app/data /app/logs
WORKDIR /app
COPY --from=builder /usr/local/bin/munode-edge /usr/local/bin/munode-hub /app/
COPY rust/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 64738/tcp 64738/udp 8443/tcp

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD nc -z localhost 64738 || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/munode-edge", "config/edge.toml"]
