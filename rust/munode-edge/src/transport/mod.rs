//! Transport abstraction for the Edge server.
//!
//! Provides a unified `TransportKind` enum that tells the shared connection-loop code
//! which underlying transport is in use, plus factory helpers that set up each transport
//! and return a boxed `AsyncRead` reader + a spawned writer task.
//!
//! Supported transports:
//! - `Tls`           — native Mumble TLS/TCP (always available)
//! - `WebTransport`  — QUIC/HTTP3 WebTransport (feature `"webtransport"`)
//! - `WebSocket`     — plain WebSocket fallback over TCP (feature `"ws-transport"`)

#[cfg(feature = "webtransport")]
pub mod webtransport;

#[cfg(feature = "ws-transport")]
pub mod ws;

/// Which transport was used to accept a connection.
///
/// Used throughout the connection loop to make transport-specific decisions
/// (e.g. skipping `CryptSetup` for non-TLS transports that provide AEAD encryption
/// at the transport layer).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportKind {
    /// Native Mumble TLS/TCP.  CryptSetup is sent; OCB2-AES128 is used for UDP.
    Tls,
    /// WebTransport (QUIC/HTTP3).  CryptSetup is skipped; QUIC provides TLS 1.3 AEAD.
    #[cfg(feature = "webtransport")]
    WebTransport,
    /// WebSocket fallback over TLS (wss://).  CryptSetup is skipped; TLS provides
    /// transport security.  Voice uses UdpTunnel frames over the WebSocket connection.
    #[cfg(feature = "ws-transport")]
    WebSocket,
}

impl TransportKind {
    /// Returns `true` for transports that provide their own transport-layer encryption
    /// (WebTransport, WebSocket-over-TLS).  These transports do NOT need OCB2-AES128
    /// UDP encryption, so `CryptSetup` is omitted from the login sequence.
    pub fn skip_crypt_setup(self) -> bool {
        match self {
            TransportKind::Tls => false,
            #[cfg(feature = "webtransport")]
            TransportKind::WebTransport => true,
            #[cfg(feature = "ws-transport")]
            TransportKind::WebSocket => true,
        }
    }
}
