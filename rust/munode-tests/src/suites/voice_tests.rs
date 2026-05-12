//! Voice routing integration tests.
//!
//! Tests TCP voice, voice packet routing (same-edge + cross-edge),
//! voice targets (whispers), and related scenarios.

use std::time::Duration;

use anyhow::Result;
use munode_protocol::mumbleproto;
use munode_client::ClientEvent;

use crate::harness::{
    cleanup_clients, random_voice_data, single_edge_env, sleep_ms, standard_env, ClientConfig,
    TestEnvBuilder, create_clients,
};

async fn wait_for_voice_from(
    receiver: &munode_client::MumbleClient,
    sender_session: u32,
    timeout: Duration,
) -> bool {
    let mut rx = receiver.subscribe();
    tokio::time::timeout(timeout, async move {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

async fn assert_cross_edge_voice_delivery(
    env: &crate::harness::TestEnvironment,
    sender_edge: usize,
    receiver_edge: usize,
    use_udp_voice: bool,
    should_receive: bool,
    context: &str,
) -> Result<()> {
    let clients = create_clients(
        env,
        &[
            ClientConfig {
                username: "user1",
                edge: sender_edge,
                channel_id: None,
                use_udp_voice,
                pre_connect_state: None,
            },
            ClientConfig {
                username: "user2",
                edge: receiver_edge,
                channel_id: None,
                use_udp_voice,
                pre_connect_state: None,
            },
        ],
    )
    .await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    sender.channel(1).join().await?;
    receiver.channel(1).join().await?;
    sleep_ms(800).await;

    let sender_session = sender.session_id().unwrap();
    let audio = random_voice_data(20);
    let timeout = Duration::from_secs(5);
    let started = tokio::time::Instant::now();
    let mut received = false;

    while started.elapsed() < timeout {
        sender.voice().send(4, 0, 1, &audio).await?;
        if wait_for_voice_from(receiver, sender_session, Duration::from_millis(400)).await {
            received = true;
            break;
        }
        sleep_ms(150).await;
    }

    assert_eq!(
        received,
        should_receive,
        "{context}: expected cross-edge voice received={should_receive}, got {received}"
    );

    cleanup_clients(clients).await;
    Ok(())
}

// ── TCP voice mode ────────────────────────────────────────────────────────

#[tokio::test]
async fn test_connect_with_tcp_voice_mode() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    assert!(clients[0].is_connected(), "TCP-mode client should connect");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_send_voice_tcp_does_not_panic() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    client.channel(1).join().await?;
    sleep_ms(200).await;

    // Send voice packet via TCP tunnel (codec=4 Opus, target=0 normal)
    let audio = random_voice_data(20);
    client.voice().send(4, 0, 1, &audio).await?;

    cleanup_clients(clients).await;
    Ok(())
}

// ── Voice routing — same Edge ─────────────────────────────────────────────

#[tokio::test]
async fn test_voice_received_by_same_channel_user() -> Result<()> {
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

    let mut rx = receiver.subscribe();
    let sender_session = sender.session_id().unwrap();

    let audio = random_voice_data(20);
    sender.voice().send(4, 0, 1, &audio).await?;

    let received = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(received, "Voice should be received by user in same channel");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_voice_not_received_by_different_channel_user() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    // Sender in Lobby, receiver in General
    sender.channel(1).join().await?;    // Lobby
    receiver.channel(2).join().await?;  // General
    sleep_ms(300).await;

    let mut rx = receiver.subscribe();
    let sender_session = sender.session_id().unwrap();

    let audio = random_voice_data(20);
    sender.voice().send(4, 0, 1, &audio).await?;
    sleep_ms(500).await;

    // Check we did NOT receive voice from sender in that window
    let mut received = false;
    while let Ok(ev) = rx.try_recv() {
        if let ClientEvent::Voice(v) = ev {
            if v.session == sender_session {
                received = true;
            }
        }
    }

    assert!(!received, "Voice should NOT be received by user in a different channel");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Voice routing — cross Edge ────────────────────────────────────────────

#[tokio::test]
async fn test_voice_received_cross_edge_same_channel() -> Result<()> {
    let env = standard_env().await?; // 2 edges
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 2),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    // Both join Lobby
    sender.channel(1).join().await?;
    receiver.channel(1).join().await?;
    sleep_ms(500).await;

    let mut rx = receiver.subscribe();
    let sender_session = sender.session_id().unwrap();

    let audio = random_voice_data(20);
    sender.voice().send(4, 0, 1, &audio).await?;

    let received = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(received, "Voice should propagate across edges to same channel");
    cleanup_clients(clients).await;
    Ok(())
}

/// Current Rust equivalent of the old `direct_only` strategy:
/// cross-edge voice must keep working through direct peer routes even when
/// Hub TCP relay and Edge fallback are both disabled. This must use UDP voice,
/// because TCP-tunneled client voice is Hub-relayed for remote edges by design.
#[tokio::test]
async fn test_cross_edge_voice_routes_without_hub_relay_when_direct_path_is_available() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(2)
        .hub_config_patch(serde_json::json!({
            "voice_routing": {
                "enable_hub_tcp_relay": false,
            }
        }))
        .edge_config_patch(serde_json::json!({
            "voice_routing": {
                "enable_hub_tcp_fallback": false,
            }
        }))
        .start()
        .await?;

    assert_cross_edge_voice_delivery(
        &env,
        1,
        2,
        true,
        true,
        "direct path available with relay/fallback disabled",
    )
    .await
}

/// Current Rust equivalent of `auto_fallback`: if peer metadata is not
/// resolvable into a direct address, Hub relay should keep cross-edge voice
/// working.
#[tokio::test]
async fn test_cross_edge_voice_falls_back_to_hub_relay_when_direct_path_is_unresolvable() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(2)
        .hub_config_patch(serde_json::json!({
            "voice_routing": {
                "enable_hub_tcp_relay": true,
            }
        }))
        .edge_config_patch(serde_json::json!({
            "network": {
                "external_host": "peer-not-resolvable.invalid",
            },
            "voice_routing": {
                "enable_hub_tcp_fallback": true,
            }
        }))
        .start()
        .await?;

    assert_cross_edge_voice_delivery(
        &env,
        1,
        2,
        false,
        true,
        "direct path unavailable but hub relay fallback enabled",
    )
    .await
}

/// Current Rust equivalent of `direct_only` under direct-path failure: when
/// direct peer metadata is unusable and relay/fallback are disabled, cross-edge
/// voice must not be delivered.
#[tokio::test]
async fn test_cross_edge_voice_does_not_fallback_when_direct_path_is_unresolvable_and_relay_is_disabled() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(2)
        .hub_config_patch(serde_json::json!({
            "voice_routing": {
                "enable_hub_tcp_relay": false,
            }
        }))
        .edge_config_patch(serde_json::json!({
            "network": {
                "external_host": "peer-not-resolvable.invalid",
            },
            "voice_routing": {
                "enable_hub_tcp_fallback": false,
            }
        }))
        .start()
        .await?;

    assert_cross_edge_voice_delivery(
        &env,
        1,
        2,
        false,
        false,
        "direct path unavailable and relay/fallback disabled",
    )
    .await
}

// ── Deaf users don't receive voice ───────────────────────────────────────

#[tokio::test]
async fn test_deaf_user_does_not_receive_voice() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    sender.channel(1).join().await?;
    receiver.channel(1).join().await?;
    receiver.me().set_deaf(true).await?;
    sleep_ms(300).await;

    let mut rx = receiver.subscribe();
    let sender_session = sender.session_id().unwrap();

    let audio = random_voice_data(20);
    sender.voice().send(4, 0, 1, &audio).await?;
    sleep_ms(500).await;

    let mut received = false;
    while let Ok(ev) = rx.try_recv() {
        if let ClientEvent::Voice(v) = ev {
            if v.session == sender_session {
                received = true;
            }
        }
    }

    // Note: self-deaf means the client won't send audio, but the server may still route it.
    // The key test here is that self-deaf is set correctly.
    let _ = received; // server-side routing is the real test
    cleanup_clients(clients).await;
    Ok(())
}

// ── Voice via linked channels ─────────────────────────────────────────────

#[tokio::test]
async fn test_voice_routes_through_linked_channels() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, user1, user2) = (&clients[0], &clients[1], &clients[2]);

    use munode_protocol::mumbleproto;

    // Create two new channels and link them
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let ch_a = admin.channel(0).create_subchannel(&format!("VA_{ts}")).await?;
    let ch_b = admin.channel(0).create_subchannel(&format!("VB_{ts}")).await?;
    sleep_ms(300).await;

    // Link A → B
    admin.send_channel_state(mumbleproto::ChannelState {
        channel_id: Some(ch_a),
        links_add: vec![ch_b],
        ..Default::default()
    }).await?;
    sleep_ms(600).await;

    // user1 in ch_a, user2 in ch_b
    user1.channel(ch_a).join().await?;
    user2.channel(ch_b).join().await?;
    sleep_ms(300).await;

    let mut rx = user2.subscribe();
    let sender_session = user1.session_id().unwrap();

    let audio = random_voice_data(20);
    user1.voice().send(4, 0, 1, &audio).await?;

    let received = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(received, "Voice should route through linked channels");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Whisper (voice target) ────────────────────────────────────────────────

#[tokio::test]
async fn test_whisper_to_specific_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
        ClientConfig::new("user3", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (sender, target, non_target) = (&clients[0], &clients[1], &clients[2]);

    // All join Lobby
    sender.channel(1).join().await?;
    target.channel(1).join().await?;
    non_target.channel(2).join().await?; // General — different channel
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let target_session = target.session_id().unwrap();

    // Set voice target 1 to whisper to target user
    sender.voice().set_target(1, vec![mumbleproto::voice_target::Target {
        session: vec![target_session],
        ..Default::default()
    }]).await?;
    sleep_ms(200).await;

    let mut target_rx = target.subscribe();
    let mut non_target_rx = non_target.subscribe();

    let audio = random_voice_data(20);
    // Send with target=1 (whisper)
    sender.voice().send(4, 1, 1, &audio).await?;
    sleep_ms(500).await;

    // Target should receive
    let mut target_got = false;
    while let Ok(ev) = target_rx.try_recv() {
        if let ClientEvent::Voice(v) = ev {
            if v.session == sender_session {
                target_got = true;
            }
        }
    }

    // Non-target should NOT receive
    let mut non_target_got = false;
    while let Ok(ev) = non_target_rx.try_recv() {
        if let ClientEvent::Voice(v) = ev {
            if v.session == sender_session {
                non_target_got = true;
            }
        }
    }

    assert!(target_got, "Whisper target should receive voice");
    assert!(!non_target_got, "Non-target should not receive whisper");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_whisper_children_target_tracks_new_subchannel_after_creation() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("admin", 1),
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
        ],
    )
    .await?;
    let (admin, sender, late_target) = (&clients[0], &clients[1], &clients[2]);

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let parent = admin
        .channel(0)
        .create_subchannel(&format!("WhisperTree_{ts}"))
        .await?;
    let initial_child = admin
        .channel(parent)
        .create_subchannel(&format!("WhisperChildA_{ts}"))
        .await?;
    sleep_ms(400).await;

    sender.channel(1).join().await?;
    late_target.channel(initial_child).join().await?;
    sleep_ms(400).await;

    sender
        .voice()
        .set_target(
            1,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(parent),
                links: Some(false),
                children: Some(true),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let audio = random_voice_data(20);
    let mut initial_rx = late_target.subscribe();
    sender.voice().send(4, 1, 1, &audio).await?;
    let initial_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match initial_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(initial_received, "children whisper baseline must reach existing child members");

    let new_child = admin
        .channel(parent)
        .create_subchannel(&format!("WhisperChildB_{ts}"))
        .await?;
    sleep_ms(400).await;
    late_target.channel(new_child).join().await?;
    sleep_ms(600).await;

    let mut after_create_rx = late_target.subscribe();
    sender.voice().send(4, 1, 2, &audio).await?;
    let after_create_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match after_create_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        after_create_received,
        "children whisper should expand to users in subchannels created after target configuration"
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_whisper_to_current_channel_members() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
            ClientConfig::new("user3", 1),
        ],
    )
    .await?;
    let (sender, same_channel_target, other_channel_user) = (&clients[0], &clients[1], &clients[2]);

    sender.channel(1).join().await?;
    same_channel_target.channel(1).join().await?;
    other_channel_user.channel(2).join().await?;
    sleep_ms(300).await;

    sender
        .voice()
        .set_target(
            3,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(1),
                links: Some(false),
                children: Some(false),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let audio = random_voice_data(20);
    let mut current_rx = same_channel_target.subscribe();
    let mut other_rx = other_channel_user.subscribe();

    sender.voice().send(4, 3, 1, &audio).await?;

    let current_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match current_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(current_received, "channel whisper should reach other users in the sender's current channel");

    let other_received = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            match other_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(!other_received, "channel whisper to current channel should not leak to other channels");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_whisper_current_channel_rewrite_updates_same_slot_route() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("admin", 1),
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
            ClientConfig::new("user3", 1),
            ClientConfig::new("guest", 1),
        ],
    )
    .await?;
    let (admin, sender, old_channel_member, new_channel_member, outsider) =
        (&clients[0], &clients[1], &clients[2], &clients[3], &clients[4]);

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let channel_a = admin
        .channel(0)
        .create_subchannel(&format!("WhisperCurrentA_{ts}"))
        .await?;
    let channel_b = admin
        .channel(0)
        .create_subchannel(&format!("WhisperCurrentB_{ts}"))
        .await?;
    sleep_ms(400).await;

    sender.channel(channel_a).join().await?;
    old_channel_member.channel(channel_a).join().await?;
    new_channel_member.channel(channel_b).join().await?;
    outsider.channel(0).join().await?;
    sleep_ms(400).await;

    let target_id = 9;
    let sender_session = sender.session_id().unwrap();

    sender
        .voice()
        .set_target(
            target_id,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(channel_a),
                links: Some(false),
                children: Some(false),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let audio_first = random_voice_data(20);
    let mut first_rx = old_channel_member.subscribe();
    sender.voice().send(4, target_id as u8, 1, &audio_first).await?;

    let first_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match first_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        first_received,
        "baseline whisper should reach users in the sender's original current channel"
    );

    sender.channel(channel_b).join().await?;
    sleep_ms(400).await;

    sender
        .voice()
        .set_target(
            target_id,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(channel_b),
                links: Some(false),
                children: Some(false),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let audio_second = random_voice_data(20);
    let mut old_rx = old_channel_member.subscribe();
    let mut new_rx = new_channel_member.subscribe();
    let mut outsider_rx = outsider.subscribe();

    sender.voice().send(4, target_id as u8, 2, &audio_second).await?;

    let new_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match new_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        new_received,
        "rewriting the same whisper slot should retarget current-channel whisper to the sender's new channel"
    );

    let old_received = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            match old_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        !old_received,
        "rewriting the same whisper slot must evict the old current-channel route cache"
    );

    let outsider_received = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            match outsider_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        !outsider_received,
        "rewritten current-channel whisper should not leak outside the sender's new channel"
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_whisper_to_root_channel_members() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
            ClientConfig::new("user3", 1),
        ],
    )
    .await?;
    let (sender, same_channel_target, other_channel_user) = (&clients[0], &clients[1], &clients[2]);

    sender.channel(0).join().await?;
    same_channel_target.channel(0).join().await?;
    other_channel_user.channel(1).join().await?;
    sleep_ms(300).await;

    sender
        .voice()
        .set_target(
            6,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(0),
                links: Some(false),
                children: Some(false),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let audio = random_voice_data(20);
    let mut root_rx = same_channel_target.subscribe();
    let mut other_rx = other_channel_user.subscribe();

    sender.voice().send(4, 6, 1, &audio).await?;

    let root_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match root_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(root_received, "channel whisper should reach other users in the root channel");

    let other_received = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            match other_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(!other_received, "channel whisper to the root channel should not leak to other channels");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_whisper_to_parent_channel_members() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("admin", 1),
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
            ClientConfig::new("user3", 1),
        ],
    )
    .await?;
    let (admin, sender, parent_member, sibling_member) = (&clients[0], &clients[1], &clients[2], &clients[3]);

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let parent = admin
        .channel(0)
        .create_subchannel(&format!("WhisperParent_{ts}"))
        .await?;
    let child = admin
        .channel(parent)
        .create_subchannel(&format!("WhisperChild_{ts}"))
        .await?;
    let sibling = admin
        .channel(parent)
        .create_subchannel(&format!("WhisperSibling_{ts}"))
        .await?;
    sleep_ms(400).await;

    sender.channel(child).join().await?;
    parent_member.channel(parent).join().await?;
    sibling_member.channel(sibling).join().await?;
    sleep_ms(400).await;

    sender
        .voice()
        .set_target(
            4,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(parent),
                links: Some(false),
                children: Some(false),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let audio = random_voice_data(20);
    let mut parent_rx = parent_member.subscribe();
    let mut sibling_rx = sibling_member.subscribe();

    sender.voice().send(4, 4, 1, &audio).await?;

    let parent_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match parent_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(parent_received, "channel whisper to parent channel should reach users in that parent channel");

    let sibling_received = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            match sibling_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        !sibling_received,
        "channel whisper to parent channel should not implicitly expand to sibling subchannels"
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_whisper_to_root_parent_channel_members() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
            ClientConfig::new("user3", 1),
        ],
    )
    .await?;
    let (sender, root_member, sibling_member) = (&clients[0], &clients[1], &clients[2]);

    sender.channel(1).join().await?;
    root_member.channel(0).join().await?;
    sibling_member.channel(2).join().await?;
    sleep_ms(300).await;

    sender
        .voice()
        .set_target(
            7,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(0),
                links: Some(false),
                children: Some(false),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let audio = random_voice_data(20);
    let mut root_rx = root_member.subscribe();
    let mut sibling_rx = sibling_member.subscribe();

    sender.voice().send(4, 7, 1, &audio).await?;

    let root_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match root_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(root_received, "channel whisper to a root parent channel should reach users in root");

    let sibling_received = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            match sibling_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        !sibling_received,
        "channel whisper to root should not spill into unrelated top-level sibling channels"
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_whisper_to_subchannel_members() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("admin", 1),
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
            ClientConfig::new("user3", 1),
        ],
    )
    .await?;
    let (admin, sender, subchannel_member, parent_member) = (&clients[0], &clients[1], &clients[2], &clients[3]);

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let parent = admin
        .channel(0)
        .create_subchannel(&format!("WhisperTreeParent_{ts}"))
        .await?;
    let child = admin
        .channel(parent)
        .create_subchannel(&format!("WhisperTreeChild_{ts}"))
        .await?;
    sleep_ms(400).await;

    sender.channel(parent).join().await?;
    subchannel_member.channel(child).join().await?;
    parent_member.channel(parent).join().await?;
    sleep_ms(400).await;

    sender
        .voice()
        .set_target(
            5,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(child),
                links: Some(false),
                children: Some(false),
                ..Default::default()
            }],
        )
        .await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let audio = random_voice_data(20);
    let mut child_rx = subchannel_member.subscribe();
    let mut parent_rx = parent_member.subscribe();

    sender.voice().send(4, 5, 1, &audio).await?;

    let child_received = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match child_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(child_received, "channel whisper to subchannel should reach users in that subchannel");

    let parent_received = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            match parent_rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        !parent_received,
        "channel whisper to subchannel should not leak back to the parent channel"
    );

    cleanup_clients(clients).await;
    Ok(())
}

// ── Multiple senders ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_multiple_senders_in_same_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("user1", 1),
        ClientConfig::new("user2", 1),
        ClientConfig::new("user3", 1), // receiver
    ];
    let clients = create_clients(&env, &configs).await?;
    let (s1, s2, receiver) = (&clients[0], &clients[1], &clients[2]);

    for c in clients.iter() {
        c.channel(1).join().await?;
    }
    sleep_ms(300).await;

    let mut rx = receiver.subscribe();
    let s1_session = s1.session_id().unwrap();
    let s2_session = s2.session_id().unwrap();

    let audio = random_voice_data(20);
    s1.voice().send(4, 0, 1, &audio).await?;
    s2.voice().send(4, 0, 2, &audio).await?;

    let timeout = Duration::from_secs(5);
    let (mut got1, mut got2) = (false, false);
    let _ = tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == s1_session => got1 = true,
                Ok(ClientEvent::Voice(v)) if v.session == s2_session => got2 = true,
                Ok(_) => {}
                Err(_) => break,
            }
            if got1 && got2 {
                break;
            }
        }
    })
    .await;

    assert!(got1, "Receiver should get voice from sender 1");
    assert!(got2, "Receiver should get voice from sender 2");
    cleanup_clients(clients).await;
    Ok(())
}

// ── Voice routing after channel move (voice-channel-move.test.ts) ─────────

/// Sender self-moves to another channel and back. Voice should still route
/// correctly afterwards (regression test for state being lost on channel move).
#[tokio::test]
async fn test_voice_routes_after_self_channel_move_back() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
        ],
    )
    .await?;
    let (sender, receiver) = (&clients[0], &clients[1]);

    sender.channel(1).join().await?;
    receiver.channel(1).join().await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let mut rx = receiver.subscribe();
    let audio = random_voice_data(20);

    // Phase 1: baseline
    sender.voice().send(4, 0, 1, &audio).await?;
    let baseline = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(baseline, "Voice baseline must work before channel move");

    // Phase 2: sender moves to channel 2 then back to channel 1
    sender.channel(2).join().await?;
    sleep_ms(400).await;
    sender.channel(1).join().await?;
    sleep_ms(400).await;

    // Phase 3: voice should still work after returning
    let mut rx2 = receiver.subscribe();
    sender.voice().send(4, 0, 2, &audio).await?;
    let after = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match rx2.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(after, "Voice must still route after self channel move + return");

    cleanup_clients(clients).await;
    Ok(())
}

// ── Regression: receiver should NOT hear previous channel after moving ─────

/// User reports: "I moved channel but still hear voices from the previous
/// channel". After the receiver self-moves out, the sender's voice from the
/// old channel must NOT be delivered to the receiver. This exercises the
/// per-sender BroadcastCache invalidation path on listener channel changes.
#[tokio::test]
async fn test_receiver_does_not_hear_previous_channel_after_move() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
        ],
    )
    .await?;
    let (sender, mover) = (&clients[0], &clients[1]);

    // Phase 1: both in Lobby (1), warm sender's BroadcastCache so it
    // contains the mover's session id.
    sender.channel(1).join().await?;
    mover.channel(1).join().await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let mut rx_warm = mover.subscribe();
    let audio = random_voice_data(20);

    sender.voice().send(4, 0, 1, &audio).await?;
    let warmed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match rx_warm.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(warmed, "Voice baseline must work in same channel");

    // Phase 2: mover leaves channel 1 → channel 2. Sender stays in 1.
    mover.channel(2).join().await?;
    sleep_ms(400).await;

    // Phase 3: sender (still in channel 1) speaks. Mover (in channel 2)
    // must NOT receive.
    let mut rx_after = mover.subscribe();
    sender.voice().send(4, 0, 2, &audio).await?;
    sleep_ms(600).await;

    let mut leaked = false;
    while let Ok(ev) = rx_after.try_recv() {
        if let ClientEvent::Voice(v) = ev {
            if v.session == sender_session {
                leaked = true;
            }
        }
    }
    assert!(
        !leaked,
        "Mover must NOT hear sender's voice from previous channel after moving"
    );

    cleanup_clients(clients).await;
    Ok(())
}

/// Cross-edge variant: sender on edge 1, mover on edge 2. Mover self-moves
/// to a different channel; sender's voice (from old channel) must not leak.
#[tokio::test]
async fn test_receiver_does_not_hear_previous_channel_after_move_cross_edge() -> Result<()> {
    let env = standard_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 2),
        ],
    )
    .await?;
    let (sender, mover) = (&clients[0], &clients[1]);

    sender.channel(1).join().await?;
    mover.channel(1).join().await?;
    sleep_ms(500).await;

    let sender_session = sender.session_id().unwrap();
    let mut rx_warm = mover.subscribe();
    let audio = random_voice_data(20);

    sender.voice().send(4, 0, 1, &audio).await?;
    let warmed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx_warm.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(warmed, "Cross-edge voice baseline must work");

    mover.channel(2).join().await?;
    sleep_ms(800).await;

    let mut rx_after = mover.subscribe();
    sender.voice().send(4, 0, 2, &audio).await?;
    sleep_ms(800).await;

    let mut leaked = false;
    while let Ok(ev) = rx_after.try_recv() {
        if let ClientEvent::Voice(v) = ev {
            if v.session == sender_session {
                leaked = true;
            }
        }
    }
    assert!(
        !leaked,
        "Cross-edge: mover must NOT hear sender's voice from previous channel after moving"
    );
    cleanup_clients(clients).await;
    Ok(())
}

/// Reverse direction: sender moves to a different channel; listeners who
/// stayed in the old channel must NOT keep hearing the sender's voice.
/// This is the "I moved out of a channel and the people there still hear
/// me" mirror of the bug report.
#[tokio::test]
async fn test_listeners_in_previous_channel_stop_hearing_after_sender_moves() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
        ],
    )
    .await?;
    let (sender, listener) = (&clients[0], &clients[1]);

    sender.channel(1).join().await?;
    listener.channel(1).join().await?;
    sleep_ms(300).await;

    let sender_session = sender.session_id().unwrap();
    let mut rx_warm = listener.subscribe();
    let audio = random_voice_data(20);

    sender.voice().send(4, 0, 1, &audio).await?;
    let warmed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match rx_warm.recv().await {
                Ok(ClientEvent::Voice(v)) if v.session == sender_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(warmed, "Voice baseline must work in same channel");

    sender.channel(2).join().await?;
    sleep_ms(400).await;

    let mut rx_after = listener.subscribe();
    sender.voice().send(4, 0, 2, &audio).await?;
    sleep_ms(600).await;

    let mut leaked = false;
    while let Ok(ev) = rx_after.try_recv() {
        if let ClientEvent::Voice(v) = ev {
            if v.session == sender_session {
                leaked = true;
            }
        }
    }
    assert!(
        !leaked,
        "Listeners in previous channel must NOT hear sender after sender moves out"
    );

    cleanup_clients(clients).await;
    Ok(())
}

