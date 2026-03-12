use anyhow::Result;
use tracing::info;

use munode_common::config::load_hub_config;
use munode_common::logging::init_logging_with_format;
use munode_hub::server::HubServer;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    // Subcommand: `validate-config [path]`
    if args.get(1).map(|s| s.as_str()) == Some("validate-config") {
        let config_path = args.get(2)
            .map(|s| s.as_str())
            .unwrap_or("config/hub.toml");
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
    if args.get(1).map(|s| s.as_str()) == Some("diagnose") {
        let config_path = args.get(2)
            .map(|s| s.as_str())
            .unwrap_or("config/hub.toml");

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
                println!("⚠️  Database file: not found (will be created on start) ({})", cfg.database.path);
            }
        } else {
            println!("❌ Database directory: does not exist ({})",
                db_path.parent().unwrap().display());
        }

        // Check blob store path
        let blob_path = std::path::Path::new(&cfg.blob_store.path);
        if blob_path.exists() {
            println!("✅ Blob store directory: exists ({})", cfg.blob_store.path);
        } else {
            println!("⚠️  Blob store directory: not found (will be created on start) ({})", cfg.blob_store.path);
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
            println!("   {:<22} {}:{}", "web_api:", cfg.web_api.host, cfg.web_api.port);
        } else {
            println!("   {:<22} disabled", "web_api:");
        }
        println!("   {:<22} {}", "log_level:", cfg.log_level);
        println!("   {:<22} {}", "log_format:", cfg.log_format);

        return Ok(());
    }

    let config_path = args.get(1)
        .map(|s| s.as_str())
        .unwrap_or("config/hub.toml")
        .to_string();

    let config = load_hub_config(&config_path)?;
    init_logging_with_format(&config.log_level, &config.log_format);

    info!(
        control_port = config.network.control_port,
        db_path = %config.database.path,
        "Starting MuNode Hub Server (Rust)"
    );

    let server = HubServer::new(config);
    server.run().await?;

    Ok(())
}
