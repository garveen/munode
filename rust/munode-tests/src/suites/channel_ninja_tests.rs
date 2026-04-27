//! Channel Ninja feature integration tests.
//!
//! Verifies that when `channel_ninja.enabled = true` and a channel is in
//! `ninja_channels`, users without permission do NOT see anyone in that
//! channel — they receive UserRemove on entry, miss state changes, and miss
//! initial sync. Privileged group members still see ninja-channel users.

use std::time::Duration;

use anyhow::Result;
use munode_client::{ClientEvent, ConnectOptions, MumbleClient};
use munode_protocol::mumbleproto;
use serde_json::json;

use crate::harness::{sleep_ms, TestEnvBuilder};

const NINJA_CHANNEL_ID: u32 = 1;

// Permission flags (Mumble standard)
const PERM_TRAVERSE: u32 = 0x2;
const PERM_ENTER: u32 = 0x4;
const PERM_SPEAK: u32 = 0x8;
const PERM_LISTEN: u32 = 0x800;

async fn ninja_env(enabled: bool, port_base: u16) -> Result<crate::harness::TestEnvironment> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .port_base(port_base)
        .hub_config_patch(json!({
            "channel_ninja": {
                "enabled": enabled,
                "ninja_channels": [NINJA_CHANNEL_ID],
            }
        }))
        .start()
        .await?;

    // Configure ACL: deny all, allow ninja group
    let admin = MumbleClient::new();
    admin
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port: env.edge1(),
            username: "admin".into(),
            password: Some("admin123".into()),
            ..Default::default()
        })
        .await?;
    sleep_ms(800).await;

    let acl = mumbleproto::Acl {
        channel_id: NINJA_CHANNEL_ID,
        inherit_acls: Some(true),
        groups: vec![],
        acls: vec![
            mumbleproto::acl::ChanAcl {
                apply_here: Some(true),
                apply_subs: Some(false),
                inherited: Some(false),
                group: Some("all".into()),
                grant: Some(0),
                deny: Some(PERM_ENTER | PERM_LISTEN),
                user_id: None,
            },
            mumbleproto::acl::ChanAcl {
                apply_here: Some(true),
                apply_subs: Some(false),
                inherited: Some(false),
                group: Some("ninja".into()),
                grant: Some(PERM_ENTER | PERM_TRAVERSE | PERM_SPEAK | PERM_LISTEN),
                deny: Some(0),
                user_id: None,
            },
        ],
        query: Some(false),
    };
    admin.acl(NINJA_CHANNEL_ID).save(acl).await?;
    sleep_ms(500).await;
    let _ = admin.disconnect().await;
    Ok(env)
}

async fn connect(port: u16, user: &str, pass: &str) -> Result<MumbleClient> {
    let c = MumbleClient::new();
    c.connect(ConnectOptions {
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        password: Some(pass.into()),
        ..Default::default()
    })
    .await?;
    Ok(c)
}

// ── Suite: ninja ENABLED ──────────────────────────────────────────────────

#[tokio::test]
async fn test_ninja_enabled_initial_sync_hides_ninja_users() -> Result<()> {
    let env = ninja_env(true, 19400).await?;

    // ninja_user1 connects and moves into the ninja channel
    let ninja = connect(env.edge1(), "ninja_user1", "ninja_password").await?;
    sleep_ms(400).await;
    ninja.channel(NINJA_CHANNEL_ID).join().await?;
    sleep_ms(500).await;
    let ninja_session = ninja.session_id().expect("ninja session");

    // user1 (non-privileged) connects — must NOT see ninja_user1
    let normal = connect(env.edge1(), "user1", "password1").await?;
    sleep_ms(800).await;
    let visible = normal
        .users()
        .iter()
        .any(|u| u.session == ninja_session);
    assert!(
        !visible,
        "Unprivileged user must not see ninja-channel user in initial sync"
    );

    let _ = ninja.disconnect().await;
    let _ = normal.disconnect().await;
    Ok(())
}

#[tokio::test]
async fn test_ninja_enabled_move_into_emits_user_remove() -> Result<()> {
    let env = ninja_env(true, 19410).await?;

    let ninja = connect(env.edge1(), "ninja_user1", "ninja_password").await?;
    sleep_ms(300).await;
    // Ensure starting in root
    ninja.channel(0).join().await?;
    sleep_ms(400).await;

    let normal = connect(env.edge1(), "user1", "password1").await?;
    sleep_ms(700).await;

    let ninja_session = ninja.session_id().expect("ninja session");
    let visible_before = normal.users().iter().any(|u| u.session == ninja_session);
    assert!(visible_before, "ninja_user1 should be visible while in root");

    let mut rx = normal.subscribe();
    ninja.channel(NINJA_CHANNEL_ID).join().await?;

    let got_remove = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserLeft { session, .. }) if session == ninja_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got_remove, "Unprivileged observer should receive UserLeft on ninja entry");
    let _ = ninja.disconnect().await;
    let _ = normal.disconnect().await;
    Ok(())
}

#[tokio::test]
async fn test_ninja_enabled_move_out_emits_user_state() -> Result<()> {
    let env = ninja_env(true, 19420).await?;

    let ninja = connect(env.edge1(), "ninja_user1", "ninja_password").await?;
    sleep_ms(300).await;
    ninja.channel(NINJA_CHANNEL_ID).join().await?;
    sleep_ms(500).await;
    let ninja_session = ninja.session_id().expect("ninja session");

    let normal = connect(env.edge1(), "user1", "password1").await?;
    sleep_ms(700).await;
    let visible_at_login = normal.users().iter().any(|u| u.session == ninja_session);
    assert!(!visible_at_login, "ninja_user1 should be invisible at login");

    let mut rx = normal.subscribe();
    ninja.channel(0).join().await?;

    let appeared = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserJoined(u)) if u.session == ninja_session => break true,
                Ok(ClientEvent::UserStateChanged(s))
                    if s.session == ninja_session && s.channel_id == 0 =>
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

    assert!(appeared, "Unprivileged observer should see user reappear in root");
    let _ = ninja.disconnect().await;
    let _ = normal.disconnect().await;
    Ok(())
}

#[tokio::test]
async fn test_ninja_enabled_state_change_inside_not_forwarded() -> Result<()> {
    let env = ninja_env(true, 19430).await?;

    let ninja = connect(env.edge1(), "ninja_user1", "ninja_password").await?;
    sleep_ms(300).await;
    ninja.channel(NINJA_CHANNEL_ID).join().await?;
    sleep_ms(500).await;
    let ninja_session = ninja.session_id().expect("ninja session");

    let normal = connect(env.edge1(), "user1", "password1").await?;
    sleep_ms(700).await;

    let mut rx = normal.subscribe();
    ninja.me().set_mute(true).await?;

    let saw_state = tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(s)) if s.session == ninja_session => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        !saw_state,
        "Unprivileged observer should NOT receive state changes from ninja channel"
    );
    let _ = ninja.disconnect().await;
    let _ = normal.disconnect().await;
    Ok(())
}

#[tokio::test]
async fn test_ninja_enabled_privileged_user_sees_inhabitants() -> Result<()> {
    let env = ninja_env(true, 19440).await?;

    let ninja1 = connect(env.edge1(), "ninja_user1", "ninja_password").await?;
    sleep_ms(300).await;
    ninja1.channel(NINJA_CHANNEL_ID).join().await?;
    sleep_ms(500).await;
    let ninja1_session = ninja1.session_id().expect("session");

    // ninja_user2 is also in the ninja group → must see ninja_user1
    let ninja2 = connect(env.edge1(), "ninja_user2", "ninja_password").await?;
    sleep_ms(800).await;
    let visible = ninja2.users().iter().any(|u| u.session == ninja1_session);
    assert!(
        visible,
        "Privileged group member should see users in ninja channel"
    );

    let _ = ninja1.disconnect().await;
    let _ = ninja2.disconnect().await;
    Ok(())
}

// ── Suite: ninja DISABLED ─────────────────────────────────────────────────

#[tokio::test]
async fn test_ninja_disabled_move_into_broadcasts_user_state() -> Result<()> {
    let env = ninja_env(false, 19450).await?;

    let ninja = connect(env.edge1(), "ninja_user1", "ninja_password").await?;
    sleep_ms(300).await;
    let normal = connect(env.edge1(), "user1", "password1").await?;
    sleep_ms(700).await;

    let ninja_session = ninja.session_id().expect("ninja session");
    let mut rx = normal.subscribe();

    let mut got_move = false;
    let mut got_remove = false;

    ninja.channel(NINJA_CHANNEL_ID).join().await?;
    let _ = tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(s))
                    if s.session == ninja_session && s.channel_id == NINJA_CHANNEL_ID =>
                {
                    got_move = true;
                }
                Ok(ClientEvent::UserLeft { session, .. }) if session == ninja_session => {
                    got_remove = true;
                }
                Ok(_) => continue,
                Err(_) => break,
            }
            if got_move {
                break;
            }
        }
    })
    .await;

    assert!(got_move, "With ninja disabled, observer should receive UserState");
    assert!(!got_remove, "With ninja disabled, observer should NOT see UserLeft");
    let _ = ninja.disconnect().await;
    let _ = normal.disconnect().await;
    Ok(())
}
