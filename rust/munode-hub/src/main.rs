use anyhow::Result;
use tracing::info;

use munode_common::config::load_hub_config;
use munode_common::logging::init_logging_with_reload;
use munode_hub::database::Database;
use munode_hub::server::HubServer;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let subcmd = args.get(1).map(|s| s.as_str());

    // Subcommand: `validate-config [path]`
    if subcmd == Some("validate-config") {
        let config_path = args.get(2).map(|s| s.as_str()).unwrap_or("config/hub.toml");
        match load_hub_config(config_path) {
            Ok(cfg) => {
                println!("✅ Hub config '{}' is valid.", config_path);
                println!("   {:<14} {}", "control_port:", cfg.network.control_port);
                println!("   {:<14} {}", "db_path:", cfg.database.path);
                println!("   {:<14} {}", "log_level:", cfg.log_level);
            }
            Err(e) => {
                eprintln!("❌ Hub config '{}' is invalid: {}", config_path, e);
                std::process::exit(1);
            }
        }
        return Ok(());
    }

    // Subcommand: `diagnose [path]`
    if subcmd == Some("diagnose") {
        let config_path = args.get(2).map(|s| s.as_str()).unwrap_or("config/hub.toml");

        println!("🔍 MuNode Hub Diagnostics");
        println!("   Config: {}", config_path);

        let cfg = match load_hub_config(config_path) {
            Ok(c) => {
                println!("✅ Config parse: OK");
                c
            }
            Err(e) => {
                println!("❌ Config parse: FAILED — {}", e);
                std::process::exit(1);
            }
        };

        // Check database path (directory must exist or be creatable)
        let db_path = std::path::Path::new(&cfg.database.path);
        let db_dir_ok = db_path
            .parent()
            .map(|p| p.as_os_str().is_empty() || p.exists())
            .unwrap_or(true);
        if db_dir_ok {
            if db_path.exists() {
                println!("✅ Database file: exists ({})", cfg.database.path);
            } else {
                println!(
                    "⚠️  Database file: not found (will be created on start) ({})",
                    cfg.database.path
                );
            }
        } else {
            println!(
                "❌ Database directory: does not exist ({})",
                db_path
                    .parent()
                    .unwrap_or(std::path::Path::new("/"))
                    .display()
            );
        }

        // Check blob store path
        let blob_path = std::path::Path::new(&cfg.blob_store.path);
        if blob_path.exists() {
            println!("✅ Blob store directory: exists ({})", cfg.blob_store.path);
        } else {
            println!(
                "⚠️  Blob store directory: not found (will be created on start) ({})",
                cfg.blob_store.path
            );
        }

        // Check Lua auth script if configured
        if let Some(lua_script) = &cfg.auth.lua_script {
            if std::path::Path::new(lua_script).exists() {
                println!("✅ Lua auth script: found ({})", lua_script);
            } else {
                println!("❌ Lua auth script: NOT FOUND ({})", lua_script);
            }
        }

        // Check GeoIP database if configured
        if !cfg.geoip.database_path.is_empty() {
            if std::path::Path::new(&cfg.geoip.database_path).exists() {
                println!("✅ GeoIP database: found ({})", cfg.geoip.database_path);
            } else {
                println!("❌ GeoIP database: NOT FOUND ({})", cfg.geoip.database_path);
            }
        }

        // Print config summary
        println!();
        println!("📋 Configuration Summary:");
        println!("   {:<22} {}", "control_port:", cfg.network.control_port);
        println!("   {:<22} {}", "db_path:", cfg.database.path);
        println!("   {:<22} {}", "allow_guest:", cfg.auth.allow_guest);
        println!("   {:<22} {}", "max_users:", cfg.limits.max_users);
        println!("   {:<22} {}", "auto_ban_enabled:", cfg.auto_ban.enabled);
        if cfg.web_api.enabled {
            println!(
                "   {:<22} {}:{}",
                "web_api:", cfg.web_api.host, cfg.web_api.port
            );
        } else {
            println!("   {:<22} disabled", "web_api:");
        }
        println!("   {:<22} {}", "log_level:", cfg.log_level);
        println!("   {:<22} {}", "log_format:", cfg.log_format);

        return Ok(());
    }

    // Subcommand: `migrate [config]`
    //   Show and apply pending database schema migrations.
    if subcmd == Some("migrate") {
        let config_path = args.get(2).map(|s| s.as_str()).unwrap_or("config/hub.toml");
        let cfg = load_hub_config(config_path).unwrap_or_else(|e| {
            eprintln!("❌ Config error: {}", e);
            std::process::exit(1);
        });

        println!("🗄  MuNode Hub Database Migration");
        println!("   Config:   {}", config_path);
        println!("   Database: {}", cfg.database.path);

        let db = Database::open(&cfg.database.path).unwrap_or_else(|e| {
            eprintln!("❌ Cannot open database: {}", e);
            std::process::exit(1);
        });

        let current = db.schema_version().unwrap_or(0);
        println!("   Current schema version: {}", current);

        // Show applied migrations
        if let Ok(applied) = db.list_migrations() {
            if applied.is_empty() {
                println!("   No migrations recorded yet.");
            } else {
                println!("\n📋 Applied migrations:");
                for (v, desc, ts) in &applied {
                    println!("   v{:<4} {} (applied {})", v, desc, ts);
                }
            }
        }

        // Apply pending migrations
        println!("\n🔄 Applying pending migrations…");
        match db.apply_migrations() {
            Ok(applied) if applied.is_empty() => {
                println!("✅ Database is up to date (version {}).", current);
            }
            Ok(applied) => {
                for (v, desc) in &applied {
                    println!("  ✅ v{}: {}", v, desc);
                }
                println!(
                    "\n✅ Applied {} migration(s). Database is now at version {}.",
                    applied.len(),
                    db.schema_version().unwrap_or(current)
                );
            }
            Err(e) => {
                eprintln!("❌ Migration failed: {}", e);
                std::process::exit(1);
            }
        }
        return Ok(());
    }

    // Subcommand: `backup <config> <destination>`
    //   Back up the database (and optionally blobs) to a destination directory.
    if subcmd == Some("backup") {
        let config_path = args.get(2).map(|s| s.as_str()).unwrap_or("config/hub.toml");
        let dest = args.get(3).map(|s| s.as_str()).unwrap_or("backup");

        let cfg = load_hub_config(config_path).unwrap_or_else(|e| {
            eprintln!("❌ Config error: {}", e);
            std::process::exit(1);
        });

        println!("📦 MuNode Hub Backup");
        println!("   Source config: {}", config_path);
        println!("   Database:      {}", cfg.database.path);
        println!("   Blob store:    {}", cfg.blob_store.path);
        println!("   Destination:   {}", dest);

        // Create destination directory
        std::fs::create_dir_all(dest).unwrap_or_else(|e| {
            eprintln!("❌ Cannot create destination '{}': {}", dest, e);
            std::process::exit(1);
        });

        // Backup database
        if std::path::Path::new(&cfg.database.path).exists() {
            let db = Database::open(&cfg.database.path).unwrap_or_else(|e| {
                eprintln!("❌ Cannot open database: {}", e);
                std::process::exit(1);
            });
            let db_dest = format!("{}/munode.db", dest);
            db.backup_to(&db_dest).unwrap_or_else(|e| {
                eprintln!("❌ Database backup failed: {}", e);
                std::process::exit(1);
            });
            println!("✅ Database backed up → {}", db_dest);
        } else {
            println!(
                "⚠️  Database file not found, skipping: {}",
                cfg.database.path
            );
        }

        // Backup blobs directory (recursive copy)
        let blob_src = std::path::Path::new(&cfg.blob_store.path);
        if blob_src.exists() {
            let blob_dest = format!("{}/blobs", dest);
            copy_dir_recursive(blob_src, std::path::Path::new(&blob_dest)).unwrap_or_else(|e| {
                eprintln!("❌ Blob backup failed: {}", e);
                std::process::exit(1);
            });
            println!("✅ Blobs backed up → {}", blob_dest);
        } else {
            println!(
                "⚠️  Blob store directory not found, skipping: {}",
                cfg.blob_store.path
            );
        }

        // Write manifest
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let manifest = format!(
            "{{\n  \"created_at\": {},\n  \"db_path\": \"{}\",\n  \"blob_path\": \"{}\",\n  \"version\": \"1\"\n}}\n",
            now_secs, cfg.database.path, cfg.blob_store.path
        );
        std::fs::write(format!("{}/manifest.json", dest), &manifest).unwrap_or_else(|e| {
            eprintln!("⚠️  Could not write manifest: {}", e);
        });
        println!("✅ Manifest written → {}/manifest.json", dest);
        println!("\n✅ Backup complete.");
        return Ok(());
    }

    // Subcommand: `generate-config [path]`
    //   Write a default Hub TOML configuration file.
    if subcmd == Some("generate-config") {
        let output_path = args.get(2).map(|s| s.as_str()).unwrap_or("hub.toml");

        if std::path::Path::new(output_path).exists() {
            eprintln!(
                "❌ File already exists: {}. Use a different path or remove the existing file.",
                output_path
            );
            std::process::exit(1);
        }

        std::fs::write(output_path, DEFAULT_HUB_CONFIG).unwrap_or_else(|e| {
            eprintln!("❌ Cannot write config to '{}': {}", output_path, e);
            std::process::exit(1);
        });

        println!("✅ Default Hub config written to '{}'", output_path);
        println!("   Edit the file and update:");
        println!("   - registry.hmac_secret  (must match Edge hmac_secret)");
        println!("   - auth section          (configure your authentication method)");
        println!("   - database.path         (path to SQLite database file)");
        println!(
            "   Run 'munode-hub validate-config {}' to verify.",
            output_path
        );
        return Ok(());
    }

    // Subcommand: `admin <config> <command> [args...]`
    //   CLI administration tools.
    if subcmd == Some("admin") {
        let config_path = args.get(2).map(|s| s.as_str()).unwrap_or("config/hub.toml");
        let admin_cmd = args.get(3).map(|s| s.as_str()).unwrap_or("help");

        let cfg = load_hub_config(config_path).unwrap_or_else(|e| {
            eprintln!("❌ Config error: {}", e);
            std::process::exit(1);
        });
        let db = Database::open(&cfg.database.path).unwrap_or_else(|e| {
            eprintln!("❌ Cannot open database: {}", e);
            std::process::exit(1);
        });

        match admin_cmd {
            "list-users" => {
                let users = db.list_users().unwrap_or_else(|e| {
                    eprintln!("❌ Error listing users: {}", e);
                    std::process::exit(1);
                });
                println!("{:<6} {:<30} Last Channel", "ID", "Username");
                println!("{}", "-".repeat(50));
                for u in &users {
                    println!("{:<6} {:<30} {}", u.id, u.username, u.last_channel);
                }
                println!("\nTotal: {} user(s)", users.len());
            }
            "list-channels" => {
                let channels = db.load_channels().unwrap_or_else(|e| {
                    eprintln!("❌ Error listing channels: {}", e);
                    std::process::exit(1);
                });
                println!("{:<6} {:<6} {:<30} MaxUsers", "ID", "Parent", "Name");
                println!("{}", "-".repeat(60));
                for c in &channels {
                    let parent = c
                        .parent_id
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "-".to_string());
                    println!("{:<6} {:<6} {:<30} {}", c.id, parent, c.name, c.max_users);
                }
                println!("\nTotal: {} channel(s)", channels.len());
            }
            "list-bans" => {
                let bans = db.load_bans().unwrap_or_else(|e| {
                    eprintln!("❌ Error listing bans: {}", e);
                    std::process::exit(1);
                });
                println!("{:<6} {:<20} {:<30} Reason", "ID", "IP", "Name");
                println!("{}", "-".repeat(80));
                for b in &bans {
                    let ip = format_ip(&b.address);
                    println!("{:<6} {:<20} {:<30} {}", b.id, ip, b.name, b.reason);
                }
                println!("\nTotal: {} ban(s)", bans.len());
            }
            "cleanup-bans" => {
                let removed = db.cleanup_expired_bans().unwrap_or_else(|e| {
                    eprintln!("❌ Error: {}", e);
                    std::process::exit(1);
                });
                println!("✅ Removed {} expired ban(s).", removed);
            }
            "schema-version" => {
                let v = db.schema_version().unwrap_or(0);
                println!("Schema version: {}", v);
            }
            _ => {
                println!("MuNode Hub Admin Tool");
                println!();
                println!("Usage: munode-hub admin <config> <command>");
                println!();
                println!("Commands:");
                println!("  list-users       List all registered users");
                println!("  list-channels    List all channels");
                println!("  list-bans        List all active bans");
                println!("  cleanup-bans     Remove expired bans from database");
                println!("  schema-version   Show current database schema version");
            }
        }
        return Ok(());
    }

    let config_path = args
        .get(1)
        .map(|s| s.as_str())
        .unwrap_or("config/hub.toml")
        .to_string();

    let config = load_hub_config(&config_path)?;
    let log_reload = init_logging_with_reload(&config.log_level, &config.log_format);

    info!(
        control_port = config.network.control_port,
        db_path = %config.database.path,
        "Starting MuNode Hub Server (Rust)"
    );

    // SIGHUP hot-reload is handled inside HubServer::run() where the shared state
    // and rpc_handler are accessible, so the updated limits can be pushed to all
    // connected Edges immediately.
    let server = HubServer::new_with_path(config, config_path, log_reload);
    server.run().await?;

    Ok(())
}

/// Format a 16-byte IPv4-mapped-IPv6 address as a human-readable string.
fn format_ip(bytes: &[u8; 16]) -> String {
    // IPv4-mapped IPv6 addresses: ::ffff:a.b.c.d
    if bytes[0..10] == [0u8; 10] && bytes[10] == 0xff && bytes[11] == 0xff {
        return format!("{}.{}.{}.{}", bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    let words: Vec<String> = bytes
        .chunks(2)
        .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
        .collect();
    words.join(":")
}

/// Default Hub TOML configuration template written by `generate-config`.
const DEFAULT_HUB_CONFIG: &str = r#"# MuNode Hub Server – default configuration
# Generated by: munode-hub generate-config
# Edit this file and update hmac_secret, auth, and database settings.

log_level  = "info"      # trace | debug | info | warn | error
log_format = "text"      # text | json

[network]
host         = "0.0.0.0"
control_port = 8443

[database]
path = "data/hub.sqlite"

[registry]
hmac_secret       = "change-me-to-a-random-secret"
heartbeat_timeout = 90000

[auth]
allow_guest          = true
default_channel      = 0
require_auth_service = false
http_timeout_ms      = 5000
# Uncomment to set a server-wide password:
# server_password = "secret"
# Uncomment to set a welcome message:
# welcome_text = "Welcome!"

# Authentication method – choose one:
# Option A: Lua script (recommended for custom logic)
# lua_script = "./auth.lua"
# Option B: HTTP webhook
# http_url = "https://example.com/auth"
# Option C: local SQLite database (default when nothing else is configured)

[limits]
max_users             = 1000
max_users_per_channel = 0
text_message_length   = 5000
image_message_length  = 131072
plugin_message_length = 1024
message_rate          = 10.0
message_burst         = 5
listeners_per_user    = 0
listeners_per_channel = 0

[auto_ban]
enabled     = false
attempts    = 10
time_window = 120
duration    = 300

[web_api]
enabled = true
host    = "0.0.0.0"
port    = 8080

[blob_store]
path = "data/blobs"

[voice_routing]
enable_relay               = true
max_relay_streams_per_pair = 0
max_total_relay_streams    = 0
relay_cost_factor          = 1.2
direct_rtt_threshold       = 200
direct_loss_threshold      = 0.05

[validation]
# username_regex     = "^[a-zA-Z0-9_]{3,32}$"
# channel_name_regex = "^[^\\x00-\\x1f]{1,64}$"

[channel_ninja]
enabled        = false
ninja_channels = []

[geoip]
database_path = ""
log_location  = true
"#;

/// Recursively copy a directory tree from `src` to `dst`.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}
