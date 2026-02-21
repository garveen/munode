use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use bytes::BytesMut;
use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info};

use munode_common::config::EdgeConfig;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::{decode_frame, encode_message};

use crate::client::{ClientInfo, ClientManager, ClientState};
use crate::hub_client::HubClient;
use crate::tls::create_tls_acceptor;
use crate::udp::UdpServer;

/// The main Edge server.
pub struct EdgeServer {
    config: EdgeConfig,
}

impl EdgeServer {
    pub fn new(config: EdgeConfig) -> Self {
        Self { config }
    }

    /// Run the edge server.
    pub async fn run(&self) -> Result<()> {
        let client_manager = ClientManager::new();

        // Set up TLS
        let tls_acceptor = create_tls_acceptor(&self.config.tls)?;

        // Start UDP server
        let udp_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let udp_server = UdpServer::new(udp_addr).await?;
        let udp_handle = tokio::spawn(async move {
            if let Err(e) = udp_server.run().await {
                error!("UDP server error: {}", e);
            }
        });

        // Connect to Hub
        let hub_client = HubClient::new(
            &self.config.hub_server,
            self.config.server_id,
            &self.config.name,
        );
        let hub_handle = tokio::spawn({
            let hub_client = hub_client.clone();
            async move {
                if let Err(e) = hub_client.connect_and_run().await {
                    error!("Hub client error: {}", e);
                }
            }
        });

        // Start TLS server
        let listen_addr: SocketAddr = format!("{}:{}", self.config.network.host, self.config.network.port)
            .parse()?;
        let listener = TcpListener::bind(listen_addr).await?;
        info!("TLS server listening on {}", listen_addr);

        let (_shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        // Accept loop
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, peer_addr)) => {
                            let acceptor = tls_acceptor.clone();
                            let manager = client_manager.clone();
                            let config = self.config.clone();
                            let hub = hub_client.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_tls_connection(
                                    stream, peer_addr, acceptor, manager, &config, hub,
                                ).await {
                                    debug!("Client connection error from {}: {}", peer_addr, e);
                                }
                            });
                        }
                        Err(e) => {
                            error!("Accept error: {}", e);
                        }
                    }
                }
                _ = shutdown_rx.recv() => {
                    info!("Shutting down edge server");
                    break;
                }
                _ = tokio::signal::ctrl_c() => {
                    info!("Received shutdown signal");
                    break;
                }
            }
        }

        udp_handle.abort();
        hub_handle.abort();

        Ok(())
    }
}

/// Handle a single TLS client connection.
async fn handle_tls_connection(
    stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    acceptor: TlsAcceptor,
    client_manager: Arc<ClientManager>,
    config: &EdgeConfig,
    _hub_client: Arc<HubClient>,
) -> Result<()> {
    info!("New TCP connection from {}", peer_addr);

    let tls_stream = acceptor.accept(stream).await?;
    let (mut reader, mut writer) = tokio::io::split(tls_stream);

    info!("TLS handshake complete with {}", peer_addr);

    let mut buf = BytesMut::with_capacity(8192);
    let mut session_id: Option<u32> = None;

    loop {
        // Read data from TLS stream
        let n = reader.read_buf(&mut buf).await?;
        if n == 0 {
            info!("Client {} disconnected", peer_addr);
            break;
        }

        // Process all complete frames in the buffer
        while let Some(frame) = decode_frame(&mut buf)? {
            match frame.message_type {
                MessageType::Version => {
                    let version = mumbleproto::Version::decode(&frame.payload[..])?;
                    info!(
                        "Client {} version: {:?} release={:?}",
                        peer_addr,
                        version.version,
                        version.release
                    );

                    // Send our version back
                    let server_version = mumbleproto::Version {
                        version: Some(0x0001_0500), // 1.5.0
                        release: Some("MuNode-Rust 0.1.0".into()),
                        os: Some(std::env::consts::OS.into()),
                        os_version: Some(String::new()),
                    };
                    let mut response = BytesMut::new();
                    encode_message(MessageType::Version, &server_version, &mut response);
                    writer.write_all(&response).await?;
                }
                MessageType::Authenticate => {
                    let auth = mumbleproto::Authenticate::decode(&frame.payload[..])?;
                    info!(
                        "Authentication request from {}: username={:?}",
                        peer_addr,
                        auth.username
                    );

                    // TODO: Forward to Hub for actual authentication
                    // For now, create a placeholder session
                    let sid = 1; // Hub should allocate this
                    session_id = Some(sid);

                    let client = ClientInfo {
                        session: sid,
                        user_id: 0,
                        username: auth.username.unwrap_or_default(),
                        channel_id: config.server.default_channel,
                        state: ClientState::Connected,
                        mute: false,
                        deaf: false,
                        suppress: false,
                        self_mute: false,
                        self_deaf: false,
                        priority_speaker: false,
                        recording: false,
                        ip_address: peer_addr.ip().to_string(),
                        connected_at: std::time::Instant::now(),
                        last_active: std::time::Instant::now(),
                        cert_hash: None,
                        groups: vec![],
                    };
                    client_manager.add_client(client).await;

                    // TODO: Send CryptSetup, ChannelState, UserState, ServerSync etc.
                    // This will be implemented when Hub authentication is wired up
                }
                MessageType::Ping => {
                    let ping = mumbleproto::Ping::decode(&frame.payload[..])?;
                    // Echo the ping back
                    let mut response = BytesMut::new();
                    encode_message(MessageType::Ping, &ping, &mut response);
                    writer.write_all(&response).await?;
                }
                MessageType::UdpTunnel => {
                    // Voice data tunneled through TCP
                    debug!("TCP voice packet from {}", peer_addr);
                    // TODO: Route to VoiceRouter
                }
                other => {
                    debug!("Unhandled message type {:?} from {}", other, peer_addr);
                    // TODO: Implement remaining message handlers
                }
            }
        }
    }

    // Cleanup
    if let Some(sid) = session_id {
        client_manager.remove_client(sid).await;
        info!("Cleaned up session {} for {}", sid, peer_addr);
    }

    Ok(())
}
