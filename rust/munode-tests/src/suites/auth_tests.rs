//! Authentication tests.
//!
//! Tests auth server HTTP API and Mumble protocol Reject messages.

use std::time::Duration;

use anyhow::Result;
use munode_client::{ClientEvent, ConnectOptions, MumbleClient};

use crate::harness::{
    cleanup_clients, single_edge_env, sleep_ms, ClientConfig, TestEnvBuilder, create_clients,
};

// ── HTTP auth server API ──────────────────────────────────────────────────

#[tokio::test]
async fn test_auth_server_accepts_valid_credentials() -> Result<()> {
    let env = TestEnvBuilder::new().edges(0).start().await?;

    let resp = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/auth", env.auth_port))
        .json(&serde_json::json!({
            "username": "admin",
            "password": "admin123",
            "tokens": [],
            "server_id": 1
        }))
        .send()
        .await?;

    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["user_id"], 1);
    assert_eq!(body["username"], "admin");
    Ok(())
}

#[tokio::test]
async fn test_auth_server_rejects_wrong_password() -> Result<()> {
    let env = TestEnvBuilder::new().edges(0).start().await?;

    let resp = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/auth", env.auth_port))
        .json(&serde_json::json!({
            "username": "admin",
            "password": "wrongpassword",
            "tokens": [],
            "server_id": 1
        }))
        .send()
        .await?;

    assert_eq!(resp.status().as_u16(), 401);
    let body: serde_json::Value = resp.json().await?;
    assert_eq!(body["success"], false);
    Ok(())
}

#[tokio::test]
async fn test_auth_server_rejects_unknown_user() -> Result<()> {
    let env = TestEnvBuilder::new().edges(0).start().await?;

    let resp = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/auth", env.auth_port))
        .json(&serde_json::json!({
            "username": "nonexistent_xyz",
            "password": "password",
            "tokens": [],
            "server_id": 1
        }))
        .send()
        .await?;

    assert_eq!(resp.status().as_u16(), 401);
    let body: serde_json::Value = resp.json().await?;
    assert_eq!(body["success"], false);
    Ok(())
}

#[tokio::test]
async fn test_auth_server_returns_groups() -> Result<()> {
    let env = TestEnvBuilder::new().edges(0).start().await?;

    let resp = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/auth", env.auth_port))
        .json(&serde_json::json!({
            "username": "admin",
            "password": "admin123",
            "tokens": [],
            "server_id": 1
        }))
        .send()
        .await?;

    let body: serde_json::Value = resp.json().await?;
    let groups = body["groups"].as_array().expect("groups should be an array");
    let group_strs: Vec<&str> = groups.iter().filter_map(|g| g.as_str()).collect();
    assert!(group_strs.contains(&"admin"), "admin user should be in 'admin' group");
    Ok(())
}

#[tokio::test]
async fn test_auth_server_multiple_users() -> Result<()> {
    let env = TestEnvBuilder::new().edges(0).start().await?;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/auth", env.auth_port);

    let test_cases = vec![
        ("admin",  "admin123",  1u64),
        ("user1",  "password1", 2),
        ("user2",  "password2", 3),
        ("guest",  "guest123",  4),
    ];

    for (username, password, expected_id) in test_cases {
        let resp = client
            .post(&url)
            .json(&serde_json::json!({
                "username": username,
                "password": password,
                "tokens": []
            }))
            .send()
            .await?;

        assert_eq!(resp.status().as_u16(), 200, "User {username} should auth OK");
        let body: serde_json::Value = resp.json().await?;
        assert_eq!(body["success"], true, "User {username} success should be true");
        assert_eq!(body["user_id"], expected_id, "User {username} ID mismatch");
    }
    Ok(())
}

// ── Mumble Reject messages ────────────────────────────────────────────────

/// Attempt to connect with wrong credentials and capture the Reject event.
async fn try_connect_expect_reject(port: u16, username: &str, password: &str) -> bool {
    let client = MumbleClient::new();
    let mut rx = client.subscribe();

    let opts = ConnectOptions {
        host: "127.0.0.1".into(),
        port,
        username: username.into(),
        password: Some(password.into()),
        reject_unauthorized: false,
        force_tcp_voice: true,
        connect_timeout: Duration::from_secs(10),
        ..Default::default()
    };

    // Connect in background so we can watch events
    let client2 = client.clone();
    let handle = tokio::spawn(async move {
        let _ = client2.connect(opts).await;
    });

    // Wait for Reject event
    let got_reject = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::AuthenticationFailed { .. }) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        }
    })
    .await
    .unwrap_or(false);

    let _ = handle.await;
    got_reject
}

#[tokio::test]
async fn test_wrong_password_causes_reject() -> Result<()> {
    let env = single_edge_env().await?;
    let got_reject = try_connect_expect_reject(env.edge1(), "admin", "wrongpassword").await;
    assert!(got_reject, "Should receive Reject message for wrong password");
    Ok(())
}

#[tokio::test]
async fn test_nonexistent_user_causes_reject() -> Result<()> {
    let env = single_edge_env().await?;
    let got_reject = try_connect_expect_reject(env.edge1(), "nobody_xyz", "password").await;
    assert!(got_reject, "Should receive Reject message for nonexistent user");
    Ok(())
}

#[tokio::test]
async fn test_multiple_wrong_passwords_all_rejected() -> Result<()> {
    let env = single_edge_env().await?;
    let port = env.edge1();

    let cases = [
        ("user1", "notpassword1"),
        ("user2", "notpassword2"),
        ("guest", "notguest123"),
    ];

    for (username, wrong_pw) in cases {
        sleep_ms(100).await;
        let got_reject = try_connect_expect_reject(port, username, wrong_pw).await;
        assert!(
            got_reject,
            "User {username} with wrong password should be rejected"
        );
    }
    Ok(())
}

#[tokio::test]
async fn test_correct_credentials_succeed() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    assert!(clients[0].is_connected(), "Correct credentials should succeed");
    cleanup_clients(clients).await;
    Ok(())
}
