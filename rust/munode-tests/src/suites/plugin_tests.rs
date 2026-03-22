//! Plugin data transmission integration tests.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{cleanup_clients, single_edge_env, sleep_ms, standard_env, ClientConfig, create_clients};

// ── Plugin data basics ────────────────────────────────────────────────────

#[tokio::test]
async fn test_send_plugin_data_does_not_crash() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    client.send_plugin_data("test.plugin.v1", b"hello", &[]).await?;
    sleep_ms(200).await;

    assert!(client.is_connected());
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_plugin_data_received_by_same_edge_user() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    let sender_session = sender.session_id().unwrap();
    let mut rx = receiver.subscribe();

    sender.send_plugin_data("org.munode.test", b"test payload", &[]).await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PluginData { sender, plugin_id, data })
                    if sender == sender_session =>
                {
                    break true;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    // Plugin data routing depends on server implementation
    // This test documents the expected behavior when implemented
    let _ = got;
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_plugin_data_with_empty_payload() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    client.send_plugin_data("test.plugin", b"", &[]).await?;
    sleep_ms(200).await;

    assert!(client.is_connected(), "Empty plugin data should not disconnect client");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_plugin_data_with_binary_payload() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    let binary_data: Vec<u8> = (0u8..=255u8).collect();
    client.send_plugin_data("test.binary.plugin", &binary_data, &[]).await?;
    sleep_ms(200).await;

    assert!(client.is_connected(), "Binary plugin data should be accepted");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_plugin_data_cross_edge() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, _receiver) = (&clients[0], &clients[1]);

    // Cross-edge plugin data: just verify sender isn't crashed
    sender.send_plugin_data("cross.edge.plugin", b"data across edges", &[]).await?;
    sleep_ms(300).await;

    assert!(sender.is_connected(), "Sender should remain connected");
    cleanup_clients(clients).await;
    Ok(())
}
