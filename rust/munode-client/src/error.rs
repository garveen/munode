//! Typed error enum for the Mumble client.

use thiserror::Error;

/// Errors that can occur during client operation.
#[derive(Error, Debug, Clone)]
pub enum ClientError {
    /// The server rejected the authentication attempt.
    #[error("authentication rejected: {reason}")]
    AuthRejected { reason: String },

    /// The connection timed out.
    #[error("connection timed out after {secs}s")]
    Timeout { secs: u64 },

    /// The client is not connected.
    #[error("not connected")]
    NotConnected,

    /// The client is already connected.
    #[error("already connected")]
    AlreadyConnected,

    /// A send channel was closed unexpectedly.
    #[error("send channel closed")]
    ChannelClosed,

    /// The server sent an unexpected or malformed message.
    #[error("protocol error: {detail}")]
    Protocol { detail: String },

    /// TLS or network I/O error (message only, not the original error, for `Clone`-ability).
    #[error("I/O error: {detail}")]
    Io { detail: String },
}

impl ClientError {
    #[allow(dead_code)]
    pub(crate) fn io(e: impl std::fmt::Display) -> Self {
        ClientError::Io {
            detail: e.to_string(),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn protocol(detail: impl Into<String>) -> Self {
        ClientError::Protocol {
            detail: detail.into(),
        }
    }
}
