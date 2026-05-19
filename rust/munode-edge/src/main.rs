use anyhow::Result;
use tracing::info;

use munode_common::config::load_edge_config;
use munode_common::logging::init_logging_with_reload;
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
        let config_path = args
            .get(2)
            .map(|s| s.as_str())
            .unwrap_or("config/edge.toml");
        match load_edge_config(config_path) {
            Ok(cfg) => {
                println!("✅ Edge config '{}' is valid.", config_path);
                println!("   {:<14} {}", "server_id:", cfg.server_id);
                println!("   {:<14} {}", "name:", cfg.name);
                println!("   {:<14} {}", "port:", cfg.network.port);
                println!(
                    "   {:<14} {}:{}",
                    "hub:", cfg.hub_server.host, cfg.hub_server.control_port
                );
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
        let config_path = args
            .get(2)
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
        println!(
            "   {:<22} {}",
            "edge_port:",
            cfg.network
                .edge_port
                .map(|p| p.to_string())
                .unwrap_or_else(|| "auto".to_string())
        );
        println!("   {:<22} {}", "external_host:", cfg.network.external_host);
        println!(
            "   {:<22} {}:{}",
            "hub:", cfg.hub_server.host, cfg.hub_server.control_port
        );
        println!("   {:<22} {}", "pool_size:", cfg.hub_server.pool_size);
        println!("   {:<22} {}", "capacity:", cfg.server.capacity);
        println!(
            "   {:<22} {}",
            "hub_tcp_fallback:", cfg.voice_routing.enable_hub_tcp_fallback
        );
        println!(
            "   {:<22} {}",
            "failure_threshold:", cfg.voice_routing.consecutive_failure_threshold
        );
        // The combined relay/voice WebSocket server always listens on edge_port.
        let edge_port = cfg.network.edge_port.unwrap_or(cfg.network.port + 1);
        println!(
            "   {:<22} {} (port {})",
            "control_relay:", "enabled", edge_port
        );
        if !cfg.hub_server.static_peers.is_empty() {
            let peers: Vec<String> = cfg
                .hub_server
                .static_peers
                .iter()
                .map(|p| format!("{}:{}", p.host, p.relay_port))
                .collect();
            println!("   {:<22} {}", "static_peers:", peers.join(", "));
        }
        println!("   {:<22} {}", "log_level:", cfg.log_level);
        println!("   {:<22} {}", "log_format:", cfg.log_format);

        return Ok(());
    }

    // Subcommand: `generate-config [path]`
    //   Write a default Edge TOML configuration file.
    if args.get(1).map(|s| s.as_str()) == Some("generate-config") {
        let output_path = args.get(2).map(|s| s.as_str()).unwrap_or("edge.toml");

        if std::path::Path::new(output_path).exists() {
            eprintln!(
                "❌ File already exists: {}. Use a different path or remove the existing file.",
                output_path
            );
            std::process::exit(1);
        }

        std::fs::write(output_path, DEFAULT_EDGE_CONFIG).unwrap_or_else(|e| {
            eprintln!("❌ Cannot write config to '{}': {}", output_path, e);
            std::process::exit(1);
        });

        println!("✅ Default Edge config written to '{}'", output_path);
        println!("   Edit the file and update:");
        println!("   - server_id             (unique integer for each edge)");
        println!("   - network.external_host (public hostname/IP for this edge)");
        println!("   - tls.cert / tls.key    (TLS certificate and private key paths)");
        println!("   - hub_server.host       (Hub server hostname)");
        println!("   - hub_server.hmac_secret (must match Hub registry.hmac_secret)");
        println!(
            "   Run 'munode-edge validate-config {}' to verify.",
            output_path
        );
        return Ok(());
    }

    let config_path = args
        .get(1)
        .map(|s| s.as_str())
        .unwrap_or("config/edge.toml")
        .to_string();

    let config = load_edge_config(&config_path)?;
    let log_reload = init_logging_with_reload(&config.log_level, &config.log_format);

    info!(
        server_id = config.server_id,
        name = %config.name,
        port = config.network.port,
        "Starting MuNode Edge Server (Rust)"
    );

    let server = EdgeServer::new_with_path(config, config_path, log_reload);
    server.run().await?;

    Ok(())
}

/// Default Edge TOML configuration template written by `generate-config`.
const DEFAULT_EDGE_CONFIG: &str = r#"# MuNode Edge Server – default configuration
# Generated by: munode-edge generate-config
# Edit this file and update server_id, TLS paths, and Hub connection settings.

server_id  = 1
name       = "MuNode Edge #1"
log_level  = "info"   # trace | debug | info | warn | error
log_format = "text"   # text | json

[network]
host          = "0.0.0.0"
port          = 64738
edge_port     = 64739
external_host = "127.0.0.1"

[tls]
cert = "certs/edge-cert.pem"
key  = "certs/edge-key.pem"
# ca = "certs/ca-chain.pem"

[hub_server]
host               = "127.0.0.1"
control_port       = 8443
reconnect_interval = 5000
heartbeat_interval = 30000
hmac_secret        = "change-me-to-match-hub-secret"
pool_size          = 1

[server]
capacity        = 1000
default_channel = 0
# welcome_text  = "Welcome!"

text_message_length   = 5000
image_message_length  = 131072
plugin_message_length = 1024
message_rate          = 10.0
message_burst         = 5

listeners_per_user    = 0
listeners_per_channel = 0

[voice_routing]
enabled                       = true
enable_hub_tcp_fallback       = true
consecutive_failure_threshold = 2

[voice_routing.quality]
probe_interval_secs           = 1
report_interval_secs          = 5
probe_timeout_secs            = 3
sample_window_size            = 30

[voice_routing.relay]
enabled             = true
"#;
