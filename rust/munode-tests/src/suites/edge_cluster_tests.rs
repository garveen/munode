//! Edge cluster integration tests.
//!
//! Tests cover multi-Edge topology: user visibility across edges, channel
//! synchronization, text message propagation, and user state broadcast.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{
    cleanup_clients, four_edge_env, single_edge_env, standard_env, sleep_ms,
    ClientConfig, TestEnvBuilder, create_clients,
};

// ── Edge registration ─────────────────────────────────────────────────────

/// Both edges in a standard environment should be reachable and accept
/// client connections after startup.
#[tokio::test]
async fn test_two_edges_accept_connections() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user_edge1", 1),
        ClientConfig::new("user_edge2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;

    assert!(clients[0].is_connected(), "Edge 1 should accept connections");
    assert!(clients[1].is_connected(), "Edge 2 should accept connections");

    cleanup_clients(clients).await;
    Ok(())
}

/// A user connected to Edge 2 should be visible (via user list) to a client
/// on Edge 1.
#[tokio::test]
async fn test_users_visible_across_edges() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user_edge1", 1),
        ClientConfig::new("user_edge2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (e1_client, e2_client) = (&clients[0], &clients[1]);

    // Give the cluster a moment to propagate sessions
    sleep_ms(800).await;

    let e2_session = e2_client.session_id().await.unwrap();
    let e1_users = e1_client.users().await;

    let saw_e2_user = e1_users.iter().any(|u| u.session == e2_session);
    assert!(
        saw_e2_user,
        "User on Edge 2 should be visible to clients on Edge 1"
    );

    cleanup_clients(clients).await;
    Ok(())
}

/// A user connected to Edge 1 should also appear in the user list seen by
/// a client on Edge 2.
#[tokio::test]
async fn test_users_visible_bidirectionally() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user_edge1", 1),
        ClientConfig::new("user_edge2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (e1_client, e2_client) = (&clients[0], &clients[1]);

    sleep_ms(800).await;

    let e1_session = e1_client.session_id().await.unwrap();
    let e2_users = e2_client.users().await;

    let saw_e1_user = e2_users.iter().any(|u| u.session == e1_session);
    assert!(
        saw_e1_user,
        "User on Edge 1 should be visible to clients on Edge 2"
    );

    cleanup_clients(clients).await;
    Ok(())
}

// ── Channel synchronisation ───────────────────────────────────────────────

/// The same default channel list should be visible to clients on both edges.
#[tokio::test]
async fn test_channels_synced_across_edges() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user_edge1", 1),
        ClientConfig::new("user_edge2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (e1_client, e2_client) = (&clients[0], &clients[1]);

    let e1_channels: Vec<_> = e1_client.channels().await;
    let e2_channels: Vec<_> = e2_client.channels().await;

    assert!(!e1_channels.is_empty(), "Edge 1 client should see channels");
    assert!(!e2_channels.is_empty(), "Edge 2 client should see channels");
    assert_eq!(
        e1_channels.len(),
        e2_channels.len(),
        "Both edges should sync the same channel count"
    );

    cleanup_clients(clients).await;
    Ok(())
}

/// A channel created via Edge 1 should be propagated to Edge 2 so that a
/// client on Edge 2 sees it.
#[tokio::test]
async fn test_new_channel_propagates_across_edges() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (creator, observer) = (&clients[0], &clients[1]);

    let mut obs_rx = observer.subscribe();
    let ch_id = creator.create_channel(0, "ClusterSyncChannel").await?;

    // Observer on Edge 2 should receive ChannelCreated
    let ch_created = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match obs_rx.recv().await {
                Ok(ClientEvent::ChannelCreated(ch)) if ch.channel_id == ch_id => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        ch_created,
        "Channel created on Edge 1 should propagate to Edge 2"
    );

    cleanup_clients(clients).await;
    Ok(())
}

// ── User state propagation ────────────────────────────────────────────────

/// When a user on Edge 1 mutes themselves, the updated state should reach a
/// client on Edge 2.
#[tokio::test]
async fn test_user_state_propagates_across_edges() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user_edge1", 1),
        ClientConfig::new("user_edge2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (e1_client, e2_client) = (&clients[0], &clients[1]);

    // Wait for initial full-sync to settle
    sleep_ms(500).await;

    let e1_session = e1_client.session_id().await.unwrap();
    let mut e2_rx = e2_client.subscribe();

    e1_client.set_self_mute(true).await?;

    let state_updated = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match e2_rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u)) if u.session == e1_session && u.self_mute => {
                    break true
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        state_updated,
        "Self-mute from Edge 1 should reach Edge 2"
    );

    cleanup_clients(clients).await;
    Ok(())
}

// ── Text message routing ──────────────────────────────────────────────────

/// A channel text message sent from Edge 1 should arrive at a client on
/// Edge 2 who is in the same channel.
#[tokio::test]
async fn test_text_message_routes_across_edges() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user_edge1", 1),
        ClientConfig::new("user_edge2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    // Move both into the same channel
    sender.join_channel(1).await?;
    receiver.join_channel(1).await?;
    sleep_ms(400).await;

    let mut rx = receiver.subscribe();
    sender.send_text_to_channel(1, "cluster-text-test").await?;

    let received = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::TextMessage { message, .. })
                    if message == "cluster-text-test" =>
                {
                    break true
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(received, "Text message should route from Edge 1 to Edge 2");
    cleanup_clients(clients).await;
    Ok(())
}

// ── User leave propagation ────────────────────────────────────────────────

/// When a user on Edge 2 disconnects, a client on Edge 1 should see a
/// UserLeft event.
#[tokio::test]
async fn test_user_leave_propagates_across_edges() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user_edge1", 1),
        ClientConfig::new("user_edge2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (e1_client, e2_client) = (&clients[0], &clients[1]);

    sleep_ms(500).await;

    let e2_session = e2_client.session_id().await.unwrap();
    let mut e1_rx = e1_client.subscribe();

    e2_client.disconnect().await?;

    let saw_leave = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match e1_rx.recv().await {
                Ok(ClientEvent::UserLeft { session, .. }) if session == e2_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        saw_leave,
        "Edge 1 should see UserLeft when Edge 2 user disconnects"
    );

    let _ = e1_client.disconnect().await;
    Ok(())
}

// ── Four-Edge cluster ─────────────────────────────────────────────────────

/// All four edges accept connections simultaneously.
#[tokio::test]
async fn test_four_edge_all_accept_connections() -> Result<()> {
    let env = four_edge_env().await?;
    let configs = vec![
        ClientConfig::new("multi_edge_e1", 1),
        ClientConfig::new("multi_edge_e2", 2),
        ClientConfig::new("multi_edge_e3", 3),
        ClientConfig::new("multi_edge_e4", 4),
    ];
    let clients = create_clients(&env, &configs).await?;

    for (i, client) in clients.iter().enumerate() {
        assert!(
            client.is_connected(),
            "Edge {} client should be connected",
            i + 1
        );
    }

    cleanup_clients(clients).await;
    Ok(())
}

/// A user on every edge should be visible to a user on Edge 1 after all
/// edges have registered with the Hub.
#[tokio::test]
async fn test_four_edge_all_users_visible_from_edge1() -> Result<()> {
    let env = four_edge_env().await?;
    let configs = vec![
        ClientConfig::new("multi_edge_e1", 1),
        ClientConfig::new("multi_edge_e2", 2),
        ClientConfig::new("multi_edge_e3", 3),
        ClientConfig::new("multi_edge_e4", 4),
    ];
    let clients = create_clients(&env, &configs).await?;

    sleep_ms(1000).await;

    let e1 = &clients[0];
    let e1_users = e1.users().await;

    for (i, other) in clients[1..].iter().enumerate() {
        let session = other.session_id().await.unwrap();
        let found = e1_users.iter().any(|u| u.session == session);
        assert!(
            found,
            "Edge {} user (session {}) should be visible from Edge 1",
            i + 2,
            session
        );
    }

    cleanup_clients(clients).await;
    Ok(())
}

// ── Single-Edge baseline ──────────────────────────────────────────────────

/// In a single-edge environment, multiple users connect to the same edge and
/// see each other.
#[tokio::test]
async fn test_single_edge_multi_user_visibility() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (a, b) = (&clients[0], &clients[1]);

    sleep_ms(300).await;

    let b_session = b.session_id().await.unwrap();
    let a_users = a.users().await;
    let saw_b = a_users.iter().any(|u| u.session == b_session);
    assert!(saw_b, "Single-edge: user1 should see user2");

    cleanup_clients(clients).await;
    Ok(())
}

// ── Dynamic cluster join ──────────────────────────────────────────────────

/// An observer connected before a second user joins should see the new
/// user arrive as a UserJoined event (cross-edge).
#[tokio::test]
async fn test_late_join_visible_cross_edge() -> Result<()> {
    let env = standard_env().await?;

    // Edge 1 user connects first
    let early_clients = create_clients(&env, &[ClientConfig::new("user_edge1", 1)]).await?;
    let early = &early_clients[0];
    let mut rx = early.subscribe();

    sleep_ms(300).await;

    // Edge 2 user joins after
    let late_clients = create_clients(&env, &[ClientConfig::new("user_edge2", 2)]).await?;
    let late = &late_clients[0];
    let late_session = late.session_id().await.unwrap();

    // Edge 1 client should receive a UserJoined event for the Edge 2 user
    let saw_join = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserJoined(u)) if u.session == late_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        saw_join,
        "Late-joining user on Edge 2 should trigger UserJoined on Edge 1"
    );

    cleanup_clients(early_clients).await;
    cleanup_clients(late_clients).await;
    Ok(())
}
