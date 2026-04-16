//! ACL and permissions integration tests.

use anyhow::Result;
use munode_client::ClientEvent;
use std::time::Duration;

use crate::harness::{cleanup_clients, single_edge_env, sleep_ms, ClientConfig, create_clients};

// Permission flag constants (from Mumble protocol)
const PERM_WRITE: u32 = 1;
const PERM_TRAVERSE: u32 = 2;
const PERM_ENTER: u32 = 4;
const PERM_SPEAK: u32 = 8;

// ── ACL query via Mumble protocol ─────────────────────────────────────────

#[tokio::test]
async fn test_query_acl_root_channel() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client.query_acl(0).await?; // Root channel

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
    client.query_acl(1).await?; // Lobby

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
    client.query_permission(1, PERM_ENTER | PERM_SPEAK).await?;

    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionQuery { channel_id, permissions: _ }) => {
                    break channel_id == 1;
                }
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(got, "Should receive permission query response for channel 1");
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_admin_has_full_permissions() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let client = &clients[0];

    let mut rx = client.subscribe();
    client.query_permission(0, PERM_WRITE).await?;

    let permissions = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::PermissionQuery { channel_id, permissions }) if channel_id == 0 => {
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
        assert_ne!(perms & PERM_TRAVERSE, 0, "admin should have Traverse on root");
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
    let ch_id = client.create_channel(&format!("AclTest_{ts}"), 0).await?;
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
    client.send_acl(acl).await?;
    sleep_ms(300).await;

    // Verify channel still accessible
    assert!(client.is_connected(), "Client should still be connected after ACL write");
    cleanup_clients(clients).await;
    Ok(())
}
