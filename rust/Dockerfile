# Multi-stage Dockerfile for MuNode Rust servers (Edge + Hub)
# Build context must be the repository root (parent of rust/).
# Use: docker build -f rust/Dockerfile .
# Or via docker-compose.yml with context: ..
#
# syntax=docker/dockerfile:1
ARG http_proxy
ARG https_proxy
ARG no_proxy

# Stage 1: Shared Rust build tooling
FROM rust:alpine3.23 AS chef-base

RUN apk add --no-cache protobuf-dev cmake musl-dev openssl-dev openssl-libs-static pkgconf
RUN --mount=type=cache,id=munode-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=munode-cargo-git,target=/usr/local/cargo/git \
    cargo install cargo-chef --locked
WORKDIR /build

FROM chef-base AS edge-planner
COPY rust/Cargo.toml rust/Cargo.lock ./
# Limit the Docker workspace to the crates required for edge builds.
RUN sed -i '/"munode-hub"/d; /"munode-client"/d; /"munode-tests"/d' Cargo.toml
COPY rust/munode-protocol/Cargo.toml rust/munode-protocol/build.rs munode-protocol/
COPY rust/munode-common/Cargo.toml munode-common/
COPY rust/munode-edge/Cargo.toml munode-edge/
RUN mkdir -p munode-protocol/src munode-common/src munode-edge/src
RUN touch munode-protocol/src/lib.rs munode-common/src/lib.rs \
           munode-edge/src/lib.rs munode-edge/src/main.rs
RUN cargo chef prepare --recipe-path recipe.json

FROM chef-base AS edge-builder
COPY --from=edge-planner /build/recipe.json recipe.json
# Share all Cargo build caches across hub and edge. The target directory uses a
# locked mount because Cargo artefacts are not safe for concurrent writers.
RUN --mount=type=cache,id=munode-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=munode-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=munode-target,target=/build/target,sharing=locked \
    cargo chef cook --release --recipe-path recipe.json

COPY rust/Cargo.toml rust/Cargo.lock ./
RUN sed -i '/"munode-hub"/d; /"munode-client"/d; /"munode-tests"/d' Cargo.toml
COPY packages/protocol/proto/ /proto/
ENV MUNODE_PROTO_DIR=/proto
COPY rust/munode-protocol/ munode-protocol/
COPY rust/munode-common/ munode-common/
COPY rust/munode-edge/ munode-edge/
RUN --mount=type=cache,id=munode-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=munode-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=munode-target,target=/build/target,sharing=locked \
    cargo build --release --bin munode-edge \
    && cp target/release/munode-edge /usr/local/bin/

FROM chef-base AS hub-planner
COPY rust/Cargo.toml rust/Cargo.lock ./
# Limit the Docker workspace to the crates required for hub builds.
RUN sed -i '/"munode-edge"/d; /"munode-client"/d; /"munode-tests"/d' Cargo.toml
COPY rust/munode-protocol/Cargo.toml rust/munode-protocol/build.rs munode-protocol/
COPY rust/munode-common/Cargo.toml munode-common/
COPY rust/munode-hub/Cargo.toml munode-hub/
RUN mkdir -p munode-protocol/src munode-common/src munode-hub/src
RUN touch munode-protocol/src/lib.rs munode-common/src/lib.rs \
           munode-hub/src/lib.rs munode-hub/src/main.rs
RUN cargo chef prepare --recipe-path recipe.json

FROM chef-base AS hub-builder
COPY --from=hub-planner /build/recipe.json recipe.json
RUN --mount=type=cache,id=munode-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=munode-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=munode-target,target=/build/target,sharing=locked \
    cargo chef cook --release --recipe-path recipe.json

COPY rust/Cargo.toml rust/Cargo.lock ./
RUN sed -i '/"munode-edge"/d; /"munode-client"/d; /"munode-tests"/d' Cargo.toml
COPY packages/protocol/proto/ /proto/
ENV MUNODE_PROTO_DIR=/proto
COPY rust/munode-protocol/ munode-protocol/
COPY rust/munode-common/ munode-common/
COPY rust/munode-hub/ munode-hub/
RUN --mount=type=cache,id=munode-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=munode-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=munode-target,target=/build/target,sharing=locked \
    cargo build --release --bin munode-hub \
    && cp target/release/munode-hub /usr/local/bin/

# Stage 2: Minimal runtime base image
FROM alpine:3.23 AS runtime-base
RUN apk add --no-cache ca-certificates netcat-openbsd su-exec \
    && mkdir -p /app/config /app/certs /app/data /app/logs
WORKDIR /app
COPY rust/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]

FROM runtime-base AS edge-runtime
COPY --from=edge-builder /usr/local/bin/munode-edge /app/munode-edge

EXPOSE 64738/tcp 64738/udp

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD nc -z localhost 64738 || exit 1

CMD ["/app/munode-edge", "config/edge.toml"]

FROM runtime-base AS hub-runtime
COPY --from=hub-builder /usr/local/bin/munode-hub /app/munode-hub

EXPOSE 8443/tcp 8080/tcp

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD nc -z localhost 8080 || exit 1

CMD ["/app/munode-hub", "config/hub.toml"]
