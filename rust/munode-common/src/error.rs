use thiserror::Error;

/// Common error types for MuNode.
#[derive(Error, Debug)]
pub enum MunodeError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("TLS error: {0}")]
    Tls(String),
    #[error("connection error: {0}")]
    Connection(String),
    #[error("authentication error: {0}")]
    Authentication(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("hub communication error: {0}")]
    Hub(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
