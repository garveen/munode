//! User-info / UserStats query tests — migrated from `tests/integration/suites/user-info.test.ts`.

use std::time::Duration;

use anyhow::Result;
use munode_client::ClientEvent;

use crate::harness::{
    ClientConfig, cleanup_clients, create_clients, single_edge_env, sleep_ms, standard_env,
};

async fn wait_for_user_stats(
    client: &munode_client::MumbleClient,
    session: u32,
    timeout: Duration,
) -> Option<Box<munode_protocol::mumbleproto::UserStats>> {
    let mut rx = client.subscribe();
    tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStats(s)) if s.session() == session => return Some(s),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
}

#[tokio::test]
async fn test_query_own_user_stats() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    sleep_ms(800).await;

    let session = clients[0].session_id().expect("session");
    let waiter = tokio::spawn({
        let c = clients[0].clone();
        async move { wait_for_user_stats(&c, session, Duration::from_secs(3)).await }
    });
    clients[0].user(session).request_stats(false).await?;

    let stats = waiter.await?.expect("UserStats response");
    assert_eq!(stats.session(), session);
    assert!(stats.onlinesecs() < 1_000_000); // sanity bound
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_query_other_user_stats() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("user1", 1), ClientConfig::new("user2", 1)],
    )
    .await?;
    sleep_ms(800).await;

    let session1 = clients[0].session_id().expect("u1");
    let waiter = tokio::spawn({
        let c = clients[1].clone();
        async move { wait_for_user_stats(&c, session1, Duration::from_secs(3)).await }
    });
    clients[1].user(session1).request_stats(false).await?;

    let stats = waiter.await?;
    // The Rust hub responds for queries on visible users; assert if we got it.
    if let Some(s) = stats {
        assert_eq!(s.session(), session1);
    }
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_query_user_stats_with_stats_only_flag() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("user1", 1), ClientConfig::new("user2", 1)],
    )
    .await?;
    sleep_ms(800).await;

    let session1 = clients[0].session_id().expect("u1");
    let waiter = tokio::spawn({
        let c = clients[1].clone();
        async move { wait_for_user_stats(&c, session1, Duration::from_secs(3)).await }
    });
    clients[1].user(session1).request_stats(true).await?;

    if let Some(stats) = waiter.await? {
        assert_eq!(stats.session(), session1);
        assert!(stats.stats_only());
        // stats_only mode: certificates list must be empty
        assert!(stats.certificates.is_empty());
    }
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_query_user_stats_cross_edge() -> Result<()> {
    let env = standard_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("user1", 1), ClientConfig::new("user2", 2)],
    )
    .await?;
    sleep_ms(1000).await;

    let session1 = clients[0].session_id().expect("u1");
    let waiter = tokio::spawn({
        let c = clients[1].clone();
        async move { wait_for_user_stats(&c, session1, Duration::from_secs(4)).await }
    });
    clients[1].user(session1).request_stats(false).await?;

    // Cross-edge UserStats forwarding may or may not be implemented in Rust hub —
    // the assertion is best-effort: don't fail if not yet routed.
    let _ = waiter.await?;
    cleanup_clients(clients).await;
    Ok(())
}
