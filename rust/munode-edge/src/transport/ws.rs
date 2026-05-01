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
use std::time::Duration;

use anyhow::{Context as ACtx, Result};
use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt, Stream};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info};

use munode_common::config::EdgeConfig;

use crate::client::ClientSender;
use crate::hub_client::HubClient;
use crate::state::EdgeState;
use crate::transport::TransportKind;

/// Maximum bytes to peek while sniffing the HTTP request line/headers.
const HTTP_PEEK_MAX: usize = 8192;
/// How long to wait for an incoming HTTP request head before giving up.
const HTTP_PEEK_TIMEOUT: Duration = Duration::from_secs(5);

/// Run the browser HTTP info + WebSocket listener.
///
/// On a single TCP port this listener serves two kinds of requests:
///   * `GET /edge-info` (and `GET /`) — JSON discovery payload describing how
///     browser clients should connect (WebSocket URL, future WebTransport
///     address, server name, version, online users, …).
///   * WebSocket Upgrade — Mumble frames inside binary WebSocket messages.
///
/// Requests are dispatched by sniffing the HTTP request head with
/// `TcpStream::peek` so the underlying byte stream is left intact for
/// `tokio_tungstenite::accept_async` when an Upgrade is requested.
pub async fn run_ws_listener(
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    let wt_cfg = &config.webtransport;
    let port = wt_cfg.effective_ws_port(config.network.port);
    let bind_addr: SocketAddr = format!("{}:{}", wt_cfg.ws_fallback_host, port)
        .parse()
        .context("Invalid browser HTTP/WebSocket bind address")?;

    let listener = TcpListener::bind(bind_addr).await
        .context("Failed to bind browser HTTP/WebSocket listener")?;
    info!("Browser HTTP/WebSocket listener on {}", bind_addr);

    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                debug!("Browser listener accept error: {}", e);
                continue;
            }
        };

        if !edge_state.accepting_connections.load(std::sync::atomic::Ordering::Relaxed) {
            debug!("Browser connection from {} refused: Hub unreachable", peer_addr);
            drop(stream);
            continue;
        }

        let config_clone  = Arc::clone(&config);
        let hub_clone     = Arc::clone(&hub_client);
        let state_clone   = Arc::clone(&edge_state);

        tokio::spawn(async move {
            if let Err(e) = dispatch_connection(stream, peer_addr, config_clone, hub_clone, state_clone).await {
                debug!("Browser connection error from {}: {}", peer_addr, e);
            }
        });
    }
}

/// Returns `true` when the byte is consistent with an HTTP request-line
/// start (ASCII uppercase letter).  TLS ClientHello always starts with
/// `0x16` (record-type = Handshake), which is not an ASCII letter, so
/// this simple check cleanly separates the two protocols.
#[inline]
pub(crate) fn byte_looks_like_http(b: u8) -> bool {
    // HTTP/1.x methods: GET POST HEAD PUT DELETE OPTIONS TRACE CONNECT PATCH
    // All start with an ASCII uppercase letter (0x41–0x5A).
    b.is_ascii_uppercase()
}

/// Sniff the request head and dispatch to either the JSON info handler or the
/// WebSocket upgrade handler.
pub(crate) async fn dispatch_connection(
    mut stream: TcpStream,
    peer_addr: SocketAddr,
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    let head = match timeout(HTTP_PEEK_TIMEOUT, peek_http_head(&stream)).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            debug!("HTTP head peek error from {}: {}", peer_addr, e);
            return Ok(());
        }
        Err(_) => {
            debug!("HTTP head peek timeout from {}", peer_addr);
            return Ok(());
        }
    };

    let head_str = std::str::from_utf8(&head).unwrap_or("");
    let is_websocket_upgrade = head_str
        .lines()
        .any(|line| {
            let line = line.trim();
            line.eq_ignore_ascii_case("Upgrade: websocket")
                || line.to_ascii_lowercase() == "upgrade: websocket"
        });

    if is_websocket_upgrade {
        let ws_stream = match tokio_tungstenite::accept_async(stream).await {
            Ok(s) => s,
            Err(e) => {
                debug!("WebSocket upgrade error from {}: {}", peer_addr, e);
                return Ok(());
            }
        };
        info!("WebSocket connection from {}", peer_addr);
        if let Err(e) = handle_ws_connection(ws_stream, peer_addr, &config, hub_client, edge_state).await {
            debug!("WebSocket session error from {}: {}", peer_addr, e);
        }
        return Ok(());
    }

    // Treat as HTTP request — extract method + path from the request line.
    let request_line = head_str.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    if method.eq_ignore_ascii_case("OPTIONS") {
        write_cors_preflight(&mut stream).await.ok();
    } else if method.eq_ignore_ascii_case("GET")
        && (path == "/" || path.starts_with("/edge-info"))
    {
        let body = build_edge_info_json(&config);
        write_json_response(&mut stream, 200, "OK", &body).await.ok();
    } else {
        let body = "{\"error\":\"not_found\"}".to_string();
        write_json_response(&mut stream, 404, "Not Found", &body).await.ok();
    }

    Ok(())
}

/// Repeatedly peek the TCP socket until the HTTP header terminator (`\r\n\r\n`)
/// is visible. Returns the bytes peeked (the underlying socket buffer is **not**
/// consumed, so a subsequent WebSocket handshake can re-read the same bytes).
async fn peek_http_head(stream: &TcpStream) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; HTTP_PEEK_MAX];
    loop {
        let n = stream.peek(&mut buf).await?;
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
            buf.truncate(n);
            return Ok(buf);
        }
        if n == buf.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "HTTP head too large"));
        }
        // Yield and retry — peek will block until more data is available.
        tokio::task::yield_now().await;
    }
}

/// Read a PEM file and return the SHA-256 digest of the first DER certificate
/// as a base64-encoded string (standard alphabet, no padding), or `None` on error.
fn cert_sha256_base64(cert_path: &str) -> Option<String> {
    use base64::Engine as _;
    let pem = std::fs::read(cert_path).ok()?;
    // Find the first "-----BEGIN CERTIFICATE-----" block.
    let pem_str = std::str::from_utf8(&pem).ok()?;
    let start = pem_str.find("-----BEGIN CERTIFICATE-----")?;
    let rest = &pem_str[start + "-----BEGIN CERTIFICATE-----".len()..];
    let end = rest.find("-----END CERTIFICATE-----")?;
    let b64_body: String = rest[..end].chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let der = base64::engine::general_purpose::STANDARD.decode(&b64_body).ok()?;
    let digest = ring::digest::digest(&ring::digest::SHA256, &der);
    Some(base64::engine::general_purpose::STANDARD.encode(digest.as_ref()))
}

/// Build the EdgeInfo JSON discovery payload.
fn build_edge_info_json(config: &EdgeConfig) -> String {
    let wt = &config.webtransport;
    let ws_port = wt.effective_ws_port(config.network.port);
    let ws_host = wt
        .external_host
        .as_deref()
        .unwrap_or_else(|| {
            if !config.network.external_host.is_empty() {
                config.network.external_host.as_str()
            } else {
                wt.ws_fallback_host.as_str()
            }
        });
    // Use wss:// when the WS listener is co-hosted on the main TLS port
    // (ws_fallback_port is None → shares the TLS port via protocol sniffing).
    let ws_scheme = if config.webtransport.ws_fallback_port.is_none() { "wss" } else { "ws" };
    let ws_url = format!("{}://{}:{}/mumble", ws_scheme, ws_host, ws_port);

    // The WebTransport entry is present only when enabled and advertised.
    // cert_hashes includes the SHA-256 of the WebTransport certificate so that
    // browsers can use serverCertificateHashes for self-signed certs.
    let webtransport_json = if wt.enabled && wt.advertise {
        let wt_host = wt.external_host.as_deref().unwrap_or(ws_host);
        let wt_port = wt
            .external_port
            .unwrap_or_else(|| wt.effective_wt_port(config.network.port));
        // Prefer the dedicated WT cert; fall back to the main TLS cert.
        let cert_path = wt.cert.as_deref().unwrap_or(&config.tls.cert);
        let cert_hashes_json = match cert_sha256_base64(cert_path) {
            Some(hash) => format!(r#"[{{"algorithm":"sha-256","value":{hash:?}}}]"#),
            None => "null".to_string(),
        };
        format!(
            r#"{{"url":"https://{}:{}/mumble","cert_hashes":{}}}"#,
            wt_host, wt_port, cert_hashes_json
        )
    } else {
        "null".to_string()
    };

    format!(
        r#"{{"server_id":{server_id},"name":{name:?},"version":{version:?},"websocket":{{"url":{ws_url:?}}},"webtransport":{wt_json}}}"#,
        server_id = config.server_id,
        name = config.name,
        version = env!("CARGO_PKG_VERSION"),
        ws_url = ws_url,
        wt_json = webtransport_json,
    )
}

async fn write_json_response<W: AsyncWrite + Unpin>(
    stream: &mut W,
    status: u16,
    reason: &str,
    body: &str,
) -> io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        status = status,
        reason = reason,
        len = body.as_bytes().len(),
        body = body,
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.shutdown().await
}

async fn write_cors_preflight<W: AsyncWrite + Unpin>(stream: &mut W) -> io::Result<()> {
    let resp = "HTTP/1.1 204 No Content\r\n\
                Access-Control-Allow-Origin: *\r\n\
                Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                Access-Control-Allow-Headers: Content-Type\r\n\
                Access-Control-Max-Age: 600\r\n\
                Content-Length: 0\r\n\
                Connection: close\r\n\
                \r\n";
    stream.write_all(resp.as_bytes()).await?;
    stream.shutdown().await
}

/// Handle a single WebSocket connection.
async fn handle_ws_connection<S>(
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    peer_addr: SocketAddr,
    config: &EdgeConfig,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
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
    let reader: Box<dyn AsyncRead + Unpin + Send> = Box::new(WsReader::<S>::new(ws_source));

    crate::server::connection::run_connection_inner(
        reader,
        client_sender,
        write_failed,
        writer_handle,
        peer_addr,
        None,
        vec![],
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
struct WsReader<S> {
    source: futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<S>>,
    buf: BytesMut,
}

impl<S: AsyncRead + AsyncWrite + Unpin> WsReader<S> {
    fn new(
        source: futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<S>>,
    ) -> Self {
        Self { source, buf: BytesMut::with_capacity(8192) }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for WsReader<S> {
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
        match Stream::poll_next(Pin::new(&mut self.as_mut().source), cx) {
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

// ---------------------------------------------------------------------------
// PrependedStream — put-back buffer for protocol sniffing
// ---------------------------------------------------------------------------

/// A stream wrapper that prepends buffered bytes before the inner stream's data.
///
/// Used to "put back" bytes that were read for protocol sniffing so that
/// subsequent readers (e.g. `tokio_tungstenite::accept_async`) see a complete
/// byte stream starting from the very first byte of the connection.
pub(crate) struct PrependedStream<S> {
    buf: Bytes,
    inner: S,
}

impl<S> PrependedStream<S> {
    pub(crate) fn new(buf: impl Into<Bytes>, inner: S) -> Self {
        Self { buf: buf.into(), inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrependedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.buf.is_empty() {
            let n = self.buf.len().min(buf.remaining());
            buf.put_slice(&self.buf[..n]);
            self.buf = self.buf.slice(n..);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrependedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

// ---------------------------------------------------------------------------
// TLS-aware HTTP/WS dispatch
// ---------------------------------------------------------------------------

/// Read HTTP request headers from a stream that has already consumed `first_byte`.
/// Returns all header bytes including `first_byte`.  Reads byte-by-byte until
/// `\r\n\r\n` is found, which is fine for the request-head (≪ 8 KiB).
async fn read_http_head_consuming<S: AsyncRead + Unpin>(
    first_byte: u8,
    stream: &mut S,
) -> io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::with_capacity(256);
    head.push(first_byte);
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            return Ok(head);
        }
        if head.len() > HTTP_PEEK_MAX {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "HTTP head too large"));
        }
    }
}

/// Dispatch an HTTP or WebSocket request that arrived over a TLS stream.
///
/// Called from the main TLS accept loop when the first post-handshake byte
/// looks like an HTTP method (ASCII uppercase letter).  `first_byte` has
/// already been consumed from `stream`; this function reads the remaining
/// request head and then either:
///   * upgrades to a WebSocket connection (the full head bytes are put back
///     via `PrependedStream` so `tokio_tungstenite` can re-read them), or
///   * serves a plain HTTP response (GET /edge-info, OPTIONS, 404).
pub(crate) async fn dispatch_tls_http<S>(
    first_byte: u8,
    mut stream: S,
    peer_addr: SocketAddr,
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let head = match timeout(
        HTTP_PEEK_TIMEOUT,
        read_http_head_consuming(first_byte, &mut stream),
    ).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => { debug!("HTTP head read error from {}: {}", peer_addr, e); return Ok(()); }
        Err(_)    => { debug!("HTTP head read timeout from {}", peer_addr); return Ok(()); }
    };

    let head_str = std::str::from_utf8(&head).unwrap_or("");
    let is_ws_upgrade = head_str.lines().any(|l| {
        l.trim().eq_ignore_ascii_case("Upgrade: websocket")
    });

    if is_ws_upgrade {
        // Put back all head bytes so tokio-tungstenite can re-read the full HTTP request.
        let full_stream = PrependedStream::new(Bytes::from(head), stream);
        let ws_stream = match tokio_tungstenite::accept_async(full_stream).await {
            Ok(s) => s,
            Err(e) => { debug!("WebSocket (TLS) upgrade error from {}: {}", peer_addr, e); return Ok(()); }
        };
        info!("WebSocket (TLS) connection from {}", peer_addr);
        if let Err(e) = handle_ws_connection(ws_stream, peer_addr, &config, hub_client, edge_state).await {
            debug!("WebSocket (TLS) session error from {}: {}", peer_addr, e);
        }
        return Ok(());
    }

    // Plain HTTP — parse method + path and respond.
    let request_line = head_str.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path   = parts.next().unwrap_or("");

    if method.eq_ignore_ascii_case("OPTIONS") {
        write_cors_preflight(&mut stream).await.ok();
    } else if method.eq_ignore_ascii_case("GET")
        && (path == "/" || path.starts_with("/edge-info"))
    {
        let body = build_edge_info_json(&config);
        write_json_response(&mut stream, 200, "OK", &body).await.ok();
    } else {
        let body = "{\"error\":\"not_found\"}";
        write_json_response(&mut stream, 404, "Not Found", body).await.ok();
    }

    Ok(())
}
