//! Validation rules integration tests.
//!
//! Covers username and channel-name regex enforcement previously exercised by
//! `tests/integration/suites/validation-rules.test.ts`.

use std::time::Duration;

use anyhow::Result;
use munode_client::{ClientEvent, ConnectOptions, MumbleClient, RejectType};
use serde_json::json;

use crate::harness::{ClientConfig, TestEnvBuilder, cleanup_clients, create_clients, sleep_ms};

fn username_validation_patch() -> serde_json::Value {
    json!({
        "auth": {
            "allow_guest": true,
            "require_auth_service": false
        },
        "validation": {
            "username_regex": "^[a-zA-Z][a-zA-Z0-9_]{1,29}$",
            "channel_name_regex": "^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,59}$"
        }
    })
}

fn channel_validation_patch() -> serde_json::Value {
    json!({
        "validation": {
            "channel_name_regex": "^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,59}$"
        }
    })
}

async fn try_connect_capture_reject_kind(port: u16, username: &'static str) -> Option<RejectType> {
    let client = MumbleClient::new();
    let mut rx = client.subscribe();
    let handle = tokio::spawn(async move {
        let _ = client
            .connect(ConnectOptions {
                host: "127.0.0.1".into(),
                port,
                username: username.to_string(),
                password: Some(String::new()),
                reject_unauthorized: false,
                force_tcp_voice: true,
                connect_timeout: Duration::from_secs(10),
                ..Default::default()
            })
            .await;
    });

    let kind = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::AuthenticationFailed { kind, .. }) => break Some(kind),
                Ok(_) => continue,
                Err(_) => break None,
            }
        }
    })
    .await
    .unwrap_or(None);

    let _ = handle.await;
    kind
}

#[tokio::test]
async fn test_validation_rules_accept_valid_usernames() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .hub_config_patch(username_validation_patch())
        .start()
        .await?;

    for username in ["validuser", "valid_user_123"] {
        let client = MumbleClient::new();
        client
            .connect(ConnectOptions {
                host: "127.0.0.1".into(),
                port: env.edge1(),
                username: username.to_string(),
                password: Some(String::new()),
                reject_unauthorized: false,
                force_tcp_voice: true,
                connect_timeout: Duration::from_secs(10),
                ..Default::default()
            })
            .await?;
        sleep_ms(250).await;
        assert!(
            client.is_connected(),
            "valid username {username} should connect"
        );
        client.disconnect().await?;
    }

    Ok(())
}

#[tokio::test]
async fn test_validation_rules_reject_invalid_usernames() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .hub_config_patch(username_validation_patch())
        .start()
        .await?;

    for username in ["123invalid", "!!bad!!", "a", "bad name", "用户名"] {
        let reject = try_connect_capture_reject_kind(env.edge1(), username).await;
        assert_eq!(
            reject,
            Some(RejectType::InvalidUsername),
            "invalid username {username} should be rejected as InvalidUsername, got {reject:?}"
        );
    }

    Ok(())
}

#[tokio::test]
async fn test_validation_rules_accept_valid_channel_names() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .hub_config_patch(channel_validation_patch())
        .start()
        .await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let admin = &clients[0];

    for name in ["ValidChannel", "My-Channel 123"] {
        let channel_id = admin.channel(0).create_subchannel(name).await?;
        assert!(
            channel_id > 0,
            "valid channel name {name} should create a channel"
        );
    }

    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_validation_rules_reject_invalid_channel_names() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .hub_config_patch(channel_validation_patch())
        .start()
        .await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    let admin = &clients[0];

    for name in ["!!BadChannel!!", "___private"] {
        let result = admin.channel(0).create_subchannel(name).await;
        assert!(
            result.is_err(),
            "invalid channel name {name} should be rejected"
        );
        sleep_ms(150).await;
        assert!(
            !admin.channels().iter().any(|channel| channel.name == name),
            "rejected invalid channel name {name} should not appear in the channel list"
        );
    }

    cleanup_clients(clients).await;
    Ok(())
}
