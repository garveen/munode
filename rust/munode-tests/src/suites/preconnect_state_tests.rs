//! Pre-connect state tests — migrated from `tests/integration/suites/preconnect-state.test.ts`.
//!
//! Verifies that a client which sets `pre_connect_state.self_mute` /
//! `self_deaf` immediately after `Authenticate` correctly broadcasts those
//! flags as part of the join, both on the same Edge and across Edges.

use anyhow::Result;
use munode_client::{ClientEvent, PreConnectState};
use std::time::Duration;

use crate::harness::{
    ClientConfig, cleanup_clients, create_clients, single_edge_env, sleep_ms, standard_env,
};

#[tokio::test]
async fn test_preconnect_self_deaf_broadcast() -> Result<()> {
    let env = single_edge_env().await?;

    // Observer connects first
    let observer_clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let observer = &observer_clients[0];
    sleep_ms(500).await;
    let mut rx = observer.subscribe();

    // Now user2 connects with pre-connect self_deaf=true
    let pcs = PreConnectState {
        self_mute: None,
        self_deaf: Some(true),
    };
    let user_clients = create_clients(
        &env,
        &[ClientConfig {
            username: "user2",
            edge: 1,
            channel_id: None,
            use_udp_voice: false,
            pre_connect_state: Some(pcs),
        }],
    )
    .await?;
    let user = &user_clients[0];

    // Wait for the user2 self_deaf state to propagate to observer
    let user_session = user.session_id().expect("user2 session");
    let got = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserStateChanged(u))
                    if u.session == user_session && u.self_deaf =>
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

    if !got {
        // Fallback: query observer's user list
        let users = observer.users();
        let u = users
            .iter()
            .find(|u| u.session == user_session)
            .expect("user2 visible");
        assert!(u.self_deaf, "observer should see user2.self_deaf=true");
    }

    // Local session should also reflect self_deaf
    let local = user.session().expect("local session");
    assert!(local.self_deaf, "local session should have self_deaf=true");

    cleanup_clients(user_clients).await;
    cleanup_clients(observer_clients).await;
    Ok(())
}

#[tokio::test]
async fn test_preconnect_self_mute_broadcast() -> Result<()> {
    let env = single_edge_env().await?;

    let observer_clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    sleep_ms(500).await;

    let pcs = PreConnectState {
        self_mute: Some(true),
        self_deaf: None,
    };
    let user_clients = create_clients(
        &env,
        &[ClientConfig {
            username: "user2",
            edge: 1,
            channel_id: None,
            use_udp_voice: false,
            pre_connect_state: Some(pcs),
        }],
    )
    .await?;
    sleep_ms(800).await;

    let user_session = user_clients[0].session_id().expect("session");
    let users = observer_clients[0].users();
    let u = users
        .iter()
        .find(|u| u.session == user_session)
        .expect("user2 visible");
    assert!(u.self_mute, "observer should see user2.self_mute=true");
    assert!(!u.self_deaf, "self_deaf should remain false");

    cleanup_clients(user_clients).await;
    cleanup_clients(observer_clients).await;
    Ok(())
}

#[tokio::test]
async fn test_preconnect_state_cross_edge() -> Result<()> {
    let env = standard_env().await?;

    // Observer on Edge 2
    let observer_clients = create_clients(&env, &[ClientConfig::new("user1", 2)]).await?;
    sleep_ms(500).await;

    // user2 connects to Edge 1 with both self_mute and self_deaf
    let pcs = PreConnectState {
        self_mute: Some(true),
        self_deaf: Some(true),
    };
    let user_clients = create_clients(
        &env,
        &[ClientConfig {
            username: "user2",
            edge: 1,
            channel_id: None,
            use_udp_voice: false,
            pre_connect_state: Some(pcs),
        }],
    )
    .await?;
    sleep_ms(1000).await;

    let user_session = user_clients[0].session_id().expect("session");
    let users = observer_clients[0].users();
    let u = users
        .iter()
        .find(|u| u.session == user_session)
        .expect("cross-edge user2 visible");
    assert!(u.self_mute, "cross-edge observer should see self_mute=true");
    assert!(u.self_deaf, "cross-edge observer should see self_deaf=true");

    cleanup_clients(user_clients).await;
    cleanup_clients(observer_clients).await;
    Ok(())
}
