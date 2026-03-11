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
