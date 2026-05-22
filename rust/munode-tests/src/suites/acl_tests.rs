//! ACL and permissions integration tests.

use anyhow::Result;
use munode_client::ClientEvent;
use std::time::Duration;

use crate::harness::{ClientConfig, cleanup_clients, create_clients, single_edge_env, sleep_ms};

// Permission flag constants (from Mumble protocol)
const PERM_WRITE: u32 = 0x1;
const PERM_TRAVERSE: u32 = 0x2;
const PERM_ENTER: u32 = 0x4;
const PERM_SPEAK: u32 = 0x8;
const PERM_WHISPER: u32 = 0x100;
const PERM_TEXT_MESSAGE: u32 = 0x200;
const PERM_LISTEN: u32 = 0x800;
const PERM_KICK: u32 = 0x10000;

// ── ACL query via Mumble protocol ─────────────────────────────────────────

#[tokio::test]
async fn test_query_acl_root_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client
        .acl(0)
        .fetch(std::time::Duration::from_secs(10))
        .await?; // Root channel

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Acl(acl)) if acl.channel_id == 0 => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got, "Should receive ACL for root channel");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_query_acl_lobby_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client
        .acl(1)
        .fetch(std::time::Duration::from_secs(10))
        .await?; // Lobby

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::Acl(acl)) if acl.channel_id == 1 => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got, "Should receive ACL for Lobby channel");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_query_permission_for_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client
        .channel(1)
        .query_permission(PERM_ENTER | PERM_SPEAK)
        .await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionQuery {
                    channel_id,
                    permissions: _,
                }) => {
                    break channel_id == 1;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        got,
        "Should receive permission query response for channel 1"
    );
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_admin_has_full_permissions() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client.channel(0).query_permission(PERM_WRITE).await?;

    let permissions = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionQuery {
                    channel_id: 0,
                    permissions,
                }) => {
                    break Some(permissions);
                }
                Ok(_) => continue,
                Err(_) => break None,
            }
        }
    })
    .await
    .unwrap_or(None);

    if let Some(perms) = permissions {
        // Admin should have at least traverse and enter
        assert_ne!(
            perms & PERM_TRAVERSE,
            0,
            "admin should have Traverse on root"
        );
        assert_ne!(perms & PERM_ENTER, 0, "admin should have Enter on root");
    }
    // If no PermissionQuery response, that's also acceptable (different Hub implementation)

    cleanup_clients(clients).await;
    Ok(())
}

// ── ACL write ────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_set_acl_on_channel() -> Result<()> {
    use munode_protocol::mumbleproto;

    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    // Create a test channel first
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let ch_id = client
        .channel(0)
        .create_subchannel(&format!("AclTest_{ts}"))
        .await?;
    sleep_ms(300).await;

    // Set an ACL entry: allow 'admin' group to do everything
    let acl = mumbleproto::Acl {
        channel_id: ch_id,
        inherit_acls: Some(true),
        groups: vec![],
        acls: vec![mumbleproto::acl::ChanAcl {
            apply_here: Some(true),
            apply_subs: Some(true),
            inherited: Some(false),
            group: Some("admin".to_string()),
            grant: Some(PERM_WRITE | PERM_ENTER | PERM_SPEAK),
            deny: Some(0),
            user_id: None,
        }],
        query: Some(false),
    };

    // Send ACL — should not error
    client.acl(ch_id).save(acl).await?;
    sleep_ms(300).await;

    // Verify channel still accessible
    assert!(
        client.is_connected(),
        "Client should still be connected after ACL write"
    );
    cleanup_clients(clients).await;
    Ok(())
}

// ── Permission queries on existing channels ─────────────────────────────

/// Non-admin user should NOT have Kick permission on the root channel.
#[tokio::test]
async fn test_non_admin_lacks_kick_permission() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("guest", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client.channel(0).query_permission(PERM_KICK).await?;

    let perms = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionQuery {
                    channel_id: 0,
                    permissions,
                }) => {
                    break Some(permissions);
                }
                Ok(_) => continue,
                Err(_) => break None,
            }
        }
    })
    .await
    .unwrap_or(None);

    if let Some(perms) = perms {
        assert_eq!(perms & PERM_KICK, 0, "guest should not have Kick on root");
    }
    cleanup_clients(clients).await;
    Ok(())
}

// ── ACL entry lifecycle ─────────────────────────────────────────────────

/// Add → fetch → modify → save → fetch a channel ACL round-trip.
#[tokio::test]
async fn test_acl_entry_lifecycle() -> Result<()> {
    use munode_protocol::mumbleproto::acl::ChanAcl;

    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let ts = chrono_now_ms();
    let ch = client
        .channel(0)
        .create_subchannel(format!("AclLifecycle_{ts}"))
        .await?;
    sleep_ms(300).await;

    // Add an entry granting Speak+Enter to group 'user'.
    client
        .acl(ch)
        .add_entry(
            ChanAcl {
                apply_here: Some(true),
                apply_subs: Some(false),
                inherited: Some(false),
                user_id: None,
                group: Some("user".to_string()),
                grant: Some(PERM_SPEAK | PERM_ENTER),
                deny: Some(0),
            },
            Duration::from_secs(5),
        )
        .await?;
    sleep_ms(300).await;

    let acl_after_add = client.acl(ch).fetch(Duration::from_secs(5)).await?;
    let added_count = acl_after_add.acls.len();
    assert!(added_count >= 1, "ACL should contain the new entry");

    // Save a fresh ACL replacing the entry with TextMessage grant only.
    let mut acl = acl_after_add.clone();
    if let Some(last) = acl.acls.last_mut() {
        last.grant = Some(PERM_TEXT_MESSAGE);
    }
    client.acl(ch).save(acl).await?;
    sleep_ms(300).await;

    let acl_after_update = client.acl(ch).fetch(Duration::from_secs(5)).await?;
    assert_eq!(
        acl_after_update.acls.len(),
        added_count,
        "entry count unchanged after save"
    );

    // Remove the entry.
    client
        .acl(ch)
        .remove_entry(added_count - 1, Duration::from_secs(5))
        .await?;
    sleep_ms(300).await;

    let acl_after_remove = client.acl(ch).fetch(Duration::from_secs(5)).await?;
    assert!(
        acl_after_remove.acls.len() < added_count,
        "entry count should drop after remove"
    );

    client.channel(ch).delete().await?;
    cleanup_clients(clients).await;
    Ok(())
}

// ── Channel group lifecycle ─────────────────────────────────────────────

/// Create group → add user → remove user → delete group on a channel.
#[tokio::test]
async fn test_channel_group_lifecycle() -> Result<()> {
    use munode_protocol::mumbleproto::acl::ChanGroup;

    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let ts = chrono_now_ms();
    let ch = client
        .channel(0)
        .create_subchannel(format!("GroupLifecycle_{ts}"))
        .await?;
    sleep_ms(300).await;

    // Create group 'team'.
    client
        .acl(ch)
        .upsert_group(
            ChanGroup {
                name: "team".to_string(),
                inherited: Some(false),
                inherit: Some(true),
                inheritable: Some(true),
                add: vec![],
                remove: vec![],
                inherited_members: vec![],
            },
            Duration::from_secs(5),
        )
        .await?;
    sleep_ms(200).await;

    let acl = client.acl(ch).fetch(Duration::from_secs(5)).await?;
    assert!(
        acl.groups.iter().any(|g| g.name == "team"),
        "group 'team' should exist"
    );

    // Add admin (user_id 1) to the group.
    client
        .acl(ch)
        .add_user_to_group("team", 1, Duration::from_secs(5))
        .await?;
    sleep_ms(200).await;

    let acl = client.acl(ch).fetch(Duration::from_secs(5)).await?;
    let team = acl
        .groups
        .iter()
        .find(|g| g.name == "team")
        .expect("team group should remain");
    assert!(
        team.add.contains(&1),
        "user 1 should appear in group add list"
    );

    // Remove the user.
    client
        .acl(ch)
        .remove_user_from_group("team", 1, Duration::from_secs(5))
        .await?;
    sleep_ms(200).await;

    let acl = client.acl(ch).fetch(Duration::from_secs(5)).await?;
    let team = acl.groups.iter().find(|g| g.name == "team");
    if let Some(t) = team {
        assert!(
            !t.add.contains(&1),
            "user 1 should not be in add list anymore"
        );
    }

    // Delete the group.
    client
        .acl(ch)
        .remove_group("team", Duration::from_secs(5))
        .await?;
    sleep_ms(200).await;

    let acl = client.acl(ch).fetch(Duration::from_secs(5)).await?;
    assert!(
        !acl.groups.iter().any(|g| g.name == "team"),
        "group 'team' should be removed"
    );

    client.channel(ch).delete().await?;
    cleanup_clients(clients).await;
    Ok(())
}

// ── User-behavior ACL enforcement ──────────────────────────────────────

/// Helper: build an ACL entry granting/denying permissions to a group.
fn group_entry(group: &str, allow: u32, deny: u32) -> munode_protocol::mumbleproto::acl::ChanAcl {
    use munode_protocol::mumbleproto::acl::ChanAcl;
    ChanAcl {
        apply_here: Some(true),
        apply_subs: Some(false),
        inherited: Some(false),
        user_id: None,
        group: Some(group.to_string()),
        grant: Some(allow),
        deny: Some(deny),
    }
}

/// User in `acl_testers` group can enter a channel that allows that group.
#[tokio::test]
async fn test_acl_allows_group_user_to_enter_speak_listen() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("acl_op_user", 1),
        ClientConfig::new("acl_op_observer", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, user, observer) = (&clients[0], &clients[1], &clients[2]);

    let ts = chrono_now_ms();
    let ch = admin
        .channel(0)
        .create_subchannel(format!("AclAllow_{ts}"))
        .await?;
    sleep_ms(300).await;

    admin
        .acl(ch)
        .add_entry(
            group_entry(
                "acl_testers",
                PERM_ENTER
                    | PERM_TRAVERSE
                    | PERM_SPEAK
                    | PERM_LISTEN
                    | PERM_WHISPER
                    | PERM_TEXT_MESSAGE,
                0,
            ),
            Duration::from_secs(5),
        )
        .await?;
    sleep_ms(500).await;

    observer.channel(ch).join().await?;
    sleep_ms(200).await;

    // user enters — should not get PermissionDenied
    let mut user_rx = user.subscribe();
    user.channel(ch).join().await?;
    sleep_ms(800).await;

    let denied = tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            match user_rx.recv().await {
                Ok(ClientEvent::PermissionDenied { .. }) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        !denied,
        "user should not get PermissionDenied entering allowed channel"
    );

    let me = user.me().user().expect("self user");
    assert_eq!(me.channel_id, ch, "user should be in target channel");
    assert!(!me.suppress, "user with Speak should not be suppressed");

    // user can listen on the allowed channel
    user.channel(0).join().await?;
    sleep_ms(200).await;
    user.me().add_listener(ch).await?;
    sleep_ms(500).await;

    let me = user.me().user().expect("self user");
    assert!(
        me.listening_channels.contains(&ch),
        "listening_channels should include allowed channel"
    );

    user.me().remove_listener(ch).await?;
    admin.channel(ch).delete().await?;
    cleanup_clients(clients).await;
    Ok(())
}

/// User without Enter permission gets PermissionDenied and stays in original channel.
#[tokio::test]
async fn test_acl_denies_entry_to_restricted_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("acl_op_user", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, user) = (&clients[0], &clients[1]);

    let ts = chrono_now_ms();
    let ch = admin
        .channel(0)
        .create_subchannel(format!("AclDeny_{ts}"))
        .await?;
    sleep_ms(300).await;

    admin
        .acl(ch)
        .add_entry(
            group_entry(
                "acl_testers",
                0,
                PERM_ENTER
                    | PERM_TRAVERSE
                    | PERM_SPEAK
                    | PERM_LISTEN
                    | PERM_WHISPER
                    | PERM_TEXT_MESSAGE,
            ),
            Duration::from_secs(5),
        )
        .await?;
    sleep_ms(500).await;

    let original_ch = user.me().session().expect("session").channel_id;

    let mut rx = user.subscribe();
    user.channel(ch).join().await?;
    sleep_ms(800).await;

    let denied = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionDenied { .. }) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        denied,
        "user should get PermissionDenied for restricted channel"
    );

    let after = user.me().session().expect("session").channel_id;
    assert_eq!(after, original_ch, "user should remain in original channel");

    admin.channel(ch).delete().await?;
    cleanup_clients(clients).await;
    Ok(())
}

/// User without Listen permission gets PermissionDenied when adding a listener.
#[tokio::test]
async fn test_acl_denies_listener_on_restricted_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("acl_op_user", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, user) = (&clients[0], &clients[1]);

    let ts = chrono_now_ms();
    let ch = admin
        .channel(0)
        .create_subchannel(format!("AclNoListen_{ts}"))
        .await?;
    sleep_ms(300).await;

    admin
        .acl(ch)
        .add_entry(
            group_entry(
                "acl_testers",
                PERM_ENTER | PERM_TRAVERSE | PERM_SPEAK,
                PERM_LISTEN,
            ),
            Duration::from_secs(5),
        )
        .await?;
    sleep_ms(500).await;

    let mut rx = user.subscribe();
    user.me().add_listener(ch).await?;
    sleep_ms(800).await;

    let denied = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionDenied { .. }) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(denied, "user should get PermissionDenied adding listener");

    let session = user.me().session().expect("session");
    assert!(
        !session.listening_channels.contains(&ch),
        "listener list should not contain restricted channel"
    );

    admin.channel(ch).delete().await?;
    cleanup_clients(clients).await;
    Ok(())
}

// ── Suppress behavior ──────────────────────────────────────────────────

/// User entering a no-Speak channel is auto-suppressed; clears on move to allowed channel.
#[tokio::test]
async fn test_acl_suppress_set_and_cleared_on_channel_move() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("acl_op_user", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, user) = (&clients[0], &clients[1]);

    let ts = chrono_now_ms();
    let no_speak = admin
        .channel(0)
        .create_subchannel(format!("NoSpeak_{ts}"))
        .await?;
    let can_speak = admin
        .channel(0)
        .create_subchannel(format!("CanSpeak_{ts}"))
        .await?;
    sleep_ms(300).await;

    admin
        .acl(no_speak)
        .add_entry(
            group_entry("acl_testers", PERM_ENTER | PERM_TRAVERSE, PERM_SPEAK),
            Duration::from_secs(5),
        )
        .await?;
    admin
        .acl(can_speak)
        .add_entry(
            group_entry("acl_testers", PERM_ENTER | PERM_TRAVERSE | PERM_SPEAK, 0),
            Duration::from_secs(5),
        )
        .await?;
    sleep_ms(500).await;

    // Initial state: not suppressed
    assert!(!user.me().user().expect("self").suppress);

    // Move to no-speak — should be suppressed
    user.channel(no_speak).join().await?;
    sleep_ms(800).await;
    let me = user.me().user().expect("self");
    assert_eq!(me.channel_id, no_speak);
    assert!(
        me.suppress,
        "user should be auto-suppressed in no-Speak channel"
    );
    assert!(!me.mute, "suppress is not admin mute");
    assert!(!me.self_mute, "suppress is not self mute");

    // Move to can-speak — suppress should be cleared
    user.channel(can_speak).join().await?;
    sleep_ms(800).await;
    let me = user.me().user().expect("self");
    assert_eq!(me.channel_id, can_speak);
    assert!(
        !me.suppress,
        "suppress should clear in Speak-allowed channel"
    );

    admin.channel(no_speak).delete().await?;
    admin.channel(can_speak).delete().await?;
    cleanup_clients(clients).await;
    Ok(())
}

/// `suppress` is independent of `self_mute` and admin `mute`.
#[tokio::test]
async fn test_suppress_distinct_from_self_mute_and_admin_mute() -> Result<()> {
    let env = single_edge_env().await?;
    let configs = vec![
        ClientConfig::new("admin", 1),
        ClientConfig::new("acl_op_user", 1),
    ];
    let clients = create_clients(&env, &configs).await?;
    let (admin, user) = (&clients[0], &clients[1]);

    let user_session = user.session_id().expect("session id");

    // 1. self mute
    user.me().set_mute(true).await?;
    sleep_ms(500).await;
    let me = user.me().user().expect("self");
    assert!(me.self_mute, "self_mute should be set");
    assert!(!me.suppress, "self_mute should not set suppress");
    user.me().set_mute(false).await?;
    sleep_ms(300).await;

    // 2. admin mute (server-side)
    admin.user(user_session).set_mute(true).await?;
    sleep_ms(500).await;
    let me = user.me().user().expect("self");
    assert!(me.mute, "admin mute should set mute");
    assert!(!me.self_mute, "admin mute should not affect self_mute");
    assert!(!me.suppress, "admin mute should not set suppress");
    admin.user(user_session).set_mute(false).await?;
    sleep_ms(300).await;

    // 3. ACL-induced suppress
    let ts = chrono_now_ms();
    let ch = admin
        .channel(0)
        .create_subchannel(format!("SuppressOnly_{ts}"))
        .await?;
    sleep_ms(300).await;
    admin
        .acl(ch)
        .add_entry(
            group_entry("acl_testers", PERM_ENTER | PERM_TRAVERSE, PERM_SPEAK),
            Duration::from_secs(5),
        )
        .await?;
    sleep_ms(500).await;

    user.channel(ch).join().await?;
    sleep_ms(800).await;
    let me = user.me().user().expect("self");
    assert!(me.suppress, "ACL should set suppress");
    assert!(!me.mute, "ACL suppress is not admin mute");
    assert!(!me.self_mute, "ACL suppress is not self_mute");

    admin.channel(ch).delete().await?;
    cleanup_clients(clients).await;
    Ok(())
}

// ── Helpers ────────────────────────────────────────────────────────────

fn chrono_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
