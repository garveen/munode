//! WebTransport (QUIC / HTTP3) listener for browser-based Mumble clients.
//!
//! Architecture
//! ─────────────
//! Each WebTransport *session* (one browser connection) maps to exactly one Mumble
//! client session.  The session uses:
//!
//! - **One bidirectional QUIC stream** (control stream) — carries all Mumble
//!   `[type:u16][len:u32][payload]` frames, identical to the TCP/TLS path.
//!   Voice frames are tunnelled as `UdpTunnel` (type=1) messages on this stream.
//!
//! The control stream's `RecvStream` is presented to the shared
//! `connection::run_connection_inner` function via `Box<dyn AsyncRead>`.  The
//! `SendStream` is drained by the writer task.
//!
//! Certificate management
//! ──────────────────────
//! If `webtransport.cert` / `webtransport.key` are set, those files are used.
//! Otherwise the Edge's main `tls.cert` / `tls.key` files are used.
//!
//! **Phase-1 note**: The certificate is loaded once at startup.  Hot-reload
//! (rebuilding the QUIC endpoint when the cert file changes) is a Phase-2 feature.
//! The `cert_reload_interval_secs` config field is accepted but currently unused
//! beyond logging a deprecation note.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use wtransport::{Endpoint, Identity, ServerConfig};

use munode_common::config::EdgeConfig;

use crate::client::ClientSender;
use crate::hub_client::HubClient;
use crate::state::EdgeState;
use crate::transport::TransportKind;

/// Run the WebTransport listener.
///
/// Binds to `config.webtransport.host:port`, accepts sessions in a loop,
/// and spawns a tokio task for each session that runs the shared Mumble
/// connection loop.
pub async fn run_webtransport_listener(
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    let wt_cfg = &config.webtransport;

    // Determine certificate paths: prefer dedicated WT cert, fall back to main TLS cert.
    let cert_path = wt_cfg.cert.as_deref().unwrap_or(&config.tls.cert);
    let key_path  = wt_cfg.key.as_deref().unwrap_or(&config.tls.key);

    if wt_cfg.cert_reload_interval_secs > 0 {
        info!(
            "WebTransport cert hot-reload is configured (every {}s) but is not yet \
             active in Phase 1 — a process restart is required to pick up a renewed cert.",
            wt_cfg.cert_reload_interval_secs
        );
    }

    let bind_addr: SocketAddr = format!("{}:{}", wt_cfg.host, wt_cfg.port)
        .parse()
        .context("Invalid WebTransport bind address")?;

    info!("WebTransport listener starting on {}", bind_addr);

    // Load TLS identity once.
    let identity = Identity::load_pemfiles(cert_path, key_path)
        .await
        .with_context(|| format!("Failed to load WebTransport certificate cert={} key={}", cert_path, key_path))?;

    // Build QUIC endpoint.
    let server_config = ServerConfig::builder()
        .with_bind_address(bind_addr)
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(10)))
        .max_idle_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| anyhow::anyhow!("Invalid WebTransport idle timeout: {}", e))?
        .build();

    let endpoint = Endpoint::server(server_config)
        .context("Failed to create WebTransport endpoint")?;

    // Accept loop — runs until the task is aborted (server shutdown).
    loop {
        // accept() returns an IncomingSession; awaiting it completes the QUIC handshake
        // and returns a SessionRequest (or an error).
        let incoming = endpoint.accept().await;
        let peer_addr = incoming.remote_address();

        let config_clone = Arc::clone(&config);
        let hub_clone    = Arc::clone(&hub_client);
        let state_clone  = Arc::clone(&edge_state);

        tokio::spawn(async move {
            // Complete the WebTransport handshake (QUIC + HTTP/3 CONNECT).
            let request = match incoming.await {
                Ok(r) => r,
                Err(e) => {
                    debug!("WebTransport handshake error from {}: {}", peer_addr, e);
                    return;
                }
            };

            // Refuse connections while Hub is unreachable.
            if !state_clone.accepting_connections.load(std::sync::atomic::Ordering::Relaxed) {
                debug!("WebTransport connection from {} refused: Hub unreachable", peer_addr);
                return;
            }

            // Accept the WebTransport session.
            let session = match request.accept().await {
                Ok(s) => s,
                Err(e) => {
                    debug!("WebTransport session accept error from {}: {}", peer_addr, e);
                    return;
                }
            };

            info!("WebTransport session from {}", peer_addr);

            if let Err(e) = handle_wt_session(session, peer_addr, &config_clone, hub_clone, state_clone).await {
                debug!("WebTransport session error from {}: {}", peer_addr, e);
            }
        });
    }
}

/// Handle a single WebTransport session: accept the control bi-stream and run
/// the shared Mumble connection loop.
async fn handle_wt_session(
    session: wtransport::Connection,
    peer_addr: SocketAddr,
    config: &EdgeConfig,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    // The first bidirectional stream is the Mumble control stream.
    // Browsers open it immediately after the session is established.
    let (send_stream, recv_stream) = tokio::time::timeout(
        Duration::from_secs(15),
        session.accept_bi(),
    )
    .await
    .context("Timeout waiting for WebTransport control stream")?
    .context("Failed to accept WebTransport control stream")?;

    // Wrap the recv stream as Box<dyn AsyncRead>.
    let reader: Box<dyn tokio::io::AsyncRead + Unpin + Send> = Box::new(recv_stream);

    // Per-session outgoing message channel.
    let (send_tx, mut send_rx) = mpsc::channel::<bytes::Bytes>(4096);
    let client_sender = ClientSender::new(send_tx);

    let write_failed = Arc::new(tokio::sync::Notify::new());
    let write_failed_notify = Arc::clone(&write_failed);

    // Writer task: drain the send_rx channel and write to the QUIC send stream.
    let writer_handle: tokio::task::JoinHandle<()> = tokio::spawn(async move {
        let mut send_stream = send_stream;
        loop {
            let first = match send_rx.recv().await {
                Some(data) => data,
                None => break,
            };

            let mut pending = vec![first];
            while let Ok(more) = send_rx.try_recv() {
                pending.push(more);
                if pending.len() >= 32 { break; }
            }

            for chunk in &pending {
                if let Err(e) = send_stream.write_all(chunk).await {
                    debug!("WebTransport write error: {}", e);
                    write_failed_notify.notify_one();
                    return;
                }
            }
        }
    });

    // Run the shared connection loop (same as TLS path, skip CryptSetup).
    crate::server::connection::run_connection_inner(
        reader,
        client_sender,
        write_failed,
        writer_handle,
        peer_addr,
        None,
        TransportKind::WebTransport,
        config,
        hub_client,
        edge_state,
    )
    .await
}

