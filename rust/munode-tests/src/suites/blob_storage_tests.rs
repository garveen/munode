//! Blob storage tests — migrated from `tests/integration/suites/blob-storage.test.ts`.
//!
//! Tests texture and comment storage via the Mumble protocol against the Rust
//! Hub + Edge binary pair. Only the client-protocol-observable behaviour is
//! exercised (no direct server API).

use std::time::Duration;

use anyhow::Result;
use munode_client::User;

use crate::harness::{ClientConfig, cleanup_clients, create_clients, single_edge_env, sleep_ms};

fn find_user_by_name<'a>(users: &'a [User], name: &str) -> Option<&'a User> {
    users
        .iter()
        .find(|u| u.name == name || (name == "admin" && u.name == "Administrator"))
}

async fn wait_for_user<F>(
    client: &munode_client::MumbleClient,
    wait: Duration,
    predicate: F,
) -> Option<User>
where
    F: Fn(&User) -> bool,
{
    let deadline = std::time::Instant::now() + wait;
    while std::time::Instant::now() < deadline {
        if let Some(user) = client.users().into_iter().find(|user| predicate(user)) {
            return Some(user);
        }
        sleep_ms(100).await;
    }
    None
}

#[tokio::test]
async fn test_texture_hash_broadcast_for_large_textures() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("admin", 1), ClientConfig::new("user1", 1)],
    )
    .await?;
    sleep_ms(500).await;

    let texture: Vec<u8> = (0..200u32).map(|i| (i % 256) as u8).collect();
    clients[0].me().set_texture(texture).await?;
    let admin = wait_for_user(&clients[1], Duration::from_secs(5), |user| {
        (user.name == "admin" || user.name == "Administrator")
            && user
                .texture_hash
                .as_ref()
                .is_some_and(|hash| !hash.is_empty())
    })
    .await
    .expect("admin user visible");
    assert!(
        admin.texture_hash.as_ref().is_some_and(|h| !h.is_empty()),
        "admin should have a texture_hash for large texture"
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_identical_textures_produce_same_hash() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("admin", 1), ClientConfig::new("user1", 1)],
    )
    .await?;
    sleep_ms(500).await;

    let texture = vec![0xab_u8; 200];
    clients[0].me().set_texture(texture.clone()).await?;
    let hash0 = wait_for_user(&clients[1], Duration::from_secs(5), |user| {
        (user.name == "admin" || user.name == "Administrator")
            && user
                .texture_hash
                .as_ref()
                .is_some_and(|hash| !hash.is_empty())
    })
    .await
    .and_then(|user| user.texture_hash.clone());

    clients[1].me().set_texture(texture).await?;
    let hash1 = wait_for_user(&clients[0], Duration::from_secs(5), |user| {
        user.name == "user1"
            && user
                .texture_hash
                .as_ref()
                .is_some_and(|hash| !hash.is_empty())
    })
    .await
    .and_then(|user| user.texture_hash.clone());

    assert!(hash0.is_some(), "admin texture_hash missing");
    assert!(hash1.is_some(), "user1 texture_hash missing");
    assert_eq!(hash0, hash1, "identical textures should hash equal");

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_comment_hash_broadcast_for_long_comments() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("admin", 1), ClientConfig::new("user1", 1)],
    )
    .await?;
    sleep_ms(500).await;

    let long_comment = "X".repeat(200);
    clients[0].me().set_comment(long_comment).await?;
    sleep_ms(1000).await;

    let users = clients[1].users();
    let admin = find_user_by_name(&users, "admin").expect("admin visible");
    assert!(
        admin.comment_hash.as_ref().is_some_and(|h| !h.is_empty()),
        "long comment should produce a comment_hash"
    );

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_request_user_comment_returns_full_text() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("admin", 1), ClientConfig::new("user1", 1)],
    )
    .await?;
    sleep_ms(500).await;

    let long_comment = "Long comment for RequestBlob test. ".repeat(6);
    assert!(long_comment.len() > 128);

    clients[0].me().set_comment(long_comment.clone()).await?;
    sleep_ms(1000).await;

    let admin_session = clients[0].session_id().expect("admin session");
    clients[1].user(admin_session).request_comment().await?;

    // Wait for the blob to arrive
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut got = None;
    while std::time::Instant::now() < deadline {
        if let Some(u) = clients[1]
            .users()
            .into_iter()
            .find(|u| u.session == admin_session)
            && u.comment.as_deref() == Some(long_comment.as_str())
        {
            got = u.comment.clone();
            break;
        }
        sleep_ms(100).await;
    }
    assert_eq!(got.as_deref(), Some(long_comment.as_str()));

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_utf8_comment_handled_without_error() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let utf8_comment = "这是中文评论 🎵 emoji test";
    clients[0].me().set_comment(utf8_comment).await?;
    sleep_ms(500).await;
    cleanup_clients(clients).await;
    Ok(())
}
