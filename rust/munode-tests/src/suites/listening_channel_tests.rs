//! Listening channel integration tests.
//!
//! Tests: add/remove listening channels, cross-edge broadcast, voice reception.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{
    cleanup_clients, single_edge_env, sleep_ms, standard_env, ClientConfig, create_clients,
};

// ── Add listening channel ─────────────────────────────────────────────────

#[tokio::test]
async fn test_add_listening_channel_broadcasts_to_same_edge() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1), // observer
    ];
    let clients = create_clients(&env, &configs).await?;
    let (user1, observer) = (&clients[0], &clients[1]);

    let user1_session = user1.session_id().await.unwrap();
    let mut rx = observer.subscribe();

    user1.add_listening_channel(1).await?; // Listen to Lobby

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u))
                    if u.session == user1_session =>
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

    assert!(got, "Adding listening channel should broadcast UserState to observers");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_add_listening_channel_broadcasts_cross_edge() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 2), // cross-edge observer
    ];
    let clients = create_clients(&env, &configs).await?;
    let (user1, observer) = (&clients[0], &clients[1]);
    sleep_ms(500).await;

    let user1_session = user1.session_id().await.unwrap();
    let mut rx = observer.subscribe();

    user1.add_listening_channel(1).await?;

    let got = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u))
                    if u.session == user1_session =>
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

    assert!(got, "Listening channel add should propagate cross-edge");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Remove listening channel ──────────────────────────────────────────────

#[tokio::test]
async fn test_remove_listening_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    // Add then remove
    client.add_listening_channel(1).await?;
    sleep_ms(200).await;
    client.remove_listening_channel(1).await?;
    sleep_ms(200).await;

    // Should not crash and still be connected
    assert!(client.is_connected());
    cleanup_clients(clients).await;
    Ok(())
}

// ── Voice routing through listened channel ────────────────────────────────

#[tokio::test]
async fn test_listener_receives_voice_from_listened_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1), // speaker in Lobby
        ClientConfig::new("user2", 1), // listener in General, listens to Lobby
    ];
    let clients = create_clients(&env, &configs).await?;
    let (speaker, listener) = (&clients[0], &clients[1]);

    speaker.join_channel(1).await?;   // Lobby
    listener.join_channel(2).await?;  // General
    sleep_ms(200).await;

    listener.add_listening_channel(1).await?; // Listen to Lobby
    sleep_ms(300).await;

    let speaker_session = speaker.session_id().await.unwrap();
    let mut rx = listener.subscribe_voice();

    let audio = crate::harness::random_voice_data(20);
    speaker.send_voice(4, 0, 1, &audio).await?;

    let received = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == speaker_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(received, "Listener should receive voice from a listened channel");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Multiple listening channels ───────────────────────────────────────────

#[tokio::test]
async fn test_add_multiple_listening_channels() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    client.join_channel(0).await?; // Root
    sleep_ms(200).await;

    // Add multiple listeners
    client.add_listening_channel(1).await?; // Lobby
    client.add_listening_channel(2).await?; // General
    client.add_listening_channel(3).await?; // Private
    sleep_ms(200).await;

    assert!(client.is_connected(), "Should still be connected after adding multiple listeners");
    cleanup_clients(clients).await;
    Ok(())
}
