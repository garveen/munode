use thiserror::Error;

// ── Low-level source error types ────────────────────────────────────────────

/// Configuration-related error.
#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("missing required field: {field}")]
    MissingField { field: &'static str },
    #[error("invalid value for '{field}': {reason}")]
    InvalidValue { field: &'static str, reason: String },
    #[error("failed to read config file '{path}': {source}")]
    ReadFailed { path: String, source: std::io::Error },
    #[error("TOML parse error in '{path}': {source}")]
    ParseError { path: String, source: toml::de::Error },
    #[error("{0}")]
    Other(String),
}

/// TLS setup error.
#[derive(Error, Debug)]
pub enum TlsError {
    #[error("failed to open certificate file '{path}': {source}")]
    CertFileOpen { path: String, source: std::io::Error },
    #[error("failed to parse certificate in '{path}': {source}")]
    CertParse { path: String, source: std::io::Error },
    #[error("no certificates found in '{path}'")]
    NoCerts { path: String },
    #[error("failed to open key file '{path}': {source}")]
    KeyFileOpen { path: String, source: std::io::Error },
    #[error("failed to parse private key in '{path}'")]
    KeyParse { path: String },
    #[error("no private key found in '{path}'")]
    NoKey { path: String },
    #[error("failed to build TLS server config: {0}")]
    ServerConfig(String),
    #[error("{0}")]
    Other(String),
}

/// Hub/Edge connection error.
#[derive(Error, Debug)]
pub enum ConnectionError {
    #[error("WebSocket connect failed to '{addr}': {source}")]
    WebSocket {
        addr: String,
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("send failed: {0}")]
    Send(String),
    #[error("receive failed: {0}")]
    Receive(String),
    #[error("connection closed unexpectedly")]
    Closed,
    #[error("{0}")]
    Other(String),
}

/// Authentication error.
#[derive(Error, Debug)]
pub enum AuthError {
    #[error("invalid credentials for user '{username}'")]
    InvalidCredentials { username: String },
    #[error("user '{username}' is banned: {reason}")]
    Banned { username: String, reason: String },
    #[error("user '{username}' not registered")]
    NotRegistered { username: String },
    #[error("authentication backend unavailable: {source}")]
    BackendUnavailable {
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("{0}")]
    Other(String),
}

/// Mumble wire-protocol error.
#[derive(Error, Debug)]
pub enum ProtocolError {
    #[error("unknown message type: {type_id}")]
    UnknownMessageType { type_id: u16 },
    #[error("message too large: {size} bytes (limit {limit})")]
    MessageTooLarge { size: usize, limit: usize },
    #[error("protobuf decode error for message type {type_name}: {source}")]
    Decode {
        type_name: &'static str,
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("missing required field '{field}' in {message}")]
    MissingField {
        message: &'static str,
        field: &'static str,
    },
    #[error("{0}")]
    Other(String),
}

/// Hub RPC communication error.
#[derive(Error, Debug)]
pub enum HubError {
    #[error("RPC call '{method}' timed out after {timeout_ms} ms")]
    Timeout { method: String, timeout_ms: u64 },
    #[error("Hub returned error for '{method}': {message}")]
    RemoteError { method: String, message: String },
    #[error("Hub is not connected")]
    NotConnected,
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

// ── Top-level error type ─────────────────────────────────────────────────────

/// Top-level error type for MuNode.
///
/// Each variant wraps a typed sub-error so that callers can pattern-match on
/// specific failure causes rather than parsing a `String`.
#[derive(Error, Debug)]
pub enum MunodeError {
    #[error("configuration error: {0}")]
    Config(#[from] ConfigError),
    #[error("TLS error: {0}")]
    Tls(#[from] TlsError),
    #[error("connection error: {0}")]
    Connection(#[from] ConnectionError),
    #[error("authentication error: {0}")]
    Authentication(#[from] AuthError),
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("hub communication error: {0}")]
    Hub(#[from] HubError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
