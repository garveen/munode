//! Edge restart / reconnection tests — migrated from
//! `tests/integration/suites/edge-reconnect.test.ts`. The original TS test
//! only inspected internal TS-server fields. Here we test the actually
//! observable behavior: an Edge process crash + restart, with the cluster
//! recovering and clients able to reconnect.

use anyhow::Result;
use munode_client::{ConnectOptions, MumbleClient};

use crate::harness::{ClientConfig, cleanup_clients, create_clients, sleep_ms, standard_env};

#[tokio::test]
async fn test_cluster_survives_edge_restart() -> Result<()> {
    let mut env = standard_env().await?;

    // Connect a client on Edge 2 and verify cluster membership.
    let clients_e2 = create_clients(&env, &[ClientConfig::new("user1", 2)]).await?;
    sleep_ms(500).await;
    assert!(clients_e2[0].is_connected(), "client on Edge 2 connected");

    // Kill and respawn Edge 1.
    env.restart_edge(1).await?;
    sleep_ms(2000).await;

    // After restart, a fresh client should be able to log in to Edge 1.
    let port_e1 = env.edge1();
    let new_client = MumbleClient::new();
    new_client
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port: port_e1,
            username: "user2".into(),
            password: Some("password2".into()),
            reject_unauthorized: false,
            ..Default::default()
        })
        .await?;
    sleep_ms(800).await;
    assert!(
        new_client.is_connected(),
        "client should reconnect to restarted Edge 1"
    );

    // The Edge-2 client must still be connected (it never went down).
    assert!(
        clients_e2[0].is_connected(),
        "Edge 2 client should remain connected across Edge 1 restart"
    );

    let _ = new_client.disconnect().await;
    cleanup_clients(clients_e2).await;
    Ok(())
}

#[tokio::test]
async fn test_two_edge_cluster_initial_state() -> Result<()> {
    // Sanity check matching the original TS "should establish cluster with 2 edges".
    let env = standard_env().await?;
    let clients = create_clients(
        &env,
        &[ClientConfig::new("user1", 1), ClientConfig::new("user2", 2)],
    )
    .await?;
    sleep_ms(800).await;

    // Cross-edge visibility: each sees the other.
    let users_a = clients[0].users();
    let users_b = clients[1].users();
    assert!(
        users_a.iter().any(|u| u.name == "user2"),
        "Edge 1 client should see Edge 2 user"
    );
    assert!(
        users_b.iter().any(|u| u.name == "user1"),
        "Edge 2 client should see Edge 1 user"
    );

    cleanup_clients(clients).await;
    Ok(())
}
