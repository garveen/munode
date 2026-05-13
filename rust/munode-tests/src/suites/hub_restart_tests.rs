//! Hub restart user-sync test — migrated from `tests/integration/suites/hub-restart.test.ts`.
//!
//! Two clients (A, B) on the same Edge. Hub is restarted while both stay
//! connected. After restart, neither client should see duplicate users; A
//! should still see B and vice versa.

use anyhow::Result;

use crate::harness::{ClientConfig, cleanup_clients, create_clients, single_edge_env, sleep_ms};

#[tokio::test]
async fn test_user_sync_after_hub_restart() -> Result<()> {
    let mut env = single_edge_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("user1", 1), ClientConfig::new("user2", 1)],
    )
    .await?;
    sleep_ms(800).await;

    // Sanity: each sees the other before restart
    let users_a_pre = clients[0].users();
    let users_b_pre = clients[1].users();
    assert!(
        users_a_pre.iter().any(|u| u.name == "user2"),
        "A should see B before restart"
    );
    assert!(
        users_b_pre.iter().any(|u| u.name == "user1"),
        "B should see A before restart"
    );

    // Restart the Hub binary with the same config.
    env.restart_hub().await?;

    // Wait for Edge to reconnect & resync state.
    sleep_ms(4000).await;

    // Both clients should remain connected (Edge handles Hub reconnect transparently).
    assert!(clients[0].is_connected(), "A should remain connected");
    assert!(clients[1].is_connected(), "B should remain connected");

    let users_a = clients[0].users();
    let users_b = clients[1].users();

    // No duplicate user names.
    let names_a: Vec<&str> = users_a.iter().map(|u| u.name.as_str()).collect();
    let names_b: Vec<&str> = users_b.iter().map(|u| u.name.as_str()).collect();
    let unique_a: std::collections::HashSet<&str> = names_a.iter().copied().collect();
    let unique_b: std::collections::HashSet<&str> = names_b.iter().copied().collect();
    assert_eq!(
        names_a.len(),
        unique_a.len(),
        "A user list has duplicates: {:?}",
        names_a
    );
    assert_eq!(
        names_b.len(),
        unique_b.len(),
        "B user list has duplicates: {:?}",
        names_b
    );

    // Each still sees the other exactly once.
    let a_seen_by_b = users_b.iter().filter(|u| u.name == "user1").count();
    let b_seen_by_a = users_a.iter().filter(|u| u.name == "user2").count();
    assert_eq!(a_seen_by_b, 1, "B should see A exactly once after restart");
    assert_eq!(b_seen_by_a, 1, "A should see B exactly once after restart");

    cleanup_clients(clients).await;
    Ok(())
}
