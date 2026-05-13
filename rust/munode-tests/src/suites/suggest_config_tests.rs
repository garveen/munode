//! SuggestConfig integration tests — migrated from
//! `tests/integration/suites/suggest-config.test.ts`.

use std::time::Duration;

use anyhow::Result;
use munode_client::{ClientEvent, ConnectOptions, MumbleClient};
use serde_json::json;

use crate::harness::{TestEnvBuilder, TestEnvironment, sleep_ms};
use crate::users::find_user;

async fn env_with_suggest(suggest: serde_json::Value) -> Result<TestEnvironment> {
    TestEnvBuilder::new()
        .edges(1)
        .hub_config_patch(json!({ "suggest": suggest }))
        .start()
        .await
}

async fn env_no_suggest() -> Result<TestEnvironment> {
    TestEnvBuilder::new().edges(1).start().await
}

/// Connect with a pre-subscribed broadcast receiver so SuggestConfig (which
/// may arrive immediately after ServerSync) is never lost.
async fn connect_with_subscriber(
    env: &TestEnvironment,
    username: &str,
) -> Result<(MumbleClient, tokio::sync::broadcast::Receiver<ClientEvent>)> {
    let user = find_user(username).expect("test user");
    let client = MumbleClient::new();
    let rx = client.subscribe();
    client
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port: env.edge1(),
            username: username.to_string(),
            password: Some(user.password.to_string()),
            reject_unauthorized: false,
            force_tcp_voice: true,
            connect_timeout: Duration::from_secs(10),
            ..Default::default()
        })
        .await?;
    Ok((client, rx))
}

async fn await_suggest(
    rx: &mut tokio::sync::broadcast::Receiver<ClientEvent>,
    timeout: Duration,
) -> Option<munode_protocol::mumbleproto::SuggestConfig> {
    tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::SuggestConfig(msg)) => return Some(msg),
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
async fn test_receives_suggest_config_when_configured() -> Result<()> {
    let env = env_with_suggest(json!({
        "version": "20.114.125",
        "positional": true,
        "push_to_talk": false,
    }))
    .await?;

    let (client, mut rx) = connect_with_subscriber(&env, "user1").await?;
    let cfg = await_suggest(&mut rx, Duration::from_secs(3))
        .await
        .expect("expected SuggestConfig event");

    // version v1 = (20<<16) | (114<<8) | 125 = 1340029
    assert_eq!(cfg.version, Some(1_340_029));
    assert_eq!(cfg.positional, Some(true));
    assert_eq!(cfg.push_to_talk, Some(false));

    let _ = client.disconnect().await;
    Ok(())
}

#[tokio::test]
async fn test_suggest_config_version_only() -> Result<()> {
    let env = env_with_suggest(json!({ "version": "20.114.125" })).await?;
    let (client, mut rx) = connect_with_subscriber(&env, "user2").await?;
    let cfg = await_suggest(&mut rx, Duration::from_secs(3))
        .await
        .expect("expected SuggestConfig event");
    assert_eq!(cfg.version, Some(1_340_029));
    let _ = client.disconnect().await;
    Ok(())
}

#[tokio::test]
async fn test_no_suggest_config_when_unconfigured() -> Result<()> {
    let env = env_no_suggest().await?;
    let (client, mut rx) = connect_with_subscriber(&env, "user1").await?;
    sleep_ms(800).await;

    // Drain the receiver looking for SuggestConfig — must not appear.
    let got_suggest = await_suggest(&mut rx, Duration::from_millis(800)).await;
    assert!(
        got_suggest.is_none(),
        "should NOT receive SuggestConfig when unconfigured"
    );

    let _ = client.disconnect().await;
    Ok(())
}
