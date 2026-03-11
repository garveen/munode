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
