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
    let channels = clients[0].channels().await;
    assert!(!channels.is_empty(), "Channel list must not be empty");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_root_channel_exists() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let channels = clients[0].channels().await;
    let root = channels.iter().find(|c| c.channel_id == 0);
    assert!(root.is_some(), "Root channel (id=0) must exist");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_seeded_channels_present() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let channels = clients[0].channels().await;
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
    let channels = clients[0].channels().await;

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
    let channels = clients[0].channels().await;
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

    let new_id = client.create_channel(0, &name).await?;
    assert!(new_id > 0, "New channel ID should be > 0");

    sleep_ms(300).await;

    let channels = client.channels().await;
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

    admin.create_channel(0, &name).await?;

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

    admin.create_channel(0, &name).await?;

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
    let ch_id = client.create_channel(0, &name).await?;
    sleep_ms(300).await;

    client.delete_channel(ch_id).await?;
    sleep_ms(300).await;

    let channels = client.channels().await;
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

    client.join_channel(1).await?; // Lobby
    sleep_ms(300).await;

    let session = client.session().await.expect("should have session");
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

    let mover_session = mover.session_id().await.unwrap();
    let mut rx = observer.subscribe();

    mover.join_channel(1).await?; // Move to Lobby

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
    let ch_a = admin.create_channel(0, &format!("LinkA_{ts}")).await?;
    let ch_b = admin.create_channel(0, &format!("LinkB_{ts}")).await?;
    sleep_ms(400).await;

    let mut rx = observer.subscribe();
    // Send channel link via ChannelState with links_add
    use munode_protocol::mumbleproto;
    admin.send_channel_state(mumbleproto::ChannelState {
        channel_id: Some(ch_a),
        links_add: vec![ch_b],
        ..Default::default()
    }).await?;

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
    let ch_a = admin.create_channel(0, &format!("UnlinkA_{ts}")).await?;
    let ch_b = admin.create_channel(0, &format!("UnlinkB_{ts}")).await?;
    sleep_ms(400).await;

    // Link first
    use munode_protocol::mumbleproto;
    admin.send_channel_state(mumbleproto::ChannelState {
        channel_id: Some(ch_a),
        links_add: vec![ch_b],
        ..Default::default()
    }).await?;
    sleep_ms(500).await;

    // Now unlink
    let mut rx = observer.subscribe();
    admin.send_channel_state(mumbleproto::ChannelState {
        channel_id: Some(ch_a),
        links_remove: vec![ch_b],
        ..Default::default()
    }).await?;

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
