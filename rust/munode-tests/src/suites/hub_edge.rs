//! Hub-Edge integration tests.
//!
//! Covers connection, authentication, user-state sync, and channel management
//! across one or more edges.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{
    ClientConfig, TestEnvBuilder, cleanup_clients, create_clients, single_edge_env, sleep_ms,
    standard_env,
};

// ── Environment & auth server ─────────────────────────────────────────────

#[tokio::test]
async fn test_auth_server_is_reachable() -> Result<()> {
    let env = single_edge_env().await?;
    let url = format!("http://127.0.0.1:{}/health", env.auth_port);
    let body = reqwest::get(&url).await?.status();
    assert_eq!(body.as_u16(), 200);
    Ok(())
}

#[tokio::test]
async fn test_hub_control_port_is_open() -> Result<()> {
    let env = single_edge_env().await?;
    // If we got here the harness already verified the control port is up.
    assert!(env.control_port > 0);
    Ok(())
}

#[tokio::test]
async fn test_edge_mumble_port_is_open() -> Result<()> {
    let env = single_edge_env().await?;
    assert!(env.edge1() > 0);
    Ok(())
}

// ── Basic connection ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_connect_and_authenticate() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    assert!(clients[0].is_connected());
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_connect_multiple_users_concurrently() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
        ClientConfig::new("guest", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    for c in &clients {
        assert!(c.is_connected());
    }
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_incorrect_password_rejected() -> Result<()> {
    use munode_client::ConnectOptions;
    let env = single_edge_env().await?;
    let client = munode_client::MumbleClient::new();
    let result = client
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port: env.edge1(),
            username: "admin".into(),
            password: Some("wrongpassword".into()),
            reject_unauthorized: false,
            force_tcp_voice: true,
            connect_timeout: Duration::from_secs(10),
            ..Default::default()
        })
        .await;
    // Connection should fail or receive a Reject
    assert!(result.is_err(), "Expected rejection for wrong password");
    Ok(())
}

// ── Channel state ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_receive_channel_list_after_auth() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    let channels = client.channels();
    assert!(!channels.is_empty(), "Should receive channel list");

    // Root channel ID=0 must exist
    let root = channels.iter().find(|c| c.channel_id == 0);
    assert!(root.is_some(), "Root channel (id=0) not found");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_initial_channel_names_are_correct() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let channels = clients[0].channels();

    let names: Vec<&str> = channels.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"Root"), "Root channel missing");
    assert!(names.contains(&"Lobby"), "Lobby channel missing");
    assert!(names.contains(&"General"), "General channel missing");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_join_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    // Join the Lobby channel (id=1)
    client.channel(1).join().await?;
    sleep_ms(300).await;

    let session = client.session();
    assert_eq!(
        session.map(|s| s.channel_id),
        Some(1),
        "User should be in channel 1"
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_join_nonexistent_channel_does_not_crash() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    // Should not panic — server may ignore or send PermissionDenied
    let _ = client.channel(9999).join().await;
    sleep_ms(200).await;

    assert!(client.is_connected(), "Client should still be connected");
    cleanup_clients(clients).await;
    Ok(())
}

// ── User state sync ───────────────────────────────────────────────────────

#[tokio::test]
async fn test_users_can_see_each_other() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![ClientConfig::new("user1", 1), ClientConfig::new("user2", 1)];
    let clients = create_clients(&env, &configs).await?;

    sleep_ms(200).await;

    let users1 = clients[0].users();
    let users2 = clients[1].users();

    assert!(users1.len() >= 2, "user1 should see at least 2 users");
    assert!(users2.len() >= 2, "user2 should see at least 2 users");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_user_left_event_on_disconnect() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![ClientConfig::new("user1", 1), ClientConfig::new("user2", 1)];
    let clients = create_clients(&env, &configs).await?;
    let (c1, c2) = (&clients[0], &clients[1]);

    // Observer subscribes before disconnect
    let mut rx = c2.subscribe();

    // User1 disconnects
    let session1 = c1.session_id();
    c1.disconnect().await?;

    // Wait for UserLeft event
    let timeout = Duration::from_secs(5);
    let got_leave = tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserLeft { session, .. }) if Some(session) == session1 => {
                    break true;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        got_leave,
        "Should receive UserLeft event when user disconnects"
    );

    c2.disconnect().await?;
    Ok(())
}

#[tokio::test]
async fn test_user_left_event_propagates_across_edges() -> Result<()> {
    let env = standard_env().await?; // 2 edges
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 2), // observer on edge 2
    ];
    let clients = create_clients(&env, &configs).await?;
    let (c1, c2) = (&clients[0], &clients[1]);
    sleep_ms(500).await;

    let mut rx = c2.subscribe();
    let session1 = c1.session_id();
    c1.disconnect().await?;

    let timeout = Duration::from_secs(8);
    let got_leave = tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserLeft { session, .. }) if Some(session) == session1 => {
                    break true;
                }
                Ok(ClientEvent::Kicked { session, .. }) if Some(session) == session1 => {
                    break true;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got_leave, "Cross-edge UserLeft event not received");

    c2.disconnect().await?;
    Ok(())
}

// ── Self-state ────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_client_knows_its_own_session() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let session = clients[0].session();
    assert!(session.is_some(), "Client should have a session after auth");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_client_username_is_correct() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let session_id = clients[0].session_id().expect("should have session id");
    let users = clients[0].users();
    let me = users.iter().find(|u| u.session == session_id);
    assert!(me.is_some(), "should find self in user list");
    assert_eq!(me.unwrap().name, "user1");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Disconnect / reconnect ────────────────────────────────────────────────

#[tokio::test]
async fn test_disconnect_and_reconnect() -> Result<()> {
    let env = single_edge_env().await?;

    // First connect
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    assert!(clients[0].is_connected());
    cleanup_clients(clients).await;

    sleep_ms(300).await;

    // Second connect
    let clients2 = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    assert!(clients2[0].is_connected());
    cleanup_clients(clients2).await;
    Ok(())
}

// ── Multi-edge cross-sync ─────────────────────────────────────────────────

#[tokio::test]
async fn test_users_on_different_edges_see_each_other() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![ClientConfig::new("user1", 1), ClientConfig::new("user2", 2)];
    let clients = create_clients(&env, &configs).await?;
    sleep_ms(800).await;

    let users1 = clients[0].users();
    let users2 = clients[1].users();

    // Each should see at least themselves + the other
    assert!(users1.len() >= 2, "Edge1 user should see cross-edge user");
    assert!(users2.len() >= 2, "Edge2 user should see cross-edge user");

    cleanup_clients(clients).await;
    Ok(())
}

// ── Hub connection pool (hub-connection-pool.test.ts) ─────────────────────

/// Edges configured with `hub_server.pool_size = 3` accept Mumble client
/// connections normally and propagate cross-Edge user visibility.
#[tokio::test]
async fn test_pool_size_3_clients_connect_and_see_each_other() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(2)
        .edge_config_patch(serde_json::json!({
            "hub_server": { "pool_size": 3 }
        }))
        .start()
        .await?;

    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user_edge1", 1),
            ClientConfig::new("user_edge2", 2),
        ],
    )
    .await?;

    sleep_ms(800).await;

    let e1_users = clients[0].users();
    let e2_users = clients[1].users();

    assert!(
        e1_users.iter().any(|u| u.name == "user_edge2"),
        "Edge 1 client must see Edge 2 user with pool_size=3"
    );
    assert!(
        e2_users.iter().any(|u| u.name == "user_edge1"),
        "Edge 2 client must see Edge 1 user with pool_size=3"
    );

    cleanup_clients(clients).await;
    Ok(())
}

/// Edges configured with `pool_size = 1` keep working (backwards-compat).
#[tokio::test]
async fn test_pool_size_1_default_remains_functional() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .edge_config_patch(serde_json::json!({
            "hub_server": { "pool_size": 1 }
        }))
        .start()
        .await?;

    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    assert!(clients[0].is_connected());
    cleanup_clients(clients).await;
    Ok(())
}

// ── External port (edge-external-port.test.ts) ────────────────────────────

/// An Edge configured with an explicit `external_port` still accepts client
/// connections on its real listen port.
#[tokio::test]
async fn test_edge_with_explicit_external_port_serves_clients() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .edge_config_patch(serde_json::json!({
            "network": { "external_port": 19999 }
        }))
        .start()
        .await?;

    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    assert!(
        clients[0].is_connected(),
        "Client must connect on real listen port despite external_port override"
    );

    cleanup_clients(clients).await;
    Ok(())
}
