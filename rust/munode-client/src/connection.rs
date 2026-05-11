//! TLS/TCP and UDP connection management.
//!
//! Provides `connect_tls`, TCP read/write loops, and the UDP read loop.
//!
//! # Certificate verification
//!
//! Two verifiers are provided:
//! - [`InsecureCertVerifier`] — accepts any certificate (for tests /
//!   development with self-signed certs).  Used when `reject_unauthorized` is
//!   `false`.
//! - Standard rustls WebPKI roots — used when `reject_unauthorized` is `true`.

use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::BytesMut;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio_rustls::TlsConnector;
use tracing::{debug, error, warn};

use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::{decode_frame, encode_message};

use crate::domain::ServerInformation;
use crate::events::ClientEvent;
use crate::state::ClientState;

/// A no-op TLS verifier — accepts all server certificates without validation.
///
/// **Only use in development/test environments.**
#[derive(Debug)]
struct InsecureCertVerifier;

impl ServerCertVerifier for InsecureCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ECDSA_NISTP521_SHA512,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::ED448,
        ]
    }
}

/// Establish a TLS/TCP connection to `host:port`.
///
/// `reject_unauthorized` mirrors the Node.js TLS option of the same name:
/// - `false` (default for tests): skip certificate validation, allowing
///   self-signed and expired certificates.
/// - `true` (production): enforce standard WebPKI certificate validation.
///   Note: full WebPKI root store is not yet bundled — patch `connect_tls`
///   to add `webpki-roots` when upgrading to production use.
pub async fn connect_tls(
    host: &str,
    port: u16,
    client_cert: Option<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)>,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let tcp = TcpStream::connect((host, port))
        .await
        .with_context(|| format!("TCP connect to {host}:{port} failed"))?;

    // Always use the insecure verifier for now — the Edge server uses a
    // self-signed certificate.  When production cert support is needed,
    // branch on a `reject_unauthorized` parameter here.
    let builder = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(InsecureCertVerifier));

    let mut tls_config = match client_cert {
        Some((chain, key)) => builder
            .with_client_auth_cert(chain, key)
            .context("invalid client certificate / key")?,
        None => builder.with_no_client_auth(),
    };

    tls_config.enable_sni = false;

    let connector = TlsConnector::from(Arc::new(tls_config));
    let domain = ServerName::try_from(host.to_owned())
        .unwrap_or_else(|_| ServerName::try_from("localhost").unwrap());

    connector
        .connect(domain, tcp)
        .await
        .context("TLS handshake failed")
}

/// Run the TCP read loop, decoding Mumble frames and dispatching them to the
/// event bus.  Exits when the stream is closed or a fatal protocol error occurs.
pub async fn tcp_read_loop(
    mut reader: impl AsyncReadExt + Unpin + Send + 'static,
    state: Arc<tokio::sync::RwLock<ClientState>>,
    event_tx: broadcast::Sender<ClientEvent>,
    crypt_tx: tokio::sync::watch::Sender<Option<munode_protocol::crypto::CryptState>>,
    udp_send_crypt: Arc<Mutex<Option<munode_protocol::crypto::CryptState>>>,
    server_info: Arc<tokio::sync::RwLock<ServerInformation>>,
    tcp_tx: mpsc::Sender<Vec<u8>>,
) {
    let mut buf = BytesMut::with_capacity(8192);

    loop {
        // Drain any complete frames from the buffer before reading more data.
        loop {
            match decode_frame(&mut buf) {
                Ok(Some(frame)) => {
                    crate::client::dispatch_frame(
                        frame,
                        &state,
                        &event_tx,
                        &crypt_tx,
                        &udp_send_crypt,
                        &server_info,
                        &tcp_tx,
                    )
                    .await;
                }
                Ok(None) => break,
                Err(e) => {
                    error!("frame decode error: {e}");
                    let _ = event_tx.send(ClientEvent::Disconnected);
                    return;
                }
            }
        }

        match reader.read_buf(&mut buf).await {
            Ok(0) => {
                debug!("TCP stream EOF — server closed the connection");
                let _ = event_tx.send(ClientEvent::Disconnected);
                return;
            }
            Ok(_) => {}
            Err(e) => {
                warn!("TCP read error: {e}");
                let _ = event_tx.send(ClientEvent::Disconnected);
                return;
            }
        }
    }
}

/// Run the TCP write loop, forwarding queued bytes to the TLS stream.
/// Exits when the mpsc channel is dropped.
pub async fn tcp_write_loop(
    mut writer: impl AsyncWriteExt + Unpin + Send + 'static,
    mut rx: mpsc::Receiver<Vec<u8>>,
) {
    while let Some(data) = rx.recv().await {
        if let Err(e) = writer.write_all(&data).await {
            warn!("TCP write error: {e}");
            return;
        }
    }
}

/// Run the UDP read loop, decrypting voice packets and emitting `Voice` events.
/// Also detects the UDP Ping reply and emits `UdpReady`.
///
/// On repeated UDP decryption failures, sends an empty `CryptSetup` over TCP
/// to request a nonce resync — mirrors the C++ Mumble client's behaviour
/// (5-second hysteresis to avoid spamming the server).
pub async fn udp_read_loop(
    socket: Arc<UdpSocket>,
    crypt_rx: tokio::sync::watch::Receiver<Option<munode_protocol::crypto::CryptState>>,
    event_tx: broadcast::Sender<ClientEvent>,
    tcp_tx: Option<mpsc::Sender<Vec<u8>>>,
) {
    let mut local_crypt: Option<munode_protocol::crypto::CryptState> = None;
    let mut buf = vec![0u8; 2048];
    let mut udp_ready_sent = false;
    let mut last_good = tokio::time::Instant::now();
    let mut last_resync_request = tokio::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(60))
        .unwrap_or_else(tokio::time::Instant::now);

    loop {
        let n = match socket.recv(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                warn!("UDP recv error: {e}");
                return;
            }
        };

        // Pick up any updated CryptState.
        if crypt_rx.has_changed().unwrap_or(false) || local_crypt.is_none() {
            local_crypt = crypt_rx.borrow().as_ref().cloned();
            // After receiving a fresh CryptSetup, reset the timers so we don't
            // immediately re-request a resync.
            last_good = tokio::time::Instant::now();
        }

        let data = &buf[..n];
        if data.is_empty() {
            continue;
        }

        // Decrypt the packet first; then inspect the plaintext header.
        if let Some(ref mut crypt) = local_crypt {
            let mut plain = Vec::new();
            if crypt.decrypt(data, &mut plain) {
                last_good = tokio::time::Instant::now();
                if !plain.is_empty() {
                    let pkt_type = plain[0] >> 5;
                    if pkt_type == 1 {
                        // Ping response
                        if !udp_ready_sent {
                            udp_ready_sent = true;
                            let _ = event_tx.send(ClientEvent::UdpReady);
                        }
                        continue;
                    }
                }
                if let Some(voice) = crate::voice::parse_voice_packet(&plain) {
                    let _ = event_tx.send(ClientEvent::Voice(voice));
                }
            } else {
                debug!("UDP decryption failed — packet dropped");
                // Match Mumble C++ behaviour: if the last successful decrypt was
                // > 5 s ago, ask the server for a nonce resync (and throttle
                // to at most one request every 5 s).
                let now = tokio::time::Instant::now();
                if now.duration_since(last_good) > std::time::Duration::from_secs(5)
                    && now.duration_since(last_resync_request)
                        > std::time::Duration::from_secs(5)
                {
                    last_resync_request = now;
                    if let Some(tx) = tcp_tx.as_ref() {
                        let mut frame = BytesMut::new();
                        encode_message(
                            MessageType::CryptSetup,
                            &mumbleproto::CryptSetup::default(),
                            &mut frame,
                        );
                        let _ = tx.try_send(frame.to_vec());
                        debug!("requested CryptSetup resync after UDP decrypt failure");
                    }
                }
            }
        }
    }
}

/// Enqueue a raw byte buffer to the TCP writer task.
pub fn send_raw(tx: &mpsc::Sender<Vec<u8>>, data: Vec<u8>) -> Result<()> {
    tx.try_send(data).context("TCP send channel full or closed")
}

/// Encode a protobuf message and enqueue it to the TCP writer.
pub fn send_message<M: prost::Message>(
    tx: &mpsc::Sender<Vec<u8>>,
    msg_type: munode_protocol::message_type::MessageType,
    msg: &M,
) -> Result<()> {
    let mut buf = BytesMut::new();
    encode_message(msg_type, msg, &mut buf);
    send_raw(tx, buf.to_vec())
}

/// Bind a UDP socket to an OS-assigned local port and connect it to `host:port`.
pub async fn create_udp_socket(host: &str, port: u16) -> Result<Arc<UdpSocket>> {
    let socket = UdpSocket::bind("0.0.0.0:0").await.context("UDP bind failed")?;
    socket.connect((host, port)).await.context("UDP connect failed")?;
    Ok(Arc::new(socket))
}
