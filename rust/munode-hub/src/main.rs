use anyhow::Result;
use tracing::info;

use munode_common::config::load_hub_config;
use munode_common::logging::init_logging;
use munode_hub::server::HubServer;

#[tokio::main]
async fn main() -> Result<()> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config/hub.toml".to_string());

    let config = load_hub_config(&config_path)?;
    init_logging(&config.log_level);

    info!(
        control_port = config.network.control_port,
        db_path = %config.database.path,
        "Starting MuNode Hub Server (Rust)"
    );

    let server = HubServer::new(config);
    server.run().await?;

    Ok(())
}
