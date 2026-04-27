//! Channel management integration tests.
//!
//! Covers: channel list, create/delete, move users, channel links.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{
    cleanup_clients, single_edge_env, sleep_ms, standard_env, ClientConfig, create_clients,
};

// ── Channel list & structure ──────────────────────────────────────────────

#[tokio::test]
async fn test_channel_list_not_empty() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let channels = clients[0].channels();
    assert!(!channels.is_empty(), "Channel list must not be empty");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_root_channel_exists() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let channels = clients[0].channels();
    let root = channels.iter().find(|c| c.channel_id == 0);
    assert!(root.is_some(), "Root channel (id=0) must exist");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_seeded_channels_present() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let channels = clients[0].channels();
    let names: Vec<&str> = channels.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"Root"),    "Root channel missing");
    assert!(names.contains(&"Lobby"),   "Lobby channel missing");
    assert!(names.contains(&"General"), "General channel missing");
    assert!(names.contains(&"Private"), "Private channel missing");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_child_channels_have_correct_parent() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let channels = clients[0].channels();

    for name in &["Lobby", "General", "Private"] {
        let ch = channels.iter().find(|c| c.name.as_str() == *name)
            .unwrap_or_else(|| panic!("Channel {} not found", name));
        assert_eq!(ch.parent, 0, "Channel {} should have root as parent", name);
    }
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_channel_ids_are_unique() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let channels = clients[0].channels();
    let mut ids: Vec<u32> = channels.iter().map(|c| c.channel_id).collect();
    let original = ids.len();
    ids.dedup();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), original, "All channel IDs must be unique");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Channel creation ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_create_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let name = format!("TestCh_{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let new_id = client.channel(0).create_subchannel(&name).await?;
    assert!(new_id > 0, "New channel ID should be > 0");

    sleep_ms(300).await;

    let channels = client.channels();
    let found = channels.iter().find(|c| c.channel_id == new_id);
    assert!(found.is_some(), "Newly created channel should appear in channel list");
    assert_eq!(found.unwrap().name, name);

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_create_channel_observers_notified() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, observer) = (&clients[0], &clients[1]);

    let mut rx = observer.subscribe();
    let name = format!("Notify_{}", chrono_now_ms());

    admin.channel(0).create_subchannel(&name).await?;

    // Wait for ChannelCreated/ChannelUpdated event on observer
    let got = wait_for_channel_event(&mut rx, &name, Duration::from_secs(5)).await;
    assert!(got, "Observer should receive channel creation notification");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_create_channel_cross_edge_notified() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, observer) = (&clients[0], &clients[1]);

    sleep_ms(300).await;
    let mut rx = observer.subscribe();
    let name = format!("CrossCh_{}", chrono_now_ms());

    admin.channel(0).create_subchannel(&name).await?;

    let got = wait_for_channel_event(&mut rx, &name, Duration::from_secs(8)).await;
    assert!(got, "Cross-edge observer should receive channel creation notification");

    cleanup_clients(clients).await;
    Ok(())
}

// ── Channel deletion ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_delete_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    // Create a channel, then delete it
    let name = format!("Del_{}", chrono_now_ms());
    let ch_id = client.channel(0).create_subchannel(&name).await?;
    sleep_ms(300).await;

    client.channel(ch_id).delete().await?;
    sleep_ms(300).await;

    let channels = client.channels();
    let found = channels.iter().find(|c| c.channel_id == ch_id);
    assert!(found.is_none(), "Deleted channel should no longer appear");

    cleanup_clients(clients).await;
    Ok(())
}

// ── User movement between channels ───────────────────────────────────────

#[tokio::test]
async fn test_join_channel_updates_own_state() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    client.channel(1).join().await?; // Lobby
    sleep_ms(300).await;

    let session = client.session().expect("should have session");
    assert_eq!(session.channel_id, 1);

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_move_user_notified_to_observer() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (mover, observer) = (&clients[0], &clients[1]);

    let mover_session = mover.session_id().unwrap();
    let mut rx = observer.subscribe();

    mover.channel(1).join().await?; // Move to Lobby

    let moved = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(s))
                    if s.session == mover_session && s.channel_id == 1 =>
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

    assert!(moved, "Observer should receive UserState with updated channel_id");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Channel links ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_channel_link_add_notifies_same_edge_observer() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, observer) = (&clients[0], &clients[1]);

    let ts = chrono_now_ms();
    let ch_a = admin.channel(0).create_subchannel(&format!("LinkA_{ts}")).await?;
    let ch_b = admin.channel(0).create_subchannel(&format!("LinkB_{ts}")).await?;
    sleep_ms(400).await;

    let mut rx = observer.subscribe();
    // Send channel link via handle API
    admin.channel(ch_a).link(ch_b).await?;

    // Expect ChannelUpdated with links containing ch_b
    let got = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::ChannelUpdated(ch))
                    if ch.channel_id == ch_a
                        && ch.links.contains(&ch_b) =>
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

    assert!(got, "Same-edge observer should receive links notification");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_channel_link_remove_notifies_observer() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, observer) = (&clients[0], &clients[1]);

    let ts = chrono_now_ms();
    let ch_a = admin.channel(0).create_subchannel(&format!("UnlinkA_{ts}")).await?;
    let ch_b = admin.channel(0).create_subchannel(&format!("UnlinkB_{ts}")).await?;
    sleep_ms(400).await;

    // Link first
    admin.channel(ch_a).link(ch_b).await?;
    sleep_ms(500).await;

    // Now unlink
    let mut rx = observer.subscribe();
    admin.channel(ch_a).unlink(ch_b).await?;

    let got = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::ChannelUpdated(ch))
                    if ch.channel_id == ch_a
                        && !ch.links.contains(&ch_b) =>
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

    assert!(got, "Observer should receive unlink notification");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn chrono_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

async fn wait_for_channel_event(
    rx: &mut tokio::sync::broadcast::Receiver<ClientEvent>,
    channel_name: &str,
    timeout: Duration,
) -> bool {
    let name = channel_name.to_string();
    tokio::time::timeout(timeout, async move {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::ChannelCreated(s) | ClientEvent::ChannelUpdated(s))
                    if s.name == name =>
                {
                    break true;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

// ── Cross-edge channel link/unlink ────────────────────────────────────────

#[tokio::test]
async fn test_channel_link_add_notifies_cross_edge_observer() -> Result<()> {
    let env = standard_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, observer) = (&clients[0], &clients[1]);

    let ts = chrono_now_ms();
    let ch_a = admin.channel(0).create_subchannel(&format!("LinkCrossA_{ts}")).await?;
    let ch_b = admin.channel(0).create_subchannel(&format!("LinkCrossB_{ts}")).await?;
    sleep_ms(800).await;

    let mut rx = observer.subscribe();
    admin.channel(ch_a).link(ch_b).await?;

    let got = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::ChannelUpdated(ch))
                    if ch.channel_id == ch_a && ch.links.contains(&ch_b) =>
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

    assert!(got, "Cross-edge observer should receive link notification");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_channel_link_peers_receive_symmetric_notifications() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("guest", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, observer) = (&clients[0], &clients[1]);

    let ts = chrono_now_ms();
    let ch_a = admin.channel(0).create_subchannel(&format!("LinkPeerA_{ts}")).await?;
    let ch_b = admin.channel(0).create_subchannel(&format!("LinkPeerB_{ts}")).await?;
    sleep_ms(500).await;

    let mut rx = observer.subscribe();
    admin.channel(ch_a).link(ch_b).await?;

    // Wait for both A→B and B→A notifications
    let mut got_a_to_b = false;
    let mut got_b_to_a = false;
    let _ = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::ChannelUpdated(ch)) => {
                    if ch.channel_id == ch_a && ch.links.contains(&ch_b) {
                        got_a_to_b = true;
                    }
                    if ch.channel_id == ch_b && ch.links.contains(&ch_a) {
                        got_b_to_a = true;
                    }
                    if got_a_to_b && got_b_to_a {
                        break;
                    }
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    })
    .await;

    assert!(got_a_to_b, "Observer should see ch_a links contain ch_b");
    assert!(got_b_to_a, "Peer ch_b should also receive symmetric link to ch_a");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Channel memory (per-user last channel persistence) ───────────────────

#[tokio::test]
async fn test_user_restored_to_last_channel_after_reconnect() -> Result<()> {
    use munode_client::{ConnectOptions, MumbleClient};

    let env = single_edge_env().await?;
    let port = env.edge1();

    // First connection: move to channel 1 (Lobby)
    let c1 = MumbleClient::new();
    c1.connect(ConnectOptions {
        host: "127.0.0.1".into(),
        port,
        username: "user1".into(),
        password: Some("password1".into()),
        ..Default::default()
    })
    .await?;
    sleep_ms(400).await;
    c1.channel(1).join().await?;
    sleep_ms(500).await;
    let s1 = c1.me().session().expect("session");
    assert_eq!(s1.channel_id, 1, "user1 should be in channel 1 before disconnect");
    let _ = c1.disconnect().await;
    sleep_ms(500).await;

    // Reconnect: should return to channel 1
    let c2 = MumbleClient::new();
    c2.connect(ConnectOptions {
        host: "127.0.0.1".into(),
        port,
        username: "user1".into(),
        password: Some("password1".into()),
        ..Default::default()
    })
    .await?;
    sleep_ms(700).await;
    let s2 = c2.me().session().expect("session after reconnect");
    assert_eq!(
        s2.channel_id, 1,
        "user1 should be restored to channel 1 (got {})",
        s2.channel_id
    );
    let _ = c2.disconnect().await;
    Ok(())
}

#[tokio::test]
async fn test_user_falls_back_to_root_when_last_channel_deleted() -> Result<()> {
    use munode_client::{ConnectOptions, MumbleClient};

    let env = single_edge_env().await?;
    let port = env.edge1();
    let ts = chrono_now_ms();

    // Admin creates a temp channel
    let admin = MumbleClient::new();
    admin
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            username: "admin".into(),
            password: Some("admin123".into()),
            ..Default::default()
        })
        .await?;
    sleep_ms(400).await;
    let temp_id = admin
        .channel(0)
        .create_subchannel(&format!("TempForMemory_{ts}"))
        .await?;
    sleep_ms(500).await;

    // user1 joins the temp channel, then disconnects
    let user_a = MumbleClient::new();
    user_a
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            username: "user1".into(),
            password: Some("password1".into()),
            ..Default::default()
        })
        .await?;
    sleep_ms(500).await;
    user_a.channel(temp_id).join().await?;
    sleep_ms(400).await;
    let _ = user_a.disconnect().await;
    sleep_ms(500).await;

    // Admin deletes the temp channel
    admin.channel(temp_id).delete().await?;
    sleep_ms(500).await;

    // user1 reconnects: should NOT be in the deleted channel
    let user_b = MumbleClient::new();
    user_b
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            username: "user1".into(),
            password: Some("password1".into()),
            ..Default::default()
        })
        .await?;
    sleep_ms(700).await;
    let s = user_b.me().session().expect("session");
    assert_ne!(
        s.channel_id, temp_id,
        "user1 should not be in the deleted channel"
    );
    let chans: Vec<u32> = user_b.channels().iter().map(|c| c.channel_id).collect();
    assert!(
        !chans.contains(&temp_id),
        "deleted channel should not appear in channel list"
    );
    let _ = user_b.disconnect().await;
    let _ = admin.disconnect().await;
    Ok(())
}

