# MuNode — Copilot Instructions

MuNode is a distributed Mumble voice server. The server-side (Hub + Edge) is written in Rust. A TypeScript client library exists under `packages/client/` and remains actively maintained. All other TypeScript packages under `packages/` are **deprecated** — do not modify them.

## Mandatory Rules

- When you have questions that need clarification, call ask-questions tool for further instructions instead of ending the conversation directly. DO NOT guess.
- When asked to fix one of the integration tests, do not run all tests — you must specify the file or use the `-t` parameter to run only that specific test. Do NOT use "--" for params, it's not needed.
- This system is still in the pre-0.1 stage. Everything except `Mumble.proto` — including any protocols — may be modified freely.
- **Do not optimize for minimal diff.** When making any change, choose the globally optimal solution — refactor, rename, restructure, or rewrite whatever is needed to produce the best overall result. Preserving existing code for the sake of a smaller diff is never a goal.
- **Keep example configs in sync with the schema.** Whenever you modify `rust/munode-common/src/config.rs` (add/remove/rename a field, change a default), update the corresponding `rust/config/edge.example.toml` and/or `rust/config/hub.example.toml` in the same change so the example stays a valid, accurate reference.

## Tech Stack

- **Language:** Rust (edition 2024, workspace)
- **Async runtime:** tokio (full features, work-stealing scheduler)
- **Protobuf:** prost 0.13 for encoding/decoding, prost-build for code generation
- **TLS:** tokio-rustls 0.26 + rustls 0.23 (no OpenSSL)
- **WebSocket:** tokio-tungstenite 0.26 (Hub ↔ Edge control channel)
- **HTTP framework:** axum 0.7 (Hub web API)
- **Database:** rusqlite 0.33 with bundled SQLite (WAL mode)
- **Crypto:** aes 0.8 (OCB2-AES128 Mumble voice encryption), ring 0.17 (HMAC, RNG), argon2 0.5 (password hashing); Edge-to-Edge voice uses ChaCha20-Poly1305 (via `ring`)
- **Serialization:** serde + toml (TOML config files), serde_json (RPC payloads)
- **Logging:** tracing 0.1 + tracing-subscriber (text or JSON output)
- **Error handling:** anyhow for application errors, thiserror for library error enums
- **Enum primitives:** num_enum 0.7 (`TryFromPrimitive`, `IntoPrimitive`) for all protocol integer↔enum mappings
- **Scripting:** mlua 0.10 (Lua 5.4, vendored) for pluggable auth scripts
- **Config format:** TOML files (`config/edge.toml`, `config/hub.toml`)
- **Client library (Rust):** `munode-client` crate — async, headless, `Clone + Send + Sync`
- **Client library (TypeScript):** `packages/client`, uses pnpm, ESModule, Node.js 22

## Project Structure

```
rust/                          # Rust workspace root (Cargo.toml)
├── munode-protocol/           # Protobuf types, message framing, transport, varint
├── munode-common/             # Config loading, logging, error types, rate limiting, permission bitmasks
├── munode-edge/               # Edge server binary — accepts Mumble clients
│   ├── main.rs                # Entry point
│   ├── server/
│   │   ├── mod.rs             # Main TCP listener + task spawning
│   │   ├── connection.rs      # Per-client TCP connection handler (login, message loop, cleanup)
│   │   ├── event_listener.rs  # Handles EdgeEvent (HubRegistered, UserJoined, etc.) → client broadcasts
│   │   └── proxy_protocol.rs  # PROXY Protocol v1/v2 header parsing
│   ├── hub_client/
│   │   ├── mod.rs             # HubClient: WebSocket pool, reconnect loop, notification sequencer
│   │   ├── rpc.rs             # All outbound RPC / fire-and-forget notification methods
│   │   └── notification.rs    # Inbound Hub notification dispatch (on_user_joined, on_channel_state, …)
│   ├── handler.rs             # Stateless message encoding helpers
│   ├── udp.rs                 # Voice packet routing (OCB2 decrypt → relay, UDP socket)
│   ├── routing.rs             # Shared voice target computation (UDP + TCP paths)
│   ├── voice.rs               # Voice payload helpers (inject_session_into_voice, etc.)
│   ├── hot_slot.rs            # Cache-line-aligned per-session hot data for voice routing hot path
│   ├── bandwidth.rs           # Per-user voice bandwidth ring-buffer (Murmur-compatible)
│   ├── crypto.rs              # OCB2-AES128 implementation (Mumble client ↔ Edge)
│   ├── edge_crypto.rs         # ChaCha20-Poly1305 Edge-to-Edge voice encryption + replay window
│   ├── client.rs              # ClientManager (Arc<RwLock<HashMap>>)
│   ├── channel_manager.rs     # Local channel tree (synced from Hub)
│   ├── state.rs               # Shared EdgeState + EdgeEvent bus
│   ├── peer_registry.rs       # Arc-swap peer Edge registry (peerJoined/peerLeft)
│   ├── relay_server.rs        # WebSocket relay for inter-Edge Hub tunneling
│   └── tls.rs                 # TLS acceptor setup
└── munode-hub/                # Hub server binary — cluster orchestrator
    ├── server.rs              # Main Hub loop (DB, auth, WebSocket listener)
    ├── rpc_handler.rs         # RPC dispatch (50+ request + notification handlers)
    ├── database.rs            # SQLite wrapper (users, channels, ACLs, bans, migrations)
    ├── session_manager.rs     # Active session tracking (cross-Edge)
    ├── channel_store.rs       # Channel tree with parent-child hierarchy
    ├── acl_manager.rs         # Permission system (bitmask, group, inheritance)
    ├── auth_service.rs        # Auth dispatch (local DB / Lua / HTTP)
    ├── lua_auth.rs            # Lua script engine for custom auth
    ├── blob_store.rs          # File storage (avatars, comments) with hash sharding
    ├── topology_manager.rs    # Edge registry + peer discovery
    ├── edge_connection.rs     # Per-Edge WebSocket handler
    ├── ban_store.rs           # In-memory ban store (write-through to DB)
    ├── user_store.rs          # In-memory user/channel-listener store
    ├── web_api.rs             # Axum REST API (/users, /channels, /bans, /stats)
    └── geoip.rs               # MaxMind GeoIP lookups

munode-client/                 # Rust Mumble client library (async, headless)
munode-tests/                  # Rust integration test crate (starts real Hub+Edge, uses munode-client)
│   ├── harness.rs             # TestEnvironment — spawns binaries, waits for readiness
│   ├── auth.rs                # Embedded HTTP auth server for tests
│   ├── users.rs               # User creation helpers
│   └── suites/                # Test suites: hub_edge, auth, users, channels, acl, ban, voice, udp, …

packages/client/               # TypeScript Mumble client (ACTIVE — do not deprecate)
packages/web-client/           # Browser SPA (Vue 3 + Pinia + Vite) — ACTIVE
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
- Modules and files: `snake_case` (`hub_client/mod.rs`, `channel_manager.rs`)

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
- Per-client: spawned async handler (`server/connection.rs`)
- Background: Hub WebSocket pool (`hub_client/mod.rs`) with exponential backoff reconnection
- Background: UDP voice server (`udp.rs`)
- Voice hot path: lock-free per-session `HotSlot` array (cache-line-aligned, atomic ops)
- All shared state through `Arc` clones passed into spawned tasks

### Logging
- Use `tracing` macros: `info!`, `warn!`, `error!`, `debug!`, `trace!`
- Include structured fields: `info!(session_id = %id, username = %name, "user connected")`
- JSON format available for production log aggregation

### Protobuf

**Source of truth:** all `.proto` files live in `packages/protocol/proto/`.  
**Generated output:** `rust/munode-protocol/src/generated/*.rs` — these files are **committed** to the repository so that builds without `protoc` work (e.g., CI, Docker).

#### Rules for working with proto files
- **Do not modify `Mumble.proto`** — it defines the external Mumble protocol.
- **Never manually edit files in `src/generated/`** — they are overwritten on every regeneration. Put logic in the `.proto` files instead.
- When adding a new `.proto` file:
  1. Create the file in `packages/protocol/proto/`.
  2. Add it to the `compile_protos` list in `rust/munode-protocol/build.rs`.
  3. Add the expected output filename to the `expected_files` array in `build.rs`.
  4. Run `MUNODE_REGEN_PROTO=1 cargo build -p munode-protocol` to regenerate.
  5. Commit both the `.proto` file and the updated `generated/*.rs` file together.
- When modifying an existing `.proto` file, regenerate and commit the updated `generated/*.rs`.
- prost generates `Option<T>` for every `optional message` field — access with `.as_ref()` or `if let Some(...)`.
- Proto2 has no top-level constants; define Rust-side constants in `munode-protocol/src/lib.rs` inside the relevant module block.
- Generated types are re-exported via `munode_protocol::{mumbleproto, hubedge, voiceudp, authservice, edgepeersync}`.
- Wire format: `[type:u16][length:u32][protobuf payload]`

#### Regeneration commands
```bash
# Force-regenerate all proto files (requires protoc to be installed)
cd rust && MUNODE_REGEN_PROTO=1 cargo build -p munode-protocol
```

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
- Voice: OCB2-AES128 encrypted UDP between clients ↔ Edge, with optional Hub TCP relay or direct Edge-to-Edge UDP (ChaCha20-Poly1305).
- Control relay: every Edge runs a transparent WebSocket relay so Edge A can reach Hub through Edge B if direct connection fails.

### RPC Flow
```
Client → Edge: Mumble TCP/TLS (protobuf frames)
Edge → Hub:    WebSocket (protobuf RPC request/response + fire-and-forget notifications)
Hub → Edge:    WebSocket sequenced notifications (broadcast to all connected Edges)
```

### Hub Connection Pool (`hub_client/mod.rs`)
- Multiple peer-equal WebSocket slots, configurable via `hub_server.pool_size`
- All slots can carry RPC traffic (round-robin); only one runs the sync sequence (CAS gate)
- `NotificationSequencer` reorders out-of-order Hub broadcasts; gap > `NOTIFICATION_GAP_TIMEOUT` (10 s) triggers reconnect + FullSync
- `PendingControlNotification` queue: failed fire-and-forget notifications (`UserLeft`, `ChannelLinksChanged`, `ChannelRemoved`) are enqueued and replayed before `do_full_sync` on the next successful reconnect

### Reconnect / FullSync Sequence
1. `do_register()` — Edge announces itself; Hub cleans up stale sessions
2. `flush_pending_notifications()` — replay queued control notifications
3. `do_full_sync()` — snapshot of all sessions and channels; sets `notification_expected_seq` fence
4. `do_fetch_voice_targets()` / `do_join_cluster()` / `do_report_local_users()` / `do_report_local_voice_targets()`
5. `EdgeEvent::HubRegistered` — `event_listener` pushes full state to all Ready clients

### Key RPC Methods
- `edge.register` — Edge announces itself to Hub
- `edge.authenticateUser` — Verify user credentials
- `edge.fullSync` — Sync all sessions/channels to Edge
- `edge.reportSession` — Re-report a live local session after reconnect
- `edge.saveChannel` / `edge.handleACL` — Channel mutations
- `hub.handleUserLeft` / `hub.handleUserMoved` / `hub.handleUserStateChanged` — User lifecycle
- `hub.handleChannelState` / `hub.handleChannelRemove` — Channel mutations
- `BlobGet` / `BlobPut` — Retrieve/store avatars and comments

### ACL System
- Permissions stored as bitmasks (defined in `munode-common/src/permission.rs`)
- Per-channel entries with optional group matching
- Inheritance: if `inherit_acl` is true, recursively check parent channel

### Voice Hot Path
- `HotSlot` array (10 000 lock-free slots, indexed by `session_id % 10_000`): stores channel, deaf state, OCB2 crypto, TCP sender, VoiceTarget config
- `routing.rs::compute_voice_targets` shared by UDP and TCP paths
- `bandwidth.rs`: per-user rolling ring-buffer enforces `max_bitrate` (Murmur-compatible 360-slot ring)
- `edge_crypto.rs`: ChaCha20-Poly1305 + sliding-window replay guard for Edge-to-Edge voice

### Database
- SQLite with WAL mode. Tables: `users`, `channels`, `acl_entries`, `bans`, `migrations`
- `BanStore` and `UserStore` maintain authoritative in-memory caches (write-through to DB)

## Testing

### Rust Tests
- Framework: built-in `#[tokio::test]` for async tests, `#[test]` for sync
- Tests live in each module's `#[cfg(test)] mod tests { ... }` block
- Integration tests live in `munode-tests` crate; `harness.rs` spawns real Hub+Edge binaries

```bash
cd rust/
cargo test                          # Run all unit tests across all crates
cargo test -p munode-edge           # Run tests for one crate
cargo test crypto::tests            # Run specific test module
cargo test -p munode-tests          # Run Rust integration tests (starts real Hub+Edge)
MUNODE_TEST_LOG=debug cargo test -p munode-tests -- --test-threads=1 --nocapture
```

### Integration Tests (TypeScript client)
- TypeScript integration tests in `tests/integration/` use vitest
- These tests start real Hub + Edge servers and connect with the TS client
- Run with: `pnpm test:integration` — Note: running all tests directly is generally forbidden; always specify a file or use `-t` to run a subset.
- Config: `vitest.config.integration.ts`
- **Integration tests use the debug binary** (`rust/target/debug/`), not the release binary. Always run `cargo build` (not `cargo build --release`) before running integration tests.

## Boundaries

- **Do not modify** any TypeScript packages except `packages/client/`
- **Do not modify** `Mumble.proto` — it defines the external Mumble protocol
- **Do not use** `unsafe` without explicit justification and documentation
- **Do not block** the tokio runtime — use `tokio::task::spawn_blocking` for CPU-heavy or synchronous I/O work
- **Do not add** new dependencies without checking for security advisories
- Prefer `Arc<RwLock<T>>` over `Arc<Mutex<T>>` for shared state that is read-heavy
- All public functions that can fail must return `Result<T>`
- Voice packet handling (UDP / HotSlot) must minimize latency — avoid allocations in the hot path
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
| **`packages/web-client`** | ✅ **Active** | Browser SPA (Vue 3 + Pinia + Vite) — actively maintained |

## Web Client i18n Convention

All UI string translations in `packages/web-client/src/i18n/locales/` **must follow the official Mumble C++ client wording**:

- **Source of truth:** `c-implement/src/mumble/mumble_zh_CN.ts` (Simplified Chinese) and `mumble_en.ts` (English).  
  These are Qt Linguist `.ts` XML files with `<source>` / `<translation>` pairs.
- When adding or editing a translation key, first look up the corresponding `<source>` string in `mumble_zh_CN.ts` (or `mumble_en.ts`) and reuse the `<translation>` verbatim.
- Only write new phrasing when no matching `<source>` entry exists (e.g., web-specific features like WebTransport modes, VAD threshold slider). In that case, follow Mumble's tone and terminology (concise, no title-case in Chinese).
- Event / notification messages (the `events.*` namespace) use the same sentence patterns as Mumble's `Log.cpp` log messages found in `mumble_zh_CN.ts` — e.g. `{name} 关闭了麦克风。` not `{name}已静音`.

## Quick Reference

| What | Where |
|------|-------|
| Build (release) | `cd rust && cargo build --release` |
| Build (debug, for integration tests) | `cd rust && cargo build` |
| Rust unit tests | `cd rust && cargo test` |
| Rust integration tests | `cd rust && cargo test -p munode-tests` |
| TS integration tests | `pnpm test:integration <file>` |
| **Regenerate proto (force)** | `cd rust && MUNODE_REGEN_PROTO=1 cargo build -p munode-protocol` |
| Edge binary | `rust/target/release/munode-edge` |
| Hub binary | `rust/target/release/munode-hub` |
| Edge config | `rust/config/edge.example.toml` |
| Hub config | `rust/config/hub.example.toml` |
| Proto files | `packages/protocol/proto/*.proto` |
| TS client library | `packages/client/` |
| Rust client library | `rust/munode-client/` |
| Architecture docs | `rust/docs/`, `docs/` |
