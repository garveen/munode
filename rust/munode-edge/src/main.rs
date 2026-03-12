use anyhow::Result;
use tracing::info;

use munode_common::config::load_edge_config;
use munode_common::logging::init_logging_with_format;
use munode_edge::server::EdgeServer;

#[tokio::main]
async fn main() -> Result<()> {
    // Explicitly install the aws-lc-rs crypto provider so that rustls does not
    // panic when multiple providers (ring + aws-lc-rs) are present in the
    // dependency graph (e.g. pulled in transitively by tokio-tungstenite).
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls aws-lc-rs crypto provider");

    let args: Vec<String> = std::env::args().collect();

    // Subcommand: `validate-config [path]`
    if args.get(1).map(|s| s.as_str()) == Some("validate-config") {
        let config_path = args.get(2)
            .map(|s| s.as_str())
            .unwrap_or("config/edge.toml");
        match load_edge_config(config_path) {
            Ok(cfg) => {
                println!("✅ Edge config '{}' is valid.", config_path);
                println!("   {:<14} {}", "server_id:", cfg.server_id);
                println!("   {:<14} {}", "name:", cfg.name);
                println!("   {:<14} {}", "port:", cfg.network.port);
                println!("   {:<14} {}:{}", "hub:", cfg.hub_server.host, cfg.hub_server.control_port);
                println!("   {:<14} {}", "log_level:", cfg.log_level);
            }
            Err(e) => {
                eprintln!("❌ Edge config '{}' is invalid: {}", config_path, e);
                std::process::exit(1);
            }
        }
        return Ok(());
    }

    // Subcommand: `diagnose [path]`
    if args.get(1).map(|s| s.as_str()) == Some("diagnose") {
        let config_path = args.get(2)
            .map(|s| s.as_str())
            .unwrap_or("config/edge.toml");

        println!("🔍 MuNode Edge Diagnostics");
        println!("   Config: {}", config_path);

        let cfg = match load_edge_config(config_path) {
            Ok(c) => {
                println!("✅ Config parse: OK");
                c
            }
            Err(e) => {
                println!("❌ Config parse: FAILED — {}", e);
                std::process::exit(1);
            }
        };

        // Check TLS certificate file
        if std::path::Path::new(&cfg.tls.cert).exists() {
            println!("✅ TLS cert: found ({})", cfg.tls.cert);
        } else {
            println!("❌ TLS cert: NOT FOUND ({})", cfg.tls.cert);
        }

        // Check TLS private key file
        if std::path::Path::new(&cfg.tls.key).exists() {
            println!("✅ TLS key: found ({})", cfg.tls.key);
        } else {
            println!("❌ TLS key: NOT FOUND ({})", cfg.tls.key);
        }

        // Check CA cert file if provided
        if let Some(ca) = &cfg.tls.ca {
            if std::path::Path::new(ca).exists() {
                println!("✅ TLS CA cert: found ({})", ca);
            } else {
                println!("❌ TLS CA cert: NOT FOUND ({})", ca);
            }
        }

        // Attempt TCP connection to Hub
        let hub_addr = format!("{}:{}", cfg.hub_server.host, cfg.hub_server.control_port);
        print!("🔌 Hub TCP reachability ({}): ", hub_addr);
        use std::time::Duration;
        match tokio::time::timeout(
            Duration::from_secs(3),
            tokio::net::TcpStream::connect(&hub_addr),
        )
        .await
        {
            Ok(Ok(_)) => println!("✅ reachable"),
            Ok(Err(e)) => println!("❌ connection refused — {}", e),
            Err(_) => println!("❌ timed out after 3 s"),
        }

        // Print config summary
        println!();
        println!("📋 Configuration Summary:");
        println!("   {:<22} {}", "server_id:", cfg.server_id);
        println!("   {:<22} {}", "name:", cfg.name);
        println!("   {:<22} {}", "port:", cfg.network.port);
        println!("   {:<22} {}", "edge_port:", cfg.network.edge_port.map(|p| p.to_string()).unwrap_or_else(|| "auto".to_string()));
        println!("   {:<22} {}", "external_host:", cfg.network.external_host);
        println!("   {:<22} {}:{}", "hub:", cfg.hub_server.host, cfg.hub_server.control_port);
        println!("   {:<22} {}", "pool_size:", cfg.hub_server.pool_size);
        println!("   {:<22} {}", "capacity:", cfg.server.capacity);
        let strategy = match cfg.voice_routing.connection_strategy {
            munode_common::config::VoiceConnectionStrategy::AutoFallback => "auto_fallback",
            munode_common::config::VoiceConnectionStrategy::TcpOnly => "tcp_only",
            munode_common::config::VoiceConnectionStrategy::DirectOnly => "direct_only",
        };
        println!("   {:<22} {}", "connection_strategy:", strategy);
        if cfg.hub_server.allow_peer_proxy {
            let edge_port = cfg.network.edge_port.unwrap_or(cfg.network.port + 1);
            let proxy_port = if cfg.hub_server.proxy_ws_port > 0 {
                cfg.hub_server.proxy_ws_port
            } else {
                edge_port + 2
            };
            println!("   {:<22} {} (port {})", "peer_proxy:", "enabled", proxy_port);
        } else {
            println!("   {:<22} disabled", "peer_proxy:");
        }
        println!("   {:<22} {}", "log_level:", cfg.log_level);
        println!("   {:<22} {}", "log_format:", cfg.log_format);

        return Ok(());
    }

    let config_path = args.get(1)
        .map(|s| s.as_str())
        .unwrap_or("config/edge.toml")
        .to_string();

    let config = load_edge_config(&config_path)?;
    init_logging_with_format(&config.log_level, &config.log_format);

    info!(
        server_id = config.server_id,
        name = %config.name,
        port = config.network.port,
        "Starting MuNode Edge Server (Rust)"
    );

    let server = EdgeServer::new(config);
    server.run().await?;

    Ok(())
}
