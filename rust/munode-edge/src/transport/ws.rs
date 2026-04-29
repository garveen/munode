//! WebSocket fallback transport for browsers that cannot use WebTransport (QUIC).
//!
//! The WebSocket listener accepts connections on a plain TCP port.  The browser
//! connects to `ws://<host>:<port>/mumble` (or `wss://` when behind a TLS-terminating
//! reverse proxy).  All Mumble control frames and voice frames are exchanged as
//! binary WebSocket messages with the standard `[type:u16][len:u32][payload]` framing.
//!
//! OCB2-AES128 / CryptSetup is skipped for WebSocket connections.  Deployments that
//! need transport security MUST place the WebSocket port behind a TLS reverse proxy
//! (e.g. nginx or Caddy with `ws_pass`).
//!
//! # Wire format inside WebSocket binary messages
//!
//! Each WebSocket binary message contains exactly one Mumble frame:
//! ```text
//! [type : u16 BE][length : u32 BE][protobuf payload]
//! ```
//! This is the same framing as TCP/TLS Mumble.  The connection loop can therefore
//! use the same `decode_frame` decoder after re-assembling frames from the WS messages.

use std::net::SocketAddr;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::pin::Pin;
use std::io;

use anyhow::{Context as ACtx, Result};
use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt, Stream};
use tokio::io::{AsyncRead, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info};

use munode_common::config::EdgeConfig;

use crate::client::ClientSender;
use crate::hub_client::HubClient;
use crate::state::EdgeState;
use crate::transport::TransportKind;

/// Run the WebSocket fallback listener.
pub async fn run_ws_listener(
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    let wt_cfg = &config.webtransport;
    let bind_addr: SocketAddr = format!("{}:{}", wt_cfg.ws_fallback_host, wt_cfg.ws_fallback_port)
        .parse()
        .context("Invalid WebSocket fallback bind address")?;

    let listener = TcpListener::bind(bind_addr).await
        .context("Failed to bind WebSocket fallback listener")?;
    info!("WebSocket fallback listener on {}", bind_addr);

    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                debug!("WebSocket accept error: {}", e);
                continue;
            }
        };

        if !edge_state.accepting_connections.load(std::sync::atomic::Ordering::Relaxed) {
            debug!("WebSocket connection from {} refused: Hub unreachable", peer_addr);
            drop(stream);
            continue;
        }

        let config_clone  = Arc::clone(&config);
        let hub_clone     = Arc::clone(&hub_client);
        let state_clone   = Arc::clone(&edge_state);

        tokio::spawn(async move {
            // Upgrade TCP connection to WebSocket.
            let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                Ok(s) => s,
                Err(e) => {
                    debug!("WebSocket upgrade error from {}: {}", peer_addr, e);
                    return;
                }
            };

            info!("WebSocket connection from {}", peer_addr);

            if let Err(e) = handle_ws_connection(ws_stream, peer_addr, &config_clone, hub_clone, state_clone).await {
                debug!("WebSocket session error from {}: {}", peer_addr, e);
            }
        });
    }
}

/// Handle a single WebSocket connection.
async fn handle_ws_connection(
    ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    peer_addr: SocketAddr,
    config: &EdgeConfig,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    let (ws_sink, ws_source) = ws_stream.split();

    // Per-session outgoing message channel.
    let (send_tx, mut send_rx) = mpsc::channel::<Bytes>(4096);
    let client_sender = ClientSender::new(send_tx);

    let write_failed = Arc::new(tokio::sync::Notify::new());
    let write_failed_notify = Arc::clone(&write_failed);

    // Writer task: drain send_rx and send each frame as a binary WebSocket message.
    let writer_handle: tokio::task::JoinHandle<()> = tokio::spawn(async move {
        let mut sink = ws_sink;
        loop {
            let data = match send_rx.recv().await {
                Some(d) => d,
                None => break,
            };
            // Drain any additional pending frames to reduce per-send overhead.
            let mut batch = vec![WsMessage::Binary(data.to_vec().into())];
            while let Ok(more) = send_rx.try_recv() {
                batch.push(WsMessage::Binary(more.to_vec().into()));
                if batch.len() >= 32 { break; }
            }
            for msg in batch {
                if let Err(e) = sink.send(msg).await {
                    debug!("WebSocket write error: {}", e);
                    write_failed_notify.notify_one();
                    return;
                }
            }
        }
    });

    // Wrap the WS receive stream as AsyncRead so the connection loop can use
    // the standard decode_frame machinery.
    let reader: Box<dyn AsyncRead + Unpin + Send> = Box::new(WsReader::new(ws_source));

    crate::server::connection::run_connection_inner(
        reader,
        client_sender,
        write_failed,
        writer_handle,
        peer_addr,
        None,
        TransportKind::WebSocket,
        config,
        hub_client,
        edge_state,
    )
    .await
}

/// Adapts a WebSocket binary message stream to `tokio::io::AsyncRead`.
///
/// Each WebSocket binary message is expected to contain exactly one complete Mumble
/// frame (`[type:u16][len:u32][payload]`).  The `WsReader` buffers incomplete messages
/// and presents a byte stream to the standard `decode_frame` decoder.
struct WsReader {
    source: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    buf: BytesMut,
}

impl WsReader {
    fn new(
        source: futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        >,
    ) -> Self {
        Self { source, buf: BytesMut::with_capacity(8192) }
    }
}

impl AsyncRead for WsReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // If we already have buffered data, drain it first.
        if !self.buf.is_empty() {
            let n = self.buf.len().min(buf.remaining());
            buf.put_slice(&self.buf[..n]);
            let _ = self.buf.split_to(n);
            return Poll::Ready(Ok(()));
        }

        // Poll the next WebSocket message.
        match Stream::poll_next(Pin::new(&mut self.source), cx) {
            Poll::Ready(Some(Ok(WsMessage::Binary(data)))) => {
                let n = data.len().min(buf.remaining());
                buf.put_slice(&data[..n]);
                if n < data.len() {
                    // Didn't fit — stash the remainder.
                    use bytes::BufMut;
                    self.buf.put_slice(&data[n..]);
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Some(Ok(WsMessage::Close(_)))) => {
                // Clean WebSocket close → EOF.
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Some(Ok(_))) => {
                // Ignore ping/pong/text frames; signal the caller to retry.
                cx.waker().wake_by_ref();
                Poll::Pending
            }
            Poll::Ready(Some(Err(e))) => {
                Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, e)))
            }
            Poll::Ready(None) => {
                // Stream ended → EOF.
                Poll::Ready(Ok(()))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
