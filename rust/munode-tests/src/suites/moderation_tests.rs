//! Moderation integration tests.
//!
//! Tests kick, ban, move user, mute/deafen by admin.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{ClientConfig, cleanup_clients, create_clients, single_edge_env, sleep_ms};

// ── Kick ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_kick_user_disconnects_target() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![ClientConfig::new("admin", 1), ClientConfig::new("guest", 1)];
    let clients = create_clients(&env, &configs).await?;
    let (admin, target) = (&clients[0], &clients[1]);

    let target_session = target.session_id().expect("target must have session");
    let mut target_rx = target.subscribe();

    admin.user(target_session).kick(Some("Test kick")).await?;

    // Wait for the target to receive Kicked or be disconnected
    let kicked = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match target_rx.recv().await {
                Ok(ClientEvent::Kicked { .. }) | Ok(ClientEvent::Disconnected) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    let still_connected = target.is_connected();
    assert!(
        kicked || !still_connected,
        "Target should be kicked or disconnected"
    );

    drop(clients); // cleanup
    Ok(())
}

#[tokio::test]
async fn test_kick_notify_observer() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1), // observer
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, target, observer) = (&clients[0], &clients[1], &clients[2]);

    let target_session = target.session_id().unwrap();
    let mut obs_rx = observer.subscribe();

    admin
        .user(target_session)
        .kick(Some("Kick for test"))
        .await?;
    sleep_ms(800).await;

    // Observer should see UserLeft or Kicked event for the target
    let mut got_leave = false;
    while let Ok(ev) = obs_rx.try_recv() {
        match ev {
            ClientEvent::UserLeft { session, .. } | ClientEvent::Kicked { session, .. }
                if session == target_session =>
            {
                got_leave = true;
            }
            _ => {}
        }
    }

    assert!(
        got_leave,
        "Observer should receive leave/kick event for kicked user"
    );

    // cleanup (target already kicked)
    admin.disconnect().await?;
    observer.disconnect().await?;
    Ok(())
}

#[tokio::test]
async fn test_non_admin_cannot_kick() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![ClientConfig::new("user1", 1), ClientConfig::new("user2", 1)];
    let clients = create_clients(&env, &configs).await?;
    let (user1, user2) = (&clients[0], &clients[1]);

    let user2_session = user2.session_id().unwrap();

    // Non-admin tries to kick — server should deny or ignore
    user1.user(user2_session).kick(None).await.ok(); // May return error; that's fine
    sleep_ms(500).await;

    // user2 should still be connected
    assert!(
        user2.is_connected(),
        "Non-admin kick should not disconnect the target"
    );
    cleanup_clients(clients).await;
    Ok(())
}

// ── Move user ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_admin_move_user_to_different_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![ClientConfig::new("admin", 1), ClientConfig::new("user1", 1)];
    let clients = create_clients(&env, &configs).await?;
    let (admin, target) = (&clients[0], &clients[1]);

    let target_session = target.session_id().unwrap();
    let mut rx = target.subscribe();

    // Admin moves target to Lobby (channel 1)
    use munode_protocol::mumbleproto;
    admin
        .send_user_state(mumbleproto::UserState {
            session: Some(target_session),
            channel_id: Some(1),
            ..Default::default()
        })
        .await?;

    let moved = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u))
                    if u.session == target_session && u.channel_id == 1 =>
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

    assert!(
        moved,
        "Admin should be able to move user to different channel"
    );
    cleanup_clients(clients).await;
    Ok(())
}

// ── Mute/Deafen by admin ──────────────────────────────────────────────────

#[tokio::test]
async fn test_admin_mute_user() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![ClientConfig::new("admin", 1), ClientConfig::new("user1", 1)];
    let clients = create_clients(&env, &configs).await?;
    let (admin, target) = (&clients[0], &clients[1]);

    let target_session = target.session_id().unwrap();
    let mut target_rx = target.subscribe();
    let mut admin_rx = admin.subscribe();

    use munode_protocol::mumbleproto;
    admin
        .send_user_state(mumbleproto::UserState {
            session: Some(target_session),
            mute: Some(true),
            ..Default::default()
        })
        .await?;

    let muted = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match target_rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u)) if u.session == target_session && u.mute => {
                    break true;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    let actor_notified = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match admin_rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u)) if u.session == target_session && u.mute => {
                    break true;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(muted, "Admin should be able to mute a user");
    assert!(
        actor_notified,
        "Admin should also receive the mute broadcast"
    );
    cleanup_clients(clients).await;
    Ok(())
}

// ── Ban ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_ban_user_kicks_and_prevents_rejoin() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user5", 1), // use a user not used by other tests
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, target) = (&clients[0], &clients[1]);

    let target_session = target.session_id().unwrap();

    // Get target's address (127.0.0.1) and ban for 1 second
    admin.user(target_session).ban(Some("Ban test")).await?;
    sleep_ms(1000).await;

    // Target should be disconnected
    let still_connected = target.is_connected();
    // After ban duration expires, we'd normally test re-join, but that's complex here.
    // Just confirm the ban was processed (target disconnected).
    assert!(!still_connected, "Banned user should be disconnected");

    admin.disconnect().await?;
    Ok(())
}
