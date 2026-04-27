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

    let user1_session = user1.session_id().unwrap();
    let mut rx = observer.subscribe();

    user1.me().add_listener(1).await?; // Listen to Lobby

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

    let user1_session = user1.session_id().unwrap();
    let mut rx = observer.subscribe();

    user1.me().add_listener(1).await?;

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
    client.me().add_listener(1).await?;
    sleep_ms(200).await;
    client.me().remove_listener(1).await?;
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

    speaker.channel(1).join().await?;   // Lobby
    listener.channel(2).join().await?;  // General
    sleep_ms(200).await;

    listener.me().add_listener(1).await?; // Listen to Lobby
    sleep_ms(300).await;

    let speaker_session = speaker.session_id().unwrap();
    let mut rx = listener.subscribe();

    let audio = crate::harness::random_voice_data(20);
    speaker.voice().send(4, 0, 1, &audio).await?;

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

    client.channel(0).join().await?; // Root
    sleep_ms(200).await;

    // Add multiple listeners
    client.me().add_listener(1).await?; // Lobby
    client.me().add_listener(2).await?; // General
    client.me().add_listener(3).await?; // Private
    sleep_ms(200).await;

    assert!(client.is_connected(), "Should still be connected after adding multiple listeners");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Listener + linked channels ────────────────────────────────────────────

/// A listener of channel L must hear voice from any channel linked to L,
/// because a regular member of L would hear it.  Regression test for the
/// "听不到链接频道声音" report.
#[tokio::test]
async fn test_listener_receives_voice_from_linked_channel() -> Result<()> {
    use munode_protocol::mumbleproto;

    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, speaker, listener) = (&clients[0], &clients[1], &clients[2]);

    // Create two sibling channels and link them.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let ch_a = admin.channel(0).create_subchannel(&format!("LinkSpeak_{ts}")).await?;
    let ch_b = admin.channel(0).create_subchannel(&format!("LinkListen_{ts}")).await?;
    sleep_ms(400).await;

    admin.send_channel_state(mumbleproto::ChannelState {
        channel_id: Some(ch_a),
        links_add: vec![ch_b],
        ..Default::default()
    }).await?;
    sleep_ms(400).await;

    // Speaker joins ch_a; listener stays in root (ch 0) and listens to ch_b.
    speaker.channel(ch_a).join().await?;
    listener.me().add_listener(ch_b).await?;
    sleep_ms(400).await;

    let speaker_session = speaker.session_id().unwrap();
    let mut rx = listener.subscribe();

    let audio = crate::harness::random_voice_data(20);
    speaker.voice().send(4, 0, 1, &audio).await?;

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

    assert!(received,
        "Listener of ch_b should hear voice from ch_a because ch_a↔ch_b are linked");
    cleanup_clients(clients).await;
    Ok(())
}
