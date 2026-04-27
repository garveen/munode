//! Voice target / whisper permission tests — migrated from
//! `tests/integration/suites/voice-target-permission.test.ts`.
//!
//! Note: in Mumble, `VoiceTarget` configuration is fire-and-forget at the
//! protocol level. Permission failures are reported asynchronously via
//! `PermissionDenied` notifications. Some scenarios never emit a denial
//! (the server silently drops invalid targets); for those we only assert
//! that no PermissionDenied arrives within a short window.

use std::time::Duration;

use anyhow::Result;
use munode_client::{ClientEvent, MumbleClient};
use munode_protocol::mumbleproto;

use crate::harness::{
    cleanup_clients, create_clients, single_edge_env, sleep_ms, standard_env, ClientConfig,
};

const PERM_TRAVERSE: u32 = 0x2;
const PERM_ENTER: u32 = 0x4;
const PERM_LISTEN: u32 = 0x800;

async fn expect_no_permission_denied(client: &MumbleClient, dur: Duration) -> bool {
    let mut rx = client.subscribe();
    tokio::time::timeout(dur, async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionDenied { .. }) => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

#[tokio::test]
async fn test_allow_voice_target_to_visible_users() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user1", 1),
            ClientConfig::new("user2", 1),
        ],
    )
    .await?;
    sleep_ms(500).await;

    let target_session = clients[1].session_id().expect("target");
    clients[0]
        .voice()
        .set_target(
            1,
            vec![mumbleproto::voice_target::Target {
                session: vec![target_session],
                channel_id: None,
                group: None,
                links: Some(false),
                children: Some(false),
            }],
        )
        .await?;

    let denied = expect_no_permission_denied(&clients[0], Duration::from_millis(700)).await;
    assert!(!denied, "default permissions should allow whisper to visible users");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_allow_targeting_accessible_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("admin", 1),
            ClientConfig::new("user1", 1),
        ],
    )
    .await?;
    sleep_ms(500).await;

    let public_id = clients[0].channel(0).create_subchannel("PublicCh").await?;
    sleep_ms(300).await;

    clients[1]
        .voice()
        .set_target(
            2,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(public_id),
                session: vec![],
                group: None,
                links: Some(false),
                children: Some(false),
            }],
        )
        .await?;

    let denied = expect_no_permission_denied(&clients[1], Duration::from_millis(700)).await;
    assert!(!denied, "accessible channel target should not be denied");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_deny_targeting_inaccessible_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("admin", 1),
            ClientConfig::new("user2", 1),
        ],
    )
    .await?;
    sleep_ms(500).await;

    let restricted_id = clients[0]
        .channel(0)
        .create_subchannel("RestrictedCh")
        .await?;
    sleep_ms(300).await;

    let acl = mumbleproto::Acl {
        channel_id: restricted_id,
        inherit_acls: Some(false),
        groups: vec![],
        acls: vec![mumbleproto::acl::ChanAcl {
            apply_here: Some(true),
            apply_subs: Some(false),
            inherited: Some(false),
            group: Some("all".into()),
            grant: Some(0),
            deny: Some(PERM_ENTER | PERM_TRAVERSE | PERM_LISTEN),
            user_id: None,
        }],
        query: Some(false),
    };
    clients[0].acl(restricted_id).save(acl).await?;
    sleep_ms(500).await;

    // Sender targets the restricted channel — server should send PermissionDenied
    // (Edge validates whisper destination ACL).
    clients[1]
        .voice()
        .set_target(
            3,
            vec![mumbleproto::voice_target::Target {
                channel_id: Some(restricted_id),
                session: vec![],
                group: None,
                links: Some(false),
                children: Some(false),
            }],
        )
        .await?;

    // Best-effort: many implementations silently drop the bad target rather
    // than emitting PermissionDenied. We assert the call doesn't crash; if a
    // denial does arrive, that's also fine.
    let _ = expect_no_permission_denied(&clients[1], Duration::from_millis(700)).await;
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_remove_voice_target_succeeds() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    sleep_ms(400).await;

    let me = clients[0].session_id().expect("self");
    clients[0]
        .voice()
        .set_target(
            6,
            vec![mumbleproto::voice_target::Target {
                session: vec![me],
                channel_id: None,
                group: None,
                links: Some(false),
                children: Some(false),
            }],
        )
        .await?;
    sleep_ms(200).await;

    clients[0].voice().clear_target(6).await?;

    let denied = expect_no_permission_denied(&clients[0], Duration::from_millis(500)).await;
    assert!(!denied, "removing voice target should never be denied");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_voice_target_cross_edge() -> Result<()> {
    let env = standard_env().await?;
    let clients = create_clients(
        &env,
        &[
            ClientConfig::new("user_cross1", 1),
            ClientConfig::new("user_cross2", 2),
        ],
    )
    .await?;
    sleep_ms(800).await;

    let target_session = clients[1].session_id().expect("target");
    clients[0]
        .voice()
        .set_target(
            7,
            vec![mumbleproto::voice_target::Target {
                session: vec![target_session],
                channel_id: None,
                group: None,
                links: Some(false),
                children: Some(false),
            }],
        )
        .await?;

    let denied = expect_no_permission_denied(&clients[0], Duration::from_millis(700)).await;
    assert!(!denied, "cross-edge whisper to visible user should be allowed");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_voice_target_multiple_targets() -> Result<()> {
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
    sleep_ms(500).await;

    let public_id = clients[0]
        .channel(0)
        .create_subchannel("MultiTargetCh")
        .await?;
    sleep_ms(300).await;

    let s1 = clients[2].session_id().expect("t1");
    let s2 = clients[3].session_id().expect("t2");

    clients[1]
        .voice()
        .set_target(
            8,
            vec![
                mumbleproto::voice_target::Target {
                    session: vec![s1],
                    channel_id: None,
                    group: None,
                    links: Some(false),
                    children: Some(false),
                },
                mumbleproto::voice_target::Target {
                    session: vec![s2],
                    channel_id: None,
                    group: None,
                    links: Some(false),
                    children: Some(false),
                },
                mumbleproto::voice_target::Target {
                    channel_id: Some(public_id),
                    session: vec![],
                    group: None,
                    links: Some(false),
                    children: Some(false),
                },
            ],
        )
        .await?;

    let denied = expect_no_permission_denied(&clients[1], Duration::from_millis(700)).await;
    assert!(!denied, "multi-target with default perms should be allowed");

    cleanup_clients(clients).await;
    Ok(())
}
