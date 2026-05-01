//! WebSocket fallback transport for browsers that cannot use WebTransport (QUIC).
//!
//! The WebSocket listener accepts connections on a plain TCP port (or directly
//! serves TLS when `ws_tls_mode = "native"`).  The browser connects to
//! `ws://<host>:<port>` or `wss://<host>:<port>` depending on the configured TLS
//! mode.  All Mumble control frames and voice frames are exchanged as binary
//! WebSocket messages with the standard `[type:u16][len:u32][payload]` framing.
//!
//! # TLS modes (`ws_tls_mode`)
//!
//! | Value    | Bind transport   | Advertised URL scheme | Typical use |
//! |----------|------------------|-----------------------|-------------|
//! | `plain`  | plain TCP        | `ws://`               | dev / internal |
//! | `proxy`  | plain TCP        | `wss://`              | behind nginx/Caddy |
//! | `native` | TLS (Edge)       | `wss://`              | direct internet |
//!
//! For `native` mode the Edge loads the WebTransport cert/key (or falls back
//! to the main `tls.cert`/`tls.key`) and performs the TLS handshake before
//! handing off to the HTTP/WebSocket dispatcher.
//!
//! OCB2-AES128 / CryptSetup is skipped for all WebSocket connections.  For
//! `plain` and `proxy` modes, deployments that need transport security MUST
//! use a TLS-terminating reverse proxy.
//!
//! # Wire format inside WebSocket binary messages
//!
//! Each WebSocket binary message contains exactly one Mumble frame:
//! ```text
//! [type : u16 BE][length : u32 BE][protobuf payload]
//! ```

use std::net::SocketAddr;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::pin::Pin;
use std::io;
use std::time::Duration;

use anyhow::{Context as ACtx, Result};
use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt, Stream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

use munode_common::config::{EdgeConfig, WsTlsMode};

use crate::client::ClientSender;
use crate::hub_client::HubClient;
use crate::state::EdgeState;
use crate::transport::TransportKind;

/// Maximum bytes to read while sniffing the HTTP request line/headers.
const HTTP_PEEK_MAX: usize = 8192;
/// How long to wait for an incoming HTTP request head before giving up.
const HTTP_PEEK_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// PrefixedStream — replays already-consumed bytes before delegating to inner
// ---------------------------------------------------------------------------

/// Wraps an `AsyncRead + AsyncWrite` stream and prepends a byte buffer that is
/// drained before any reads hit the underlying stream.  This is used in the
/// native-TLS path after the HTTP request head has already been read from the
/// TLS stream, so that `tokio_tungstenite::accept_async` can re-read the same
/// request bytes from the stream.
pub(crate) struct PrefixedStream<S> {
    prefix: Bytes,
    inner:  S,
}

impl<S> PrefixedStream<S> {
    pub(crate) fn new(prefix: Bytes, inner: S) -> Self {
        Self { prefix, inner }
    }
}

impl<S: Unpin> Unpin for PrefixedStream<S> {}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.prefix.is_empty() {
            let n = self.prefix.len().min(buf.remaining());
            buf.put_slice(&self.prefix[..n]);
            self.prefix = self.prefix.slice(n..);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Run the browser HTTP info + WebSocket listener.
///
/// On a single TCP port this listener serves two kinds of requests:
///   * `GET /edge-info` (and `GET /`) — JSON discovery payload describing how
///     browser clients should connect (WebSocket URL, future WebTransport
///     address, server name, version, online users, …).
///   * WebSocket Upgrade — Mumble frames inside binary WebSocket messages.
///
/// In `native` TLS mode the Edge performs the TLS handshake itself before
/// dispatching.  In `plain` / `proxy` modes the incoming TCP byte stream is
/// sniffed with `TcpStream::peek` to determine the request type without
/// consuming any bytes, allowing `tokio_tungstenite::accept_async` to re-read
/// the same upgrade headers later.
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

    // Load TLS acceptor when running in native-TLS mode.
    let tls_acceptor: Option<tokio_rustls::TlsAcceptor> = if wt_cfg.ws_tls_mode.is_native_tls() {
        let cert_path = wt_cfg.cert.as_deref().unwrap_or(&config.tls.cert);
        let key_path  = wt_cfg.key.as_deref().unwrap_or(&config.tls.key);
        let tls_config = munode_common::config::TlsConfig {
            cert: cert_path.to_string(),
            key:  key_path.to_string(),
            ca:   None,
        };
        let acceptor = crate::tls::create_tls_acceptor(&tls_config)
            .context("Failed to create TLS acceptor for native-TLS WebSocket listener")?;
        info!("Browser WebSocket listener (native TLS / wss://) on {}", bind_addr);
        Some(acceptor)
    } else {
        let scheme = wt_cfg.ws_tls_mode.ws_scheme();
        info!("Browser WebSocket listener ({}://) on {}", scheme, bind_addr);
        None
    };

    let listener = TcpListener::bind(bind_addr).await
        .context("Failed to bind browser HTTP/WebSocket listener")?;

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

        match &tls_acceptor {
            Some(acceptor) => {
                let acceptor_clone = acceptor.clone();
                tokio::spawn(async move {
                    match acceptor_clone.accept(stream).await {
                        Ok(tls_stream) => {
                            if let Err(e) = dispatch_tls_connection(
                                tls_stream, peer_addr, config_clone, hub_clone, state_clone,
                            ).await {
                                debug!("Browser TLS connection error from {}: {}", peer_addr, e);
                            }
                        }
                        Err(e) => debug!("TLS handshake error from {}: {}", peer_addr, e),
                    }
                });
            }
            None => {
                tokio::spawn(async move {
                    if let Err(e) = dispatch_connection(
                        stream, peer_addr, config_clone, hub_clone, state_clone,
                    ).await {
                        debug!("Browser connection error from {}: {}", peer_addr, e);
                    }
                });
            }
        }
    }
}

/// Sniff the request head and dispatch to either the JSON info handler or the
/// WebSocket upgrade handler.  Uses `TcpStream::peek` so the byte stream is
/// not consumed (plain/proxy mode only).
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
        if is_ws_upgrade(head_str) {
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

    dispatch_http(&mut stream, head_str, &config).await
}

/// Dispatch for native-TLS connections from the dedicated WS port.
/// TLS handshake is performed here, then delegated to `dispatch_tls_stream`.
async fn dispatch_tls_connection(
    stream: tokio_rustls::server::TlsStream<TcpStream>,
    peer_addr: SocketAddr,
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()> {
    dispatch_tls_stream(stream, peer_addr, config, hub_client, edge_state).await
}

/// Dispatch an HTTP/WebSocket connection that arrived on the main TLS port
/// (when `ws_fallback_port` equals `network.port`).
///
/// The TLS handshake is already complete and exactly `first_byte` has already
/// been read from the stream.  We prepend it back via `PrefixedStream` and
/// then run the same head-read + dispatch logic as `dispatch_tls_connection`.
pub(crate) async fn dispatch_tls_http<S>(
    first_byte: u8,
    stream: S,
    peer_addr: SocketAddr,
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let prefixed = PrefixedStream::new(Bytes::from(vec![first_byte]), stream);
    dispatch_tls_stream(prefixed, peer_addr, config, hub_client, edge_state).await
}

/// Returns `true` when the given byte is the first byte of an HTTP request
/// (all HTTP methods start with an ASCII uppercase letter).
pub(crate) fn byte_looks_like_http(b: u8) -> bool {
    b.is_ascii_uppercase()
}

/// Core dispatcher for an already-TLS-wrapped (or similarly opaque) stream.
/// Reads the HTTP request head, then routes to the WS upgrade or HTTP info handler.
async fn dispatch_tls_stream<S>(
    mut stream: S,
    peer_addr: SocketAddr,
    config: Arc<EdgeConfig>,
    hub_client: Arc<HubClient>,
    edge_state: Arc<EdgeState>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut head_buf = vec![0u8; HTTP_PEEK_MAX];
    let n = match timeout(HTTP_PEEK_TIMEOUT, read_http_head(&mut stream, &mut head_buf)).await {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => {
            debug!("HTTP head read error (TLS) from {}: {}", peer_addr, e);
            return Ok(());
        }
        Err(_) => {
            debug!("HTTP head read timeout (TLS) from {}", peer_addr);
            return Ok(());
        }
    };
    head_buf.truncate(n);
    let head_str = std::str::from_utf8(&head_buf).unwrap_or("").to_owned();

    if is_ws_upgrade(&head_str) {
        // Replay the consumed head bytes so tungstenite can re-read the upgrade request.
        let prefixed = PrefixedStream::new(Bytes::from(head_buf), stream);
        let ws_stream = match tokio_tungstenite::accept_async(prefixed).await {
            Ok(s) => s,
            Err(e) => {
                debug!("WebSocket upgrade error (TLS stream) from {}: {}", peer_addr, e);
                return Ok(());
            }
        };
        info!("WebSocket (TLS stream) connection from {}", peer_addr);
        if let Err(e) = handle_ws_connection(ws_stream, peer_addr, &config, hub_client, edge_state).await {
            debug!("WebSocket TLS stream session error from {}: {}", peer_addr, e);
        }
        return Ok(());
    }

    dispatch_http(&mut stream, &head_str, &config).await
}

/// Common HTTP dispatcher: write edge-info JSON or CORS preflight response.
async fn dispatch_http<W: AsyncWrite + Unpin>(
    stream: &mut W,
    head_str: &str,
    config: &EdgeConfig,
) -> Result<()> {
    let request_line = head_str.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path   = parts.next().unwrap_or("");

    if method.eq_ignore_ascii_case("OPTIONS") {
        write_cors_preflight(stream).await.ok();
    } else if method.eq_ignore_ascii_case("GET")
        && (path == "/" || path.starts_with("/edge-info"))
    {
        let body = build_edge_info_json(config);
        write_json_response(stream, 200, "OK", &body).await.ok();
    } else {
        let body = "{\"error\":\"not_found\"}".to_string();
        write_json_response(stream, 404, "Not Found", &body).await.ok();
    }
    Ok(())
}

/// Returns `true` if the HTTP head contains a WebSocket upgrade request.
fn is_ws_upgrade(head_str: &str) -> bool {
    head_str
        .lines()
        .any(|line| line.trim().to_ascii_lowercase() == "upgrade: websocket")
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

/// Read bytes from an `AsyncRead` stream into `buf` until the HTTP header
/// terminator (`\r\n\r\n`) is found or `buf` is full.  Unlike `peek_http_head`,
/// this *consumes* the bytes.  Used in native-TLS mode where the TLS layer
/// decrypts data; peeking on the underlying `TcpStream` would return ciphertext.
async fn read_http_head<R: AsyncRead + Unpin>(stream: &mut R, buf: &mut Vec<u8>) -> io::Result<usize> {
    let mut total = 0usize;
    let cap = buf.len();
    loop {
        if total == cap {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "HTTP head too large"));
        }
        let n = stream.read(&mut buf[total..]).await?;
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        total += n;
        if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(total);
        }
    }
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
    // Use the scheme appropriate for the configured TLS mode.
    let ws_scheme = wt.ws_tls_mode.ws_scheme();
    let ws_url = format!("{}://{}:{}/mumble", ws_scheme, ws_host, ws_port);

    // The WebTransport entry is reserved for future use — the server may not
    // be configured for WebTransport yet, in which case the field is null.
    let webtransport_json = if wt.enabled && wt.advertise {
        let wt_host = wt.external_host.as_deref().unwrap_or(ws_host);
        let wt_port = wt.external_port.unwrap_or(wt.port);
        format!(
            r#"{{"url":"https://{}:{}/mumble","cert_hashes":null}}"#,
            wt_host, wt_port
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
    let reader: Box<dyn AsyncRead + Unpin + Send> = Box::new(WsReader::new(ws_source));

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
    source: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<S>,
    >,
    buf: BytesMut,
}

impl<S> WsReader<S> {
    fn new(
        source: futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<S>,
        >,
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
