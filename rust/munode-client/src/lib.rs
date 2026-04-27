//! MuNode Mumble client library.
//!
//! Provides [`MumbleClient`], a fully async, headless-capable Mumble protocol
//! client that connects to a MuNode (or any standard Mumble) Edge server via
//! TLS/TCP and optionally UDP.
//!
//! # Architecture
//!
//! The client is `Clone + Send + Sync` — it wraps an `Arc<ClientInner>` so
//! multiple handles can be passed to different tasks.  All state mutations go
//! through `tokio::sync::RwLock`.  Background tasks (TCP reader, TCP writer,
//! UDP reader, keepalive ping) are spawned inside `connect()` and cancelled
//! via a `CancellationToken` on `disconnect()`.
//!
//! # Example
//!
//! ```no_run
//! use munode_client::{MumbleClient, ConnectOptions};
//! use std::time::Duration;
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let client = MumbleClient::new();
//!     client.connect(ConnectOptions {
//!         host: "localhost".into(),
//!         port: 64738,
//!         username: "user1".into(),
//!         password: Some("password1".into()),
//!         ..Default::default()
//!     }).await?;
//!
//!     let session = client.session().unwrap();
//!     println!("Connected as session {}", session.session);
//!
//!     client.disconnect().await?;
//!     Ok(())
//! }
//! ```

pub mod client;
pub mod connection;
pub mod crypto;
pub mod domain;
pub mod error;
pub mod events;
pub mod handles;
pub mod state;
pub mod voice;

pub use client::{ClientCertificate, ConnectOptions, MumbleClient, PreConnectState};
pub use domain::{
    Ban, ContextActionInfo, DenyReason, RegisteredUser, RejectType, ServerInformation,
};
pub use error::ClientError;
pub use events::ClientEvent;
pub use handles::{Acl, ChannelRef, Me, Server, UserRef, Voice};
pub use state::{Channel, ConnectionState, SessionState, User};
pub use voice::{VoiceData, build_voice_packet, parse_voice_packet};
