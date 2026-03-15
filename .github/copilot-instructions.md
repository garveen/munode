# MuNode — Copilot Instructions

MuNode is a distributed Mumble voice server. The server-side (Hub + Edge) is written in Rust. A TypeScript client library exists under `packages/client/` and remains actively maintained. All other TypeScript packages under `packages/` are **deprecated** — do not modify them.

## Tech Stack

- **Language:** Rust (edition 2024, workspace)
- **Async runtime:** tokio (full features, work-stealing scheduler)
- **Protobuf:** prost 0.13 for encoding/decoding, prost-build for code generation
- **TLS:** tokio-rustls 0.26 + rustls 0.23 (no OpenSSL)
- **WebSocket:** tokio-tungstenite 0.26 (Hub ↔ Edge control channel)
- **HTTP framework:** axum 0.7 (Hub web API)
- **Database:** rusqlite 0.33 with bundled SQLite (WAL mode)
- **Crypto:** aes 0.8 (OCB2-AES128 voice encryption), ring 0.17 (HMAC, RNG), argon2 0.5 (password hashing)
- **Serialization:** serde + toml (TOML config files), serde_json (RPC payloads)
- **Logging:** tracing 0.1 + tracing-subscriber (text or JSON output)
- **Error handling:** anyhow for application errors, thiserror for library error enums, num_enum 0.7 for integer↔enum conversions
- **Enum primitives:** num_enum 0.7 (`TryFromPrimitive`, `IntoPrimitive`) for all protocol integer↔enum mappings
- **Scripting:** mlua 0.10 (Lua 5.4, vendored) for pluggable auth scripts
- **Config format:** TOML files (`config/edge.toml`, `config/hub.toml`)
- **Client library:** TypeScript (packages/client), uses pnpm, ESModule, Node.js 22

## Project Structure

```
rust/                          # Rust workspace root (Cargo.toml)
├── munode-protocol/           # Protobuf types, message framing, transport
├── munode-common/             # Config loading, logging, error types, rate limiting
├── munode-edge/               # Edge server binary — accepts Mumble clients
│   ├── server.rs              # Main TCP listener + task spawning
│   ├── hub_client.rs          # WebSocket connection to Hub (RPC + notifications)
│   ├── handler.rs             # Per-client message handling (auth, state, text)
│   ├── udp.rs                 # Voice packet routing (OCB2 decrypt → relay)
│   ├── crypto.rs              # OCB2-AES128 implementation
│   ├── client.rs              # ClientManager (Arc<RwLock<HashMap>>)
│   ├── channel_manager.rs     # Local channel tree (synced from Hub)
│   ├── state.rs               # Shared EdgeState + PeerRegistry
│   ├── relay_server.rs        # WebSocket relay for inter-Edge Hub tunneling
│   └── tls.rs                 # TLS acceptor setup
└── munode-hub/                # Hub server binary — cluster orchestrator
    ├── server.rs              # Main Hub loop (DB, auth, WebSocket listener)
    ├── rpc_handler.rs         # RPC dispatch (40+ message types)
    ├── database.rs            # SQLite wrapper (users, channels, ACLs, bans)
    ├── session_manager.rs     # Active session tracking
    ├── channel_store.rs       # Channel tree with parent-child hierarchy
    ├── acl_manager.rs         # Permission system (bitmask, group, inheritance)
    ├── auth_service.rs        # Auth dispatch (local DB / Lua / HTTP)
    ├── lua_auth.rs            # Lua script engine for custom auth
    ├── blob_store.rs          # File storage (avatars, comments) with hash sharding
    ├── topology_manager.rs    # Edge registry + peer discovery
    ├── edge_connection.rs     # Per-Edge WebSocket handler
    ├── web_api.rs             # Axum REST API (/users, /channels, /bans, /stats)
    └── geoip.rs               # MaxMind GeoIP lookups

packages/client/               # TypeScript Mumble client (ACTIVE — do not deprecate)
packages/{common,protocol,hub-server,edge-server,cli,auth-service}/
                               # ⚠️ DEPRECATED TypeScript server code — do not modify
```

## Coding Conventions

### Git
- **Commit messages must be in English.** Use the conventional-commit format: `type(scope): short summary`. Examples: `fix(crypto): handle IV wraparound`, `feat(acl): centralize permission constants`.

### Naming
- Structs and enums: `PascalCase` (`EdgeServer`, `ClientInfo`, `MessageType`)
- Functions and methods: `snake_case` (`connect_and_run`, `handle_client`)
- Constants: `UPPER_SNAKE_CASE` (`MAX_MESSAGE_SIZE`, `RELAY_IDLE_TIMEOUT`)
- Modules and files: `snake_case` (`hub_client.rs`, `channel_manager.rs`)

### Error Handling
- Use `anyhow::Result<T>` for application-level functions. Add `.context()` for meaningful error messages.
- Use `thiserror` derive macros for library error enums (e.g., `MunodeError`, `FrameError`).
- In CLI `main.rs`, print user-friendly messages and call `std::process::exit(1)` on failure.

```rust
// Application code
pub fn load_config(path: &str) -> anyhow::Result<EdgeConfig> {
    let content = std::fs::read_to_string(path)
        .context(format!("failed to read config at {}", path))?;
    toml::from_str(&content).context("invalid TOML syntax")
}

// Library code
#[derive(thiserror::Error, Debug)]
pub enum FrameError {
    #[error("message too large: {0} bytes")] TooLarge(usize),
    #[error("incomplete frame")] Incomplete,
}
```

### Async Patterns
- Use `tokio::spawn` for concurrent tasks. Share state via `Arc<T>`.
- Use `Arc<RwLock<HashMap<K, V>>>` for shared mutable collections (prefer `RwLock` over `Mutex` for mostly-read data).
- Use `mpsc` channels for queued work, `oneshot` for request-response, `broadcast` for fan-out notifications.
- Every long-running task (`run`, `connect_and_run`) returns `Result<()>` and logs errors internally.

### Concurrency
- Main task: TCP listener loop (`loop { listener.accept().await }`)
- Per-client: spawned async handler
- Background: Hub WebSocket client with exponential backoff reconnection
- Background: UDP voice server
- All shared state through `Arc` clones passed into spawned tasks

### Logging
- Use `tracing` macros: `info!`, `warn!`, `error!`, `debug!`, `trace!`
- Include structured fields: `info!(session_id = %id, username = %name, "user connected")`
- JSON format available for production log aggregation

### Protobuf
- Proto files live in `packages/protocol/proto/` — **do not modify `Mumble.proto`** (external interop)
- `munode-protocol/build.rs` compiles `.proto` → `src/generated/*.rs`
- Generated types are re-exported via `munode_protocol::{mumbleproto, hubedge, voiceudp, authservice}`
- Wire format: `[type:u16][length:u32][protobuf payload]`

### Configuration
- All config uses TOML (serde deserialization with smart defaults)
- Edge config: `load_edge_config(path) -> Result<EdgeConfig>`
- Hub config: `load_hub_config(path) -> Result<HubConfig>`
- See `rust/config/edge.example.toml` and `rust/config/hub.example.toml` for reference

## Architecture

### Hub-Edge Model
- **Hub** is the central orchestrator: user auth, ACL, database, session tracking, channel tree.
- **Edge** nodes accept Mumble client connections, handle voice routing, and delegate auth/permissions to Hub via WebSocket RPC.
- Edges discover each other through Hub notifications (`peerJoined`/`peerLeft`).
- Voice: OCB2-AES128 encrypted UDP between clients ↔ Edge, with optional Hub TCP relay or direct Edge-to-Edge UDP.
- Control relay: every Edge runs a transparent WebSocket relay so Edge A can reach Hub through Edge B if direct connection fails.

### RPC Flow
```
Client → Edge: Mumble TCP/TLS (protobuf frames)
Edge → Hub:    WebSocket (JSON-encoded RPC request/response)
Hub → Edge:    WebSocket notifications (broadcast to all connected Edges)
```

### Key RPC Methods
- `EdgeRegister` — Edge announces itself to Hub
- `EdgeAuthenticateUser` — Verify user credentials
- `EdgeJoin` — User joins cluster
- `EdgeFullSync` — Sync all users/channels to Edge
- `EdgeHandleTextMessage` — Relay text across Edges
- `BlobGet` / `BlobPut` — Retrieve/store avatars and comments

### ACL System
- Permissions stored as bitmasks (write, traverse, enter, speak, mute_deafen, move, etc.)
- Per-channel entries with optional group matching
- Inheritance: if `inherit_acl` is true, recursively check parent channel

### Database
- SQLite with WAL mode. Tables: `users`, `channels`, `acl_entries`, `bans`, `migrations`
- Schema is compatible with the TS implementation — databases are interchangeable

## Testing

### Rust Tests
- Framework: built-in `#[tokio::test]` for async tests, `#[test]` for sync
- Tests live in each module's `#[cfg(test)] mod tests { ... }` block
- ~80 tests across all crates (ACL, crypto, channels, sessions, database, blob store, handlers)

```bash
cd rust/
cargo test                        # Run all tests
cargo test -p munode-edge         # Run tests for one crate
cargo test crypto::tests          # Run specific test module
```

### Integration Tests (TypeScript client)
- TypeScript integration tests in `tests/integration/` use vitest
- These tests start real Hub + Edge servers and connect with the TS client
- Run with: `pnpm test:integration`
- Config: `vitest.config.integration.ts`

## Boundaries

- **Do not modify** any TypeScript packages except `packages/client/`
- **Do not modify** `Mumble.proto` — it defines the external Mumble protocol
- **Do not use** `unsafe` without explicit justification and documentation
- **Do not block** the tokio runtime — use `tokio::task::spawn_blocking` for CPU-heavy or synchronous I/O work
- **Do not add** new dependencies without checking for security advisories
- Prefer `Arc<RwLock<T>>` over `Arc<Mutex<T>>` for shared state that is read-heavy
- All public functions that can fail must return `Result<T>`
- Voice packet handling (UDP) must minimize latency — avoid allocations in the hot path
- **Backward compatibility is NOT required.** MuNode is pre-1.0 and internal — public API, config schema, database schema, and wire format (other than the external Mumble protocol) may be changed freely without a deprecation period. Prefer correct, idiomatic Rust over preserving old interfaces.

## Deprecated TypeScript Packages

The following packages under `packages/` are **deprecated** and should not receive new code:

| Package | Status | Notes |
|---------|--------|-------|
| `packages/common` | ⛔ Deprecated | Replaced by `rust/munode-common` |
| `packages/protocol` | ⛔ Deprecated | Replaced by `rust/munode-protocol` |
| `packages/hub-server` | ⛔ Deprecated | Replaced by `rust/munode-hub` |
| `packages/edge-server` | ⛔ Deprecated | Replaced by `rust/munode-edge` |
| `packages/cli` | ⛔ Deprecated | CLI now built into Rust binaries |
| `packages/auth-service` | ⛔ Deprecated | Replaced by `rust/munode-hub/auth_service.rs` |
| **`packages/client`** | ✅ **Active** | Only Mumble client — actively maintained (TypeScript) |

## Quick Reference

| What | Where |
|------|-------|
| Build | `cd rust && cargo build --release` |
| Test | `cd rust && cargo test` |
| Edge binary | `rust/target/release/munode-edge` |
| Hub binary | `rust/target/release/munode-hub` |
| Edge config | `rust/config/edge.example.toml` |
| Hub config | `rust/config/hub.example.toml` |
| Proto files | `packages/protocol/proto/*.proto` |
| Client library | `packages/client/` |
| Architecture docs | `rust/docs/`, `docs/` |
