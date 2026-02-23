use anyhow::Result;
use tracing::info;

use munode_common::config::load_edge_config;
use munode_common::logging::init_logging;
use munode_edge::server::EdgeServer;

#[tokio::main]
async fn main() -> Result<()> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config/edge.json".to_string());

    let config = load_edge_config(&config_path)?;
    init_logging(&config.log_level);

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
