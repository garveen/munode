//! Test environment harness — starts Hub and Edge processes.
//!
//! Mirrors `tests/integration/setup.ts` `setupTestEnvironment`.

use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use munode_client::{ConnectOptions, MumbleClient};
use serde_json::{json, Value};

use crate::auth::start_auth_server;
use crate::users::find_user;

// ── Crypto provider initialization ────────────────────────────────────────

static CRYPTO_INIT: OnceLock<()> = OnceLock::new();

/// Install the default rustls CryptoProvider (ring) once per process.
/// Required because both `ring` and `aws-lc-rs` are present in the dep graph
/// and rustls cannot automatically choose between them.
fn ensure_crypto_provider() {
    CRYPTO_INIT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

// ── Constants ─────────────────────────────────────────────────────────────

const HMAC_SECRET: &str = "test-hmac-secret-key-for-integration-tests";

/// Path to the test TLS certificates directory (relative to the workspace root).
pub fn certs_dir() -> PathBuf {
    workspace_root().join("tests/integration/certs")
}

/// Path to the Rust workspace root.
pub fn workspace_root() -> PathBuf {
    // Detected at runtime from the location of this source file via env!()
    // which resolves CARGO_MANIFEST_DIR as the munode-tests crate directory.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest_dir)
        .parent() // munode-tests/ → rust/
        .unwrap()
        .parent() // rust/ → /www/munode
        .unwrap()
        .to_path_buf()
}

/// Locate a Rust binary: prefers release, falls back to debug.
pub fn find_binary(name: &str) -> Result<PathBuf> {
    // Allow explicit override via environment variable
    let env_key = format!("MUNODE_{}_BIN", name.to_uppercase().replace('-', "_"));
    if let Ok(p) = std::env::var(&env_key) {
        return Ok(PathBuf::from(p));
    }

    let rust_dir = workspace_root().join("rust");
    let release = rust_dir.join("target/release").join(name);
    let debug = rust_dir.join("target/debug").join(name);

    if release.exists() {
        Ok(release)
    } else if debug.exists() {
        Ok(debug)
    } else {
        bail!(
            "Binary '{}' not found. Run `cargo build` in rust/.\n  Checked: {}\n  Checked: {}",
            name,
            release.display(),
            debug.display()
        )
    }
}

// ── Port utilities ────────────────────────────────────────────────────────

/// Find an available TCP port starting from `base`.
pub fn find_free_port(base: u16) -> Result<u16> {
    for port in base..base + 200 {
        if std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok() {
            return Ok(port);
        }
    }
    bail!("No free port found starting from {}", base)
}

/// Wait until a TCP port accepts connections (up to `timeout`).
pub fn wait_for_port(port: u16, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("Timed out waiting for port {} to be ready", port);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ── Database seeding ──────────────────────────────────────────────────────

/// Create a fresh Hub test database with the standard channel structure.
///
/// Creates: Root(0), Lobby(1), General(2), Private(3).
pub fn seed_database(db_path: &Path) -> Result<()> {
    // Remove existing DB files
    for suffix in &["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{}", db_path.display(), suffix));
        if p.exists() {
            fs::remove_file(&p)?;
        }
    }

    // Create the schema using the exact same DDL as the Rust Hub's init_tables(),
    // so the Hub can open this database without any incompatibility.
    let conn = rusqlite::Connection::open(db_path)?;
    conn.execute_batch(r#"
        PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            email TEXT,
            password_hash TEXT,
            texture_blob TEXT,
            comment_blob TEXT,
            last_seen INTEGER,
            last_channel INTEGER,
            created_at INTEGER,
            updated_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);

        CREATE TABLE IF NOT EXISTS user_last_channels (
            id INTEGER PRIMARY KEY,
            last_channel INTEGER
        );

        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            max_users INTEGER NOT NULL DEFAULT 0,
            parent_id INTEGER NOT NULL DEFAULT 0,
            inherit_acl INTEGER NOT NULL DEFAULT 1,
            description_blob TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_channel_parentid ON channels(parent_id);

        CREATE TABLE IF NOT EXISTS channel_links (
            channel_id INTEGER NOT NULL,
            link_id INTEGER NOT NULL,
            PRIMARY KEY (channel_id, link_id),
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (link_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS acls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at DATETIME,
            updated_at DATETIME,
            deleted_at DATETIME,
            channel_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL DEFAULT -1,
            "group" TEXT,
            apply_here INTEGER NOT NULL DEFAULT 1,
            apply_subs INTEGER NOT NULL DEFAULT 1,
            allow INTEGER NOT NULL DEFAULT 0,
            deny INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_acls_deleted_at ON acls(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_acl_channelid ON acls(channel_id);

        CREATE TABLE IF NOT EXISTS channel_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            inherit INTEGER NOT NULL DEFAULT 1,
            inheritable INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME,
            updated_at DATETIME,
            UNIQUE(channel_id, name),
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_channel_groups_channel ON channel_groups(channel_id);

        CREATE TABLE IF NOT EXISTS channel_group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_group_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            is_add INTEGER NOT NULL,
            created_at DATETIME,
            FOREIGN KEY (channel_group_id) REFERENCES channel_groups(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_channel_group_members_group ON channel_group_members(channel_group_id);

        CREATE TABLE IF NOT EXISTS bans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at DATETIME,
            updated_at DATETIME,
            deleted_at DATETIME,
            address BLOB NOT NULL,
            mask INTEGER NOT NULL DEFAULT 128,
            name TEXT,
            hash TEXT,
            reason TEXT,
            start INTEGER NOT NULL DEFAULT 0,
            duration INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_bans_deleted_at ON bans(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_bans_address ON bans(address);
        CREATE INDEX IF NOT EXISTS idx_bans_hash ON bans(hash);

        CREATE TABLE IF NOT EXISTS schema_versions (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL DEFAULT 0
        );

        -- Root channel (ID=0). parent_id=-1 is the sentinel for "no parent".
        INSERT OR IGNORE INTO channels (id, name, position, parent_id, inherit_acl, description_blob)
            VALUES (0, 'Root', 0, -1, 1, '');

        -- Test channels (parent_id=0 means child of Root)
        INSERT OR IGNORE INTO channels (id, name, position, parent_id, inherit_acl, description_blob)
            VALUES (1, 'Lobby', 0, 0, 1, '');
        INSERT OR IGNORE INTO channels (id, name, position, parent_id, inherit_acl, description_blob)
            VALUES (2, 'General', 1, 0, 1, '');
        INSERT OR IGNORE INTO channels (id, name, position, parent_id, inherit_acl, description_blob)
            VALUES (3, 'Private', 2, 0, 1, '');
    "#).context("seed database")?;

    Ok(())
}

// ── Process management ────────────────────────────────────────────────────

/// A managed server process (Hub or Edge).
pub struct ServerProcess {
    child: Option<Child>,
    label: String,
}

impl ServerProcess {
    fn new(child: Child, label: String) -> Self {
        Self { child: Some(child), label }
    }

    /// Stop the process gracefully (SIGTERM, then kill if needed).
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Try SIGTERM first (Unix only, using nix-free approach)
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &child.id().to_string()])
                    .status();
            }
            #[cfg(not(unix))]
            let _ = child.kill();

            // Wait up to 5 seconds for clean exit
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            tracing::debug!("{} stopped", self.label);
        }
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── Hub config generation ─────────────────────────────────────────────────

fn generate_hub_config(params: &HubParams) -> Value {
    json!({
        "network": {
            "host": "127.0.0.1",
            "control_port": params.control_port,
        },
        "database": {
            "path": params.db_path,
        },
        "blob_store": {
            "path": params.blob_store_path,
        },
        "auth": {
            "allow_guest": true,
            "http_url": format!("http://127.0.0.1:{}/auth", params.auth_port),
            "require_auth_service": false,
        },
        "registry": {
            "hmac_secret": HMAC_SECRET,
            "heartbeat_timeout": 90000,
        },
        "web_api": {
            "enabled": true,
            "host": "127.0.0.1",
            "port": params.web_api_port,
        },
        "log_level": if params.verbose { "debug" } else { "error" },
    })
}

struct HubParams<'a> {
    control_port: u16,
    web_api_port: u16,
    auth_port: u16,
    db_path: &'a str,
    blob_store_path: &'a str,
    verbose: bool,
}

// ── Edge config generation ────────────────────────────────────────────────

fn generate_edge_config(params: &EdgeParams) -> Value {
    let certs = certs_dir();
    json!({
        "server_id": params.server_id,
        "name": params.name,
        "network": {
            "host": "0.0.0.0",
            "port": params.port,
            "edge_port": params.edge_port,
            "external_host": "127.0.0.1",
        },
        "tls": {
            "cert": certs.join("server.pem").display().to_string(),
            "key":  certs.join("server.key").display().to_string(),
            "ca":   certs.join("ca.pem").display().to_string(),
        },
        "hub_server": {
            "host": "127.0.0.1",
            "control_port": params.hub_control_port,
            "hmac_secret": HMAC_SECRET,
            "reconnect_interval": 5000,
            "heartbeat_interval": 30000,
        },
        "server": {
            "capacity": 1000,
            "max_bandwidth": 558000,
        },
        "log_level": if params.verbose { "debug" } else { "error" },
    })
}

struct EdgeParams<'a> {
    server_id: u32,
    name: &'a str,
    port: u16,
    edge_port: u16,
    hub_control_port: u16,
    verbose: bool,
}

// ── TestEnvironment ───────────────────────────────────────────────────────

/// Ports exposed by the test environment for a single Edge.
#[derive(Debug, Clone, Copy)]
pub struct EdgePorts {
    /// Mumble client TLS port.
    pub client_port: u16,
    /// Edge-to-Edge relay TLS port.
    pub edge_port: u16,
    /// UDP voice port (same as client_port for the Rust Edge).
    pub udp_port: u16,
}

/// A running Hub + Edge(s) test environment.
pub struct TestEnvironment {
    pub auth_port: u16,
    pub control_port: u16,
    pub web_api_port: u16,
    pub edges: Vec<EdgePorts>,
    // Processes (kept alive as long as `TestEnvironment` lives)
    _auth_handle: tokio::task::JoinHandle<()>,
    _hub: ServerProcess,
    _edges: Vec<ServerProcess>,
    _temp_dir: tempfile::TempDir,
}

impl TestEnvironment {
    /// Mumble client port for Edge `index` (1-based).
    pub fn edge_port(&self, index: usize) -> u16 {
        self.edges[index - 1].client_port
    }

    pub fn edge1(&self) -> u16 { self.edge_port(1) }
    pub fn edge2(&self) -> u16 { self.edge_port(2) }
    pub fn edge3(&self) -> u16 { self.edge_port(3) }
    pub fn edge4(&self) -> u16 { self.edge_port(4) }
}

// ── Builder ───────────────────────────────────────────────────────────────

/// Builder for `TestEnvironment`.
pub struct TestEnvBuilder {
    edge_count: usize,
    verbose: bool,
    port_base: u16,
}

impl TestEnvBuilder {
    pub fn new() -> Self {
        Self { edge_count: 2, verbose: false, port_base: 19000 }
    }

    pub fn edges(mut self, n: usize) -> Self {
        self.edge_count = n;
        self
    }

    pub fn port_base(mut self, base: u16) -> Self {
        self.port_base = base;
        self
    }

    pub fn verbose(mut self, v: bool) -> Self {
        self.verbose = v;
        self
    }

    /// Start everything and return the environment.
    pub async fn start(self) -> Result<TestEnvironment> {
        ensure_crypto_provider();
        let verbose = self.verbose || std::env::var("MUNODE_TEST_LOG").is_ok();
        let tmp = tempfile::TempDir::new()?;
        let tmp_path = tmp.path().to_path_buf();

        let mut port = find_free_port(self.port_base)?;
        macro_rules! next_port {
            () => {{
                let p = port;
                port = find_free_port(port + 1)?;
                p
            }};
        }

        // ── Auth server ────────────────────────────────────────────────
        let auth_port = next_port!();
        let (_auth_addr, auth_handle) = start_auth_server(auth_port).await?;
        // Give axum a moment to start
        tokio::time::sleep(Duration::from_millis(50)).await;

        // ── Hub ────────────────────────────────────────────────────────
        let hub_control_port = next_port!();
        let hub_web_api_port = next_port!();

        let db_path = tmp_path.join("hub.db");
        seed_database(&db_path)?;

        let blob_store = tmp_path.join("blobs");
        fs::create_dir_all(&blob_store)?;

        let hub_cfg = generate_hub_config(&HubParams {
            control_port: hub_control_port,
            web_api_port: hub_web_api_port,
            auth_port,
            db_path: &db_path.display().to_string(),
            blob_store_path: &blob_store.display().to_string(),
            verbose,
        });
        let hub_cfg_path = tmp_path.join("hub.json");
        fs::write(&hub_cfg_path, serde_json::to_string_pretty(&hub_cfg)?)?;

        let hub_bin = find_binary("munode-hub")?;
        let hub_proc = Command::new(&hub_bin)
            .arg(&hub_cfg_path)
            .stdout(if verbose { Stdio::inherit() } else { Stdio::null() })
            .stderr(if verbose { Stdio::inherit() } else { Stdio::null() })
            .spawn()
            .with_context(|| format!("spawn {}", hub_bin.display()))?;
        let hub = ServerProcess::new(hub_proc, format!("Hub({})", hub_control_port));

        // Wait for Hub to accept connections on its control port
        wait_for_port(hub_control_port, Duration::from_secs(15))
            .context("Hub control port not ready")?;
        // Give Hub a moment to finish initialization
        tokio::time::sleep(Duration::from_millis(200)).await;

        // ── Edges ──────────────────────────────────────────────────────
        let mut edge_ports = Vec::new();
        let mut edge_processes = Vec::new();

        for i in 0..self.edge_count {
            let client_port = next_port!();
            let edge_edge_port = next_port!();

            let edge_cfg = generate_edge_config(&EdgeParams {
                server_id: (i + 1) as u32,
                name: &format!("Edge{}", i + 1),
                port: client_port,
                edge_port: edge_edge_port,
                hub_control_port,
                verbose,
            });
            let edge_cfg_path = tmp_path.join(format!("edge{}.json", i + 1));
            fs::write(&edge_cfg_path, serde_json::to_string_pretty(&edge_cfg)?)?;

            let edge_bin = find_binary("munode-edge")?;
            let edge_proc = Command::new(&edge_bin)
                .arg(&edge_cfg_path)
                .stdout(if verbose { Stdio::inherit() } else { Stdio::null() })
                .stderr(if verbose { Stdio::inherit() } else { Stdio::null() })
                .spawn()
                .with_context(|| format!("spawn {}", edge_bin.display()))?;
            edge_processes.push(ServerProcess::new(
                edge_proc,
                format!("Edge{}({})", i + 1, client_port),
            ));

            wait_for_port(client_port, Duration::from_secs(15))
                .with_context(|| format!("Edge{} not ready on port {}", i + 1, client_port))?;

            edge_ports.push(EdgePorts {
                client_port,
                edge_port: edge_edge_port,
                udp_port: client_port,
            });
        }

        // Wait for edges to register with the Hub
        tokio::time::sleep(Duration::from_millis(500)).await;

        Ok(TestEnvironment {
            auth_port,
            control_port: hub_control_port,
            web_api_port: hub_web_api_port,
            edges: edge_ports,
            _auth_handle: auth_handle,
            _hub: hub,
            _edges: edge_processes,
            _temp_dir: tmp,
        })
    }
}

impl Default for TestEnvBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ── Client helpers ────────────────────────────────────────────────────────

/// Configuration for `create_clients`.
pub struct ClientConfig<'a> {
    pub username: &'a str,
    /// 1-based Edge index.
    pub edge: usize,
    pub channel_id: Option<u32>,
    pub use_udp_voice: bool,
}

impl<'a> ClientConfig<'a> {
    pub fn new(username: &'a str, edge: usize) -> Self {
        Self { username, edge, channel_id: None, use_udp_voice: false }
    }

    pub fn with_channel(mut self, channel_id: u32) -> Self {
        self.channel_id = Some(channel_id);
        self
    }
}

/// Create and authenticate multiple test clients.
pub async fn create_clients(
    env: &TestEnvironment,
    configs: &[ClientConfig<'_>],
) -> Result<Vec<MumbleClient>> {
    let mut clients = Vec::new();
    for cfg in configs {
        let user = find_user(cfg.username)
            .ok_or_else(|| anyhow!("unknown test user: {}", cfg.username))?;
        let port = env.edge_port(cfg.edge);

        let client = MumbleClient::new();
        client
            .connect(ConnectOptions {
                host: "127.0.0.1".into(),
                port,
                username: cfg.username.to_string(),
                password: Some(user.password.to_string()),
                reject_unauthorized: false,
                force_tcp_voice: !cfg.use_udp_voice,
                connect_timeout: Duration::from_secs(10),
                ..Default::default()
            })
            .await
            .with_context(|| format!("connect {} to edge {}", cfg.username, cfg.edge))?;

        if cfg.use_udp_voice {
            client.wait_for_udp(Duration::from_secs(8)).await?;
        }

        if let Some(channel_id) = cfg.channel_id {
            client.join_channel(channel_id).await?;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        clients.push(client);
        // Small delay between connections
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(clients)
}

/// Disconnect all clients (best-effort).
pub async fn cleanup_clients(clients: Vec<MumbleClient>) {
    for c in clients {
        let _ = c.disconnect().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
}

/// Short sleep helper.
pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Generate random fake voice data for testing.
pub fn random_voice_data(size: usize) -> Vec<u8> {
    (0..size).map(|i| (i % 256) as u8).collect()
}

// ── One-shot environment factory ──────────────────────────────────────────

/// Start a standard 2-Edge test environment.
pub async fn standard_env() -> Result<TestEnvironment> {
    TestEnvBuilder::new().edges(2).start().await
}

/// Start a 1-Edge test environment.
pub async fn single_edge_env() -> Result<TestEnvironment> {
    TestEnvBuilder::new().edges(1).start().await
}

/// Start a 4-Edge test environment.
pub async fn four_edge_env() -> Result<TestEnvironment> {
    TestEnvBuilder::new().edges(4).start().await
}

// ── Quick connect ─────────────────────────────────────────────────────────

/// Connect a single named user to Edge 1 of `env`.
pub async fn connect(env: &TestEnvironment, username: &str) -> Result<MumbleClient> {
    let clients = create_clients(env, &[ClientConfig::new(username, 1)]).await?;
    Ok(clients.into_iter().next().unwrap())
}
