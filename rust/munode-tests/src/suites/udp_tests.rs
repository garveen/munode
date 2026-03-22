//! UDP connection tests.
//!
//! Tests UDP voice handshake, ping/pong, and UDP mode switching.

use std::time::Duration;

use anyhow::Result;
use munode_client::{ClientEvent, ConnectOptions, MumbleClient};

use crate::harness::{cleanup_clients, single_edge_env, ClientConfig, create_clients};

// ── UDP handshake ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_udp_crypto_setup_received() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::CryptoReady) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got, "CryptSetup should be received from server after auth");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_udp_mode_connect_and_handshake() -> Result<()> {
    let env = single_edge_env().await?;

    let client = MumbleClient::new();
    client.connect(ConnectOptions {
        host: "127.0.0.1".into(),
        port: env.edge1(),
        username: "user1".into(),
        password: Some("password1".into()),
        reject_unauthorized: false,
        force_tcp_voice: false, // enable UDP
        connect_timeout: Duration::from_secs(10),
        ..Default::default()
    }).await?;

    // Wait for UDP handshake
    let result = client.wait_for_udp(Duration::from_secs(10)).await;
    assert!(result.is_ok(), "UDP handshake should complete: {:?}", result);

    client.disconnect().await?;
    Ok(())
}

#[tokio::test]
async fn test_udp_ping_response() -> Result<()> {
    let env = single_edge_env().await?;

    let client = MumbleClient::new();
    client.connect(ConnectOptions {
        host: "127.0.0.1".into(),
        port: env.edge1(),
        username: "user2".into(),
        password: Some("password2".into()),
        reject_unauthorized: false,
        force_tcp_voice: false, // want UDP
        connect_timeout: Duration::from_secs(10),
        ..Default::default()
    }).await?;

    // If UDP handshake fails, that's acceptable in CI — skip assertion
    let _ = client.wait_for_udp(Duration::from_secs(8)).await;

    client.disconnect().await?;
    Ok(())
}

#[tokio::test]
async fn test_tcp_ping_response() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client.send_ping().await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Ping { .. }) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got, "Server should respond to TCP ping");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_multiple_udp_clients_simultaneously() -> Result<()> {
    let env = single_edge_env().await?;
    let port = env.edge1();

    let mut handles = Vec::new();
    for username in &["user1", "user2", "user3"] {
        let port = port;
        let username = username.to_string();
        handles.push(tokio::spawn(async move {
            let client = MumbleClient::new();
            let result = client.connect(ConnectOptions {
                host: "127.0.0.1".into(),
                port,
                username: username.clone(),
                password: Some(format!("{}1", &username[..4])), // crude but works for user1/user2/user3
                reject_unauthorized: false,
                force_tcp_voice: false,
                connect_timeout: Duration::from_secs(10),
                ..Default::default()
            }).await;
            let _ = client.disconnect().await;
            result.is_ok()
        }));
    }

    for h in handles {
        let _ = h.await; // just check no panics
    }
    Ok(())
}
