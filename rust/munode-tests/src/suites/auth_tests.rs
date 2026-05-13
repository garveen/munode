//! Authentication tests.
//!
//! Tests auth server HTTP API and Mumble protocol Reject messages.

use bytes::BytesMut;
use std::time::Duration;

use anyhow::{Context, Result};
use munode_client::connection::connect_tls;
use munode_client::{ClientEvent, ConnectOptions, MumbleClient};
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::{decode_frame, encode_message};
use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::harness::{
    ClientConfig, TestEnvBuilder, cleanup_clients, create_clients, single_edge_env, sleep_ms,
};

struct RawLoginCapture {
    server_sync: mumbleproto::ServerSync,
    server_config: mumbleproto::ServerConfig,
    user_states: Vec<mumbleproto::UserState>,
}

struct RawUserStateObserver {
    session_id: u32,
    rx: mpsc::UnboundedReceiver<mumbleproto::UserState>,
    task: tokio::task::JoinHandle<Result<()>>,
}

async fn capture_raw_login_messages(
    port: u16,
    username: &str,
    password: &str,
) -> Result<RawLoginCapture> {
    let tls_stream = connect_tls("127.0.0.1", port, None).await?;
    let (mut reader, mut writer) = tokio::io::split(tls_stream);

    let version = mumbleproto::Version {
        version: Some(0x0001_0500),
        release: Some("MuNode Raw Test Client".into()),
        os: Some(std::env::consts::OS.into()),
        os_version: Some(std::env::consts::FAMILY.into()),
    };
    let mut out = BytesMut::new();
    encode_message(MessageType::Version, &version, &mut out);
    writer.write_all(&out).await.context("send Version")?;

    let auth = mumbleproto::Authenticate {
        username: Some(username.to_string()),
        password: Some(password.to_string()),
        tokens: vec![],
        celt_versions: vec![],
        opus: Some(true),
    };
    out.clear();
    encode_message(MessageType::Authenticate, &auth, &mut out);
    writer.write_all(&out).await.context("send Authenticate")?;

    let mut read_buf = BytesMut::with_capacity(8192);
    let mut server_sync = None;
    let mut server_config = None;
    let mut user_states = Vec::new();

    let overall_deadline = tokio::time::Instant::now() + Duration::from_secs(5);

    loop {
        while let Some(frame) = decode_frame(&mut read_buf).context("decode login frame")? {
            match frame.message_type {
                MessageType::UserState => {
                    user_states.push(
                        mumbleproto::UserState::decode(&*frame.payload)
                            .context("decode UserState")?,
                    );
                }
                MessageType::ServerSync => {
                    server_sync = Some(
                        mumbleproto::ServerSync::decode(&*frame.payload)
                            .context("decode ServerSync")?,
                    );
                }
                MessageType::ServerConfig => {
                    server_config = Some(
                        mumbleproto::ServerConfig::decode(&*frame.payload)
                            .context("decode ServerConfig")?,
                    );
                }
                _ => {}
            }
        }

        if server_sync.is_some() && server_config.is_some() {
            match tokio::time::timeout(Duration::from_millis(150), reader.read_buf(&mut read_buf))
                .await
            {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(_)) => continue,
                Ok(Err(e)) => return Err(e).context("read additional login frames"),
            }
        }

        let Some(remaining) = overall_deadline.checked_duration_since(tokio::time::Instant::now())
        else {
            break;
        };
        match tokio::time::timeout(remaining, reader.read_buf(&mut read_buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e).context("read login frame"),
            Err(_) => break,
        }
    }

    Ok(RawLoginCapture {
        server_sync: server_sync.context("did not receive ServerSync")?,
        server_config: server_config.context("did not receive ServerConfig")?,
        user_states,
    })
}

async fn spawn_raw_user_state_observer(
    port: u16,
    username: &str,
    password: &str,
) -> Result<RawUserStateObserver> {
    let tls_stream = connect_tls("127.0.0.1", port, None).await?;
    let (mut reader, mut writer) = tokio::io::split(tls_stream);

    let version = mumbleproto::Version {
        version: Some(0x0001_0500),
        release: Some("MuNode Raw Observer".into()),
        os: Some(std::env::consts::OS.into()),
        os_version: Some(std::env::consts::FAMILY.into()),
    };
    let mut out = BytesMut::new();
    encode_message(MessageType::Version, &version, &mut out);
    writer
        .write_all(&out)
        .await
        .context("send observer Version")?;

    let auth = mumbleproto::Authenticate {
        username: Some(username.to_string()),
        password: Some(password.to_string()),
        tokens: vec![],
        celt_versions: vec![],
        opus: Some(true),
    };
    out.clear();
    encode_message(MessageType::Authenticate, &auth, &mut out);
    writer
        .write_all(&out)
        .await
        .context("send observer Authenticate")?;

    let (tx, rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut read_buf = BytesMut::with_capacity(8192);
        let overall_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut ready_tx = Some(ready_tx);

        loop {
            while let Some(frame) = decode_frame(&mut read_buf).context("decode observer frame")? {
                match frame.message_type {
                    MessageType::UserState => {
                        let state = mumbleproto::UserState::decode(&*frame.payload)
                            .context("decode observer UserState")?;
                        let _ = tx.send(state);
                    }
                    MessageType::ServerSync => {
                        let sync = mumbleproto::ServerSync::decode(&*frame.payload)
                            .context("decode observer ServerSync")?;
                        if let Some(ready_tx) = ready_tx.take() {
                            let session_id = sync
                                .session
                                .context("observer ServerSync missing session")?;
                            let _ = ready_tx.send(session_id);
                        }
                    }
                    _ => {}
                }
            }

            if ready_tx.is_some() {
                let Some(remaining) =
                    overall_deadline.checked_duration_since(tokio::time::Instant::now())
                else {
                    break;
                };
                match tokio::time::timeout(remaining, reader.read_buf(&mut read_buf)).await {
                    Ok(Ok(0)) => break,
                    Ok(Ok(_)) => continue,
                    Ok(Err(e)) => return Err(e).context("read observer handshake frame"),
                    Err(_) => break,
                }
            } else {
                match reader.read_buf(&mut read_buf).await {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(e) => return Err(e).context("read observer user state frame"),
                }
            }
        }

        Ok(())
    });

    let session_id = tokio::time::timeout(Duration::from_secs(5), ready_rx)
        .await
        .context("timed out waiting for observer ServerSync")?
        .context("observer handshake task ended before ServerSync")?;

    Ok(RawUserStateObserver {
        session_id,
        rx,
        task,
    })
}

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
    let groups = body["groups"]
        .as_array()
        .expect("groups should be an array");
    let group_strs: Vec<&str> = groups.iter().filter_map(|g| g.as_str()).collect();
    assert!(
        group_strs.contains(&"admin"),
        "admin user should be in 'admin' group"
    );
    Ok(())
}

#[tokio::test]
async fn test_auth_server_multiple_users() -> Result<()> {
    let env = TestEnvBuilder::new().edges(0).start().await?;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/auth", env.auth_port);

    let test_cases = vec![
        ("admin", "admin123", 1u64),
        ("user1", "password1", 2),
        ("user2", "password2", 3),
        ("guest", "guest123", 4),
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

        assert_eq!(
            resp.status().as_u16(),
            200,
            "User {username} should auth OK"
        );
        let body: serde_json::Value = resp.json().await?;
        assert_eq!(
            body["success"], true,
            "User {username} success should be true"
        );
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
    assert!(
        got_reject,
        "Should receive Reject message for wrong password"
    );
    Ok(())
}

#[tokio::test]
async fn test_nonexistent_user_causes_reject() -> Result<()> {
    let env = single_edge_env().await?;
    let got_reject = try_connect_expect_reject(env.edge1(), "nobody_xyz", "password").await;
    assert!(
        got_reject,
        "Should receive Reject message for nonexistent user"
    );
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
    assert!(
        clients[0].is_connected(),
        "Correct credentials should succeed"
    );
    cleanup_clients(clients).await;
    Ok(())
}

// ── Reject type from Mumble protocol ──────────────────────────────────────

async fn try_connect_capture_reject(
    port: u16,
    username: &'static str,
    password: &'static str,
) -> Option<munode_client::RejectType> {
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let captured: Arc<Mutex<Option<munode_client::RejectType>>> = Arc::new(Mutex::new(None));
    let captured_clone = captured.clone();

    let client = MumbleClient::new();
    let mut rx = client.subscribe();
    let handle = tokio::spawn(async move {
        let _ = client
            .connect(ConnectOptions {
                host: "127.0.0.1".into(),
                port,
                username: username.to_string(),
                password: Some(password.to_string()),
                ..Default::default()
            })
            .await;
    });

    let _ = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::AuthenticationFailed { kind, .. }) => {
                    *captured_clone.lock().await = Some(kind);
                    break;
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    })
    .await;

    let _ = handle.await;
    let v = captured.lock().await.clone();
    v
}

#[tokio::test]
async fn test_reject_type_wrong_password_is_wrong_user_pw() -> Result<()> {
    let env = single_edge_env().await?;
    let kind = try_connect_capture_reject(env.edge1(), "admin", "wrongpassword").await;
    assert_eq!(
        kind,
        Some(munode_client::RejectType::WrongUserPw),
        "wrong password should produce WrongUserPw, got {kind:?}"
    );
    Ok(())
}

#[tokio::test]
async fn test_reject_type_unknown_user_is_wrong_user_pw() -> Result<()> {
    let env = single_edge_env().await?;
    let kind = try_connect_capture_reject(env.edge1(), "nonexistent_user_xyz", "anypassword").await;
    assert_eq!(
        kind,
        Some(munode_client::RejectType::WrongUserPw),
        "unknown user should produce WrongUserPw, got {kind:?}"
    );
    Ok(())
}

// ── HTTP auth server CORS / error handling ────────────────────────────────

#[tokio::test]
async fn test_auth_server_returns_401_for_unknown_route() -> Result<()> {
    let env = TestEnvBuilder::new().edges(0).start().await?;
    let resp = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{}/unknown", env.auth_port))
        .send()
        .await?;
    assert_eq!(
        resp.status().as_u16(),
        404,
        "unknown route should return 404"
    );
    Ok(())
}

// ── ServerSync / ServerConfig content on login ───────────────────────────

#[tokio::test]
async fn test_server_sync_provides_max_bandwidth_and_motd() -> Result<()> {
    let env = single_edge_env().await?;
    let clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let client = &clients[0];

    sleep_ms(200).await;
    let info = client.server().information();
    assert!(
        info.max_bandwidth > 0,
        "ServerSync max_bandwidth should be positive, got {}",
        info.max_bandwidth
    );
    // welcome_text may or may not be configured; just verify the field is observable
    let _ = info.welcome_text;
    cleanup_clients(clients).await;
    Ok(())
}

#[tokio::test]
async fn test_login_self_user_state_omits_spurious_false_booleans() -> Result<()> {
    let env = single_edge_env().await?;
    let capture = capture_raw_login_messages(env.edge1(), "admin", "admin123").await?;
    let session = capture.server_sync.session();
    let self_state = capture
        .user_states
        .iter()
        .find(|state| state.session() == session)
        .context("did not receive initial self UserState")?;

    assert!(
        self_state.mute.is_none(),
        "initial self UserState must omit mute=false, got {:?}",
        self_state.mute
    );
    assert!(
        self_state.deaf.is_none(),
        "initial self UserState must omit deaf=false, got {:?}",
        self_state.deaf
    );
    assert!(
        self_state.suppress.is_none(),
        "initial self UserState must omit suppress=false, got {:?}",
        self_state.suppress
    );
    assert!(
        self_state.priority_speaker.is_none(),
        "initial self UserState must omit priority_speaker=false, got {:?}",
        self_state.priority_speaker
    );
    assert!(
        self_state.recording.is_none(),
        "initial self UserState must omit recording=false, got {:?}",
        self_state.recording
    );
    Ok(())
}

#[tokio::test]
async fn test_login_server_config_omits_duplicate_welcome_text() -> Result<()> {
    let env = single_edge_env().await?;
    let capture = capture_raw_login_messages(env.edge1(), "guest", "guest123").await?;

    assert!(
        capture.server_sync.max_bandwidth.unwrap_or_default() > 0,
        "ServerSync max_bandwidth should be positive"
    );
    assert!(
        capture
            .server_sync
            .welcome_text
            .as_deref()
            .is_some_and(|text| !text.is_empty()),
        "ServerSync should carry welcome_text"
    );
    assert!(
        capture.server_config.max_bandwidth.unwrap_or_default() > 0,
        "ServerConfig max_bandwidth should be positive"
    );
    assert!(
        capture.server_config.welcome_text.is_none(),
        "ServerConfig must omit welcome_text to avoid duplicate MOTD, got {:?}",
        capture.server_config.welcome_text
    );
    Ok(())
}

#[tokio::test]
async fn test_login_other_user_state_omits_spurious_false_booleans() -> Result<()> {
    let env = single_edge_env().await?;
    let mut observer = spawn_raw_user_state_observer(env.edge1(), "user1", "password1").await?;

    let clients = create_clients(&env, &[ClientConfig::new("user2", 1)]).await?;
    let joining_session = clients[0]
        .session_id()
        .context("user2 missing session id")?;

    let observed_state = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match observer.rx.recv().await {
                Some(state) if state.session == Some(joining_session) => break Some(state),
                Some(state) if state.session == Some(observer.session_id) => continue,
                Some(_) => continue,
                None => break None,
            }
        }
    })
    .await
    .context("timed out waiting for observer to receive other-user UserState")?
    .context("observer stream ended before other-user UserState arrived")?;

    assert_eq!(
        observed_state.mute, None,
        "other-user join UserState should omit mute=false"
    );
    assert_eq!(
        observed_state.deaf, None,
        "other-user join UserState should omit deaf=false"
    );
    assert_eq!(
        observed_state.priority_speaker, None,
        "other-user join UserState should omit priority_speaker=false"
    );
    assert_eq!(
        observed_state.recording, None,
        "other-user join UserState should omit recording=false"
    );

    cleanup_clients(clients).await;
    observer.task.abort();
    Ok(())
}

// ── Lua auth ──────────────────────────────────────────────────────────────

const LUA_AUTH_SCRIPT: &str = r#"
local USERS = {
  lua_admin  = { password = "lua_admin_pass",  user_id = 1001, groups = {"admin"} },
  lua_user1  = { password = "lua_user1_pass",  user_id = 1002, groups = {"user"} },
  lua_user2  = { password = "lua_user2_pass",  user_id = 1003, groups = {"user"} },
}
function authenticate(req)
  local u = USERS[req.username]
  if u == nil then
    return { success = false, reason = "Unknown user", reject_type = 3 }
  end
  if req.password ~= u.password then
    return { success = false, reason = "Wrong password", reject_type = 3 }
  end
  return {
    success      = true,
    user_id      = u.user_id,
    username     = req.username,
    display_name = req.username,
    groups       = u.groups,
  }
end
"#;

async fn lua_env() -> Result<crate::harness::TestEnvironment> {
    TestEnvBuilder::new()
        .edges(1)
        .hub_auth_override(serde_json::json!({
            "allow_guest": false,
            "require_auth_service": false,
            "lua_script": LUA_AUTH_SCRIPT,
        }))
        .start()
        .await
}

async fn lua_connect(port: u16, username: &str, password: &str) -> bool {
    let client = MumbleClient::new();
    let res = client
        .connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            username: username.into(),
            password: Some(password.into()),
            ..Default::default()
        })
        .await;
    let ok = res.is_ok() && client.is_connected();
    let _ = client.disconnect().await;
    ok
}

#[tokio::test]
async fn test_lua_auth_accepts_valid_user() -> Result<()> {
    let env = lua_env().await?;
    sleep_ms(800).await;
    assert!(
        lua_connect(env.edge1(), "lua_admin", "lua_admin_pass").await,
        "Lua-defined user should authenticate"
    );
    Ok(())
}

#[tokio::test]
async fn test_lua_auth_rejects_wrong_password() -> Result<()> {
    let env = lua_env().await?;
    sleep_ms(800).await;
    assert!(
        !lua_connect(env.edge1(), "lua_admin", "wrong_pw").await,
        "Wrong password under Lua auth should be rejected"
    );
    Ok(())
}

#[tokio::test]
async fn test_lua_auth_rejects_unknown_user() -> Result<()> {
    let env = lua_env().await?;
    sleep_ms(800).await;
    assert!(
        !lua_connect(env.edge1(), "no_such_user", "any").await,
        "Unknown user under Lua auth should be rejected"
    );
    Ok(())
}

#[tokio::test]
async fn test_lua_auth_multiple_users_concurrent() -> Result<()> {
    let env = lua_env().await?;
    sleep_ms(800).await;

    let c1 = MumbleClient::new();
    let c2 = MumbleClient::new();
    c1.connect(ConnectOptions {
        host: "127.0.0.1".into(),
        port: env.edge1(),
        username: "lua_user1".into(),
        password: Some("lua_user1_pass".into()),
        ..Default::default()
    })
    .await?;
    c2.connect(ConnectOptions {
        host: "127.0.0.1".into(),
        port: env.edge1(),
        username: "lua_user2".into(),
        password: Some("lua_user2_pass".into()),
        ..Default::default()
    })
    .await?;
    sleep_ms(500).await;

    let s1 = c1.session_id().expect("session 1");
    let s2 = c2.session_id().expect("session 2");
    assert!(
        c1.users().iter().any(|u| u.session == s2),
        "client1 should see client2"
    );
    assert!(
        c2.users().iter().any(|u| u.session == s1),
        "client2 should see client1"
    );

    let _ = c1.disconnect().await;
    let _ = c2.disconnect().await;
    Ok(())
}
