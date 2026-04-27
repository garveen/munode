//! User state and information integration tests.
//!
//! Tests user state broadcasting, self-mute/deaf, text messages, comment blobs.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{
    cleanup_clients, single_edge_env, sleep_ms, standard_env, ClientConfig, create_clients,
};

// ── User state broadcasting ───────────────────────────────────────────────

#[tokio::test]
async fn test_user_list_includes_self() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    let session_id = client.session_id().expect("should have session");
    let users = client.users();
    let me = users.iter().find(|u| u.session == session_id);
    assert!(me.is_some(), "Self should appear in the user list");
    assert_eq!(me.unwrap().name, "user1");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_user_state_self_mute_broadcast() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (user1, user2) = (&clients[0], &clients[1]);

    let user1_session = user1.session_id().unwrap();
    let mut rx = user2.subscribe();

    user1.me().set_mute(true).await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u))
                    if u.session == user1_session && u.self_mute =>
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

    assert!(got, "Self-mute should be broadcast to other users");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_user_state_self_deaf_broadcast() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (user1, user2) = (&clients[0], &clients[1]);

    let user1_session = user1.session_id().unwrap();
    let mut rx = user2.subscribe();

    user1.me().set_deaf(true).await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u))
                    if u.session == user1_session && u.self_deaf =>
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

    assert!(got, "Self-deaf should be broadcast to other users");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_user_state_cross_edge_broadcast() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (user1, user2) = (&clients[0], &clients[1]);
    sleep_ms(500).await;

    let user1_session = user1.session_id().unwrap();
    let mut rx = user2.subscribe();

    user1.me().set_mute(true).await?;

    let got = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u))
                    if u.session == user1_session && u.self_mute =>
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

    assert!(got, "User state change should propagate across edges");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Text messages ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_text_message_to_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    // Both join the same channel
    sender.channel(1).join().await?;
    receiver.channel(1).join().await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let mut rx = receiver.subscribe();

    sender.channel(1).send_text("Hello, world!").await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::TextMessage { sender, message, .. })
                    if sender == sender_session && message == "Hello, world!" =>
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

    assert!(got, "Text message should be received by channel member");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_text_message_cross_edge() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    sender.channel(1).join().await?;
    receiver.channel(1).join().await?;
    sleep_ms(500).await;

    let sender_session = sender.session_id().unwrap();
    let mut rx = receiver.subscribe();

    sender.channel(1).send_text("Cross-edge message").await?;

    let got = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::TextMessage { sender, message, .. })
                    if sender == sender_session && message == "Cross-edge message" =>
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

    assert!(got, "Text message should reach cross-edge user in same channel");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_private_message_to_session() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    let receiver_session = receiver.session_id().unwrap();
    let sender_session = sender.session_id().unwrap();
    let mut rx = receiver.subscribe();

    sender.user(receiver_session).send_text("Private hello").await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::TextMessage { sender, message, .. })
                    if sender == sender_session && message == "Private hello" =>
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

    assert!(got, "Private message should be delivered to target session");
    cleanup_clients(clients).await;
    Ok(())
}

// ── User info (comment / texture blob) ───────────────────────────────────

#[tokio::test]
async fn test_set_and_receive_comment() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (user1, user2) = (&clients[0], &clients[1]);

    let user1_session = user1.session_id().unwrap();
    let mut rx = user2.subscribe();

    user1.me().set_comment("My test comment").await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u)) if u.session == user1_session => {
                    // Comment may be inline or as a hash blob
                    break true;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got, "Setting comment should broadcast a UserState update");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Ping ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_ping_response() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client.me().ping().await?;

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

    assert!(got, "Server should respond to ping");
    cleanup_clients(clients).await;
    Ok(())
}

// ── QueryUsers ────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_query_users_by_id() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    // Query admin user (ID=1)
    let mut rx = client.subscribe();
    client.server().query_users(vec![1], vec![]).await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::QueryUsers(q)) if !q.names.is_empty() => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got, "QueryUsers should return results for known user ID");
    cleanup_clients(clients).await;
    Ok(())
}
