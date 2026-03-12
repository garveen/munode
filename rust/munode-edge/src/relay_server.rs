//! Peer Edge Control Relay — transparent WebSocket relay server.
//!
//! Every Edge starts a lightweight TCP/WebSocket relay listener (always-on, no opt-in flag).
//! Peer Edges that cannot reach Hub directly connect to this relay port and have their
//! traffic forwarded transparently.
//!
//! For each incoming client WebSocket, the relay opens **one new WebSocket
//! connection to the Hub** and relays all binary frames bidirectionally.
//! The relay does not parse or interpret any messages — it is purely transparent.
//!
//! ```text
//!   Edge A (cannot reach Hub)
//!        │ ws://edge-b-host:relay_port/
//!        ▼
//!   Edge B (relay server)  ───ws://hub-host:hub-port/──►  Hub
//!        ▲                                                    │
//!        └────────────────── relay ──────────────────────────┘
//! ```
//!
//! Limitations:
//! - Single-hop only: Edge B does **not** accept further relay chains.
//! - Plain WebSocket (no TLS): The relay listener does not use TLS.
//!   This is acceptable for in-cluster connections on a trusted network.

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tracing::{debug, error, info, warn};

type WsMessage = tokio_tungstenite::tungstenite::Message;
type WsError = tokio_tungstenite::tungstenite::Error;

/// Start the control-relay WebSocket server.
///
/// Binds to `0.0.0.0:relay_port` and for every incoming WebSocket connection
/// opens a new WebSocket to the Hub (`ws://hub_host:hub_port/`) and relays
/// frames bidirectionally until either side closes.
///
/// This function never returns under normal operation.
pub async fn run_relay_server(relay_port: u16, hub_host: String, hub_port: u16) {
    let bind_addr = format!("0.0.0.0:{}", relay_port);
    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => {
            info!("Control relay server listening on {}", bind_addr);
            l
        }
        Err(e) => {
            error!("Failed to bind control relay server on {}: {}", bind_addr, e);
            return;
        }
    };

    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let hub_host = hub_host.clone();
                let hub_port = hub_port;
                info!("Control relay: incoming connection from {}", peer_addr);
                tokio::spawn(async move {
                    if let Err(e) = handle_proxy_connection(stream, peer_addr, hub_host, hub_port).await {
                        debug!("Control relay connection from {} ended: {}", peer_addr, e);
                    }
                });
            }
            Err(e) => {
                warn!("Control relay accept error: {}", e);
            }
        }
    }
}

/// Handle a single proxy connection: upgrade to WebSocket, connect to Hub,
/// then relay frames bidirectionally until either side closes.
async fn handle_proxy_connection(
    stream: tokio::net::TcpStream,
    peer_addr: std::net::SocketAddr,
    hub_host: String,
    hub_port: u16,
) -> Result<()> {
    // Upgrade incoming TCP connection to WebSocket (server role)
    let client_ws = tokio_tungstenite::accept_async(stream).await?;
    debug!("Control relay: WebSocket handshake complete with {}", peer_addr);

    // Connect to Hub as a WebSocket client
    let hub_url = format!("ws://{}:{}", hub_host, hub_port);
    let (hub_ws, _) = tokio_tungstenite::connect_async(&hub_url).await?;
    debug!("Control relay: connected to Hub at {} for peer {}", hub_url, peer_addr);

    let (client_write, client_read) = client_ws.split();
    let (hub_write, hub_read) = hub_ws.split();

    // Relay in both directions concurrently; stop when either side closes
    tokio::select! {
        r = relay_frames(client_read, hub_write, "client→hub") => {
            debug!("Peer proxy relay client→hub ended for {}: {:?}", peer_addr, r);
        }
        r = relay_frames(hub_read, client_write, "hub→client") => {
            debug!("Peer proxy relay hub→client ended for {}: {:?}", peer_addr, r);
        }
    }

    info!("Control relay connection from {} closed", peer_addr);
    Ok(())
}

/// Relay WebSocket frames from `src` to `dst`.
///
/// Only binary and text frames are forwarded; ping/pong/close frames are
/// handled transparently by tungstenite.
async fn relay_frames<R, W>(
    mut src: R,
    mut dst: W,
    label: &'static str,
) -> Result<()>
where
    R: StreamExt<Item = Result<WsMessage, WsError>> + Unpin,
    W: SinkExt<WsMessage, Error = WsError> + Unpin,
{
    while let Some(msg) = src.next().await {
        match msg {
            Ok(WsMessage::Binary(data)) => {
                dst.send(WsMessage::Binary(data)).await?;
            }
            Ok(WsMessage::Text(text)) => {
                dst.send(WsMessage::Text(text)).await?;
            }
            Ok(WsMessage::Close(frame)) => {
                debug!("Relay {}: received Close frame, forwarding and stopping", label);
                let _ = dst.send(WsMessage::Close(frame)).await;
                break;
            }
            Ok(WsMessage::Ping(data)) => {
                dst.send(WsMessage::Pong(data)).await?;
            }
            Ok(WsMessage::Pong(_)) => {
                // Ignore pong responses
            }
            Ok(_) => {}
            Err(e) => {
                return Err(anyhow::anyhow!("relay {}: read error: {}", label, e));
            }
        }
    }
    Ok(())
}
