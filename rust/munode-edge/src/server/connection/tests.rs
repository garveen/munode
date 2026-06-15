use super::user_state::handle_admin_user_state_update;
use crate::channel_manager::ChannelManager;
use crate::client::{
    ClientInfo, ClientManager, ClientState, DynamicControlReceiver, test_client_sender,
};
use crate::hub_client::HubClient;
use crate::server::event_listener::hub_event_listener;
use crate::state::{EdgeEvent, EdgeState, RemoteUserStateDelta};
use bytes::{Bytes, BytesMut};
use munode_common::config::{EdgeConfig, HubServerConfig, NetworkConfig, ServerConfig, TlsConfig};
use munode_common::permission as perm;
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use munode_protocol::transport::decode_frame;
use prost::Message;
use std::collections::HashMap;
use std::sync::Arc;
struct ShortWriteSink {
    max_per_write: usize,
    written: Vec<u8>,
    vectored_calls: usize,
}

impl ShortWriteSink {
    fn new(max_per_write: usize) -> Self {
        Self {
            max_per_write,
            written: Vec::new(),
            vectored_calls: 0,
        }
    }
}

impl tokio::io::AsyncWrite for ShortWriteSink {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let len = buf.len().min(self.max_per_write);
        self.written.extend_from_slice(&buf[..len]);
        std::task::Poll::Ready(Ok(len))
    }

    fn poll_write_vectored(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.vectored_calls += 1;
        let mut remaining = self.max_per_write;
        let mut total = 0;
        for buf in bufs {
            if remaining == 0 {
                break;
            }
            let len = buf.len().min(remaining);
            self.written.extend_from_slice(&buf[..len]);
            remaining -= len;
            total += len;
        }
        std::task::Poll::Ready(Ok(total))
    }

    fn is_write_vectored(&self) -> bool {
        true
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn test_writer_batch_retries_partial_vectored_writes() {
    let pending = vec![
        Bytes::from_static(b"abcdef"),
        Bytes::from_static(b"123456"),
        Bytes::from_static(b"XYZ"),
    ];
    let mut writer = ShortWriteSink::new(5);

    super::write_pending_batch(&mut writer, &pending)
        .await
        .expect("batch write should complete");

    assert_eq!(writer.written, b"abcdef123456XYZ");
    assert!(
        writer.vectored_calls > 1,
        "test must exercise partial vectored writes"
    );
}

/// Construct a minimal `EdgeConfig` suitable for unit tests.
fn test_config() -> EdgeConfig {
    EdgeConfig {
        server_id: 1,
        name: "test".to_string(),
        network: NetworkConfig {
            host: "127.0.0.1".to_string(),
            port: 64738,
            edge_port: None,
            external_host: "127.0.0.1".to_string(),
            external_port: None,
            region: None,
            proxy_protocol: false,
            trusted_proxy_ips: Vec::new(),
        },
        tls: TlsConfig {
            cert: "test.pem".to_string(),
            key: "test.key".to_string(),
            ca: None,
        },
        hub_server: HubServerConfig {
            host: "localhost".to_string(),
            control_port: 8080,
            reconnect_interval: 5000,
            heartbeat_interval: 10000,
            hmac_secret: None,
            pool_size: 1,
            static_peers: vec![],
            tls: false,
        },
        server: ServerConfig::default(),
        voice_routing: munode_common::config::EdgeVoiceRoutingConfig::default(),
        web_api: munode_common::config::EdgeWebApiConfig::default(),
        webtransport: munode_common::config::WebtransportConfig::default(),
        log_level: "info".to_string(),
        log_format: "text".to_string(),
        cluster_peer_access: HashMap::new(),
    }
}

/// Build a `ClientInfo` that is already in the `Ready` state.
fn ready_client(session: u32, channel: u32) -> ClientInfo {
    ClientInfo {
        session,
        user_id: session,
        username: format!("user{}", session),
        channel_id: channel,
        state: ClientState::Ready,
        mute: false,
        deaf: false,
        suppress: false,
        self_mute: false,
        self_deaf: false,
        priority_speaker: false,
        recording: false,
        ip_address: "127.0.0.1".to_string(),
        connected_at: std::time::Instant::now(),
        last_active: std::time::Instant::now(),
        cert_hash: None,
        groups: vec![],
        opus_supported: true,
        listening_channels: vec![],
        listening_volume_adjustments: HashMap::new(),
        texture_hash: None,
        comment_hash: None,
        client_version: None,
        client_release: String::new(),
        client_os: String::new(),
        client_os_version: String::new(),
        plugin_context: vec![],
        client_cert_chain: vec![],
    }
}

/// Decode the first Mumble frame from raw bytes and return the UserState message.
fn decode_user_state(data: &[u8]) -> mumbleproto::UserState {
    let mut buf = BytesMut::from(data);
    let frame = decode_frame(&mut buf)
        .expect("decode_frame ok")
        .expect("frame present");
    assert_eq!(
        frame.message_type,
        MessageType::UserState,
        "expected UserState frame"
    );
    mumbleproto::UserState::decode(&frame.payload[..]).expect("decode UserState")
}

async fn recv_user_state_for_session(
    rx: &mut DynamicControlReceiver,
    target_session: u32,
) -> mumbleproto::UserState {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(100);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let data = tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("timed out waiting for UserState")
            .expect("channel closed while waiting for UserState");
        let mut buf = BytesMut::from(data.as_ref());
        let frame = decode_frame(&mut buf)
            .expect("decode_frame ok")
            .expect("frame present");
        if frame.message_type != MessageType::UserState {
            continue;
        }
        let msg = mumbleproto::UserState::decode(&frame.payload[..]).expect("decode UserState");
        if msg.session == Some(target_session) {
            return msg;
        }
    }
}

async fn assert_no_message(rx: &mut DynamicControlReceiver) {
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv())
            .await
            .is_err(),
        "did not expect a local message without authoritative Hub echo"
    );
}

/// Build a minimal `EdgeState` + disconnected `HubClient` for unit tests.
/// The returned HubClient never starts `connect_and_run()`, so there is no active
/// control channel and no authoritative Hub echo path unless a test simulates it.
fn test_edge_and_hub() -> (Arc<EdgeState>, Arc<HubClient>) {
    let channel_manager = ChannelManager::new();
    let client_manager = ClientManager::new();
    let edge_state = EdgeState::new(channel_manager, client_manager, false);
    let hub_client = HubClient::new(&test_config(), edge_state.clone());
    (edge_state, hub_client)
}

// -----------------------------------------------------------------------
// Test: authoritative self-mute echo fan-outs to local clients.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_self_mute_broadcast_to_self_and_others() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_a, mut rx_a, _voice_rx_a) = test_client_sender();
    let (sender_b, mut rx_b, _voice_rx_b) = test_client_sender();
    let mut client1 = ready_client(1, 0);
    es.client_manager
        .add_client(client1.clone(), sender_a)
        .await;
    es.client_manager
        .add_client(ready_client(2, 0), sender_b)
        .await;

    client1.self_mute = true;
    es.client_manager.update_client(client1).await;

    let es = run_event_listener_task(es).await;
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 1,
        delta: RemoteUserStateDelta {
            self_mute: Some(true),
            ..Default::default()
        },
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: Some(1),
    });

    let msg_a = decode_user_state(&rx_a.recv().await.unwrap());
    assert_eq!(msg_a.session, Some(1));
    assert_eq!(msg_a.self_mute, Some(true), "self: must see self_mute=true");

    let msg_b = decode_user_state(&rx_b.recv().await.unwrap());
    assert_eq!(msg_b.session, Some(1));
    assert_eq!(
        msg_b.self_mute,
        Some(true),
        "observer: must see self_mute=true"
    );

    // Internal state must be updated.
    let c = es.client_manager.get_client(1).await.unwrap();
    assert!(c.self_mute);
    assert!(!c.self_deaf);
}

// -----------------------------------------------------------------------
// Test: authoritative self-unmute echo must carry explicit false values.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_self_unmute_broadcast_carries_false() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_a, mut rx_a, _voice_rx_a) = test_client_sender();
    let (sender_b, mut rx_b, _voice_rx_b) = test_client_sender();
    let mut client1 = ready_client(1, 0);
    client1.self_mute = true;
    client1.self_deaf = true;
    es.client_manager
        .add_client(client1.clone(), sender_a)
        .await;
    es.client_manager
        .add_client(ready_client(2, 0), sender_b)
        .await;

    client1.self_mute = false;
    client1.self_deaf = false;
    es.client_manager.update_client(client1).await;

    let es = run_event_listener_task(es).await;
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 1,
        delta: RemoteUserStateDelta {
            self_mute: Some(false),
            self_deaf: Some(false),
            ..Default::default()
        },
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: Some(1),
    });

    let msg_a = decode_user_state(&rx_a.recv().await.unwrap());
    assert_eq!(
        msg_a.self_mute,
        Some(false),
        "self: self_mute must be Some(false) on un-mute"
    );
    // Un-muting also clears deaf (coupling).
    assert_eq!(
        msg_a.self_deaf,
        Some(false),
        "self: un-muting must also clear self_deaf"
    );

    let msg_b = decode_user_state(&rx_b.recv().await.unwrap());
    assert_eq!(
        msg_b.self_mute,
        Some(false),
        "observer: self_mute must be Some(false) on un-mute"
    );
    assert_eq!(
        msg_b.self_deaf,
        Some(false),
        "observer: un-muting must also clear self_deaf"
    );

    let c = es.client_manager.get_client(1).await.unwrap();
    assert!(!c.self_mute);
    assert!(!c.self_deaf);
}

// -----------------------------------------------------------------------
// Test: authoritative self-deaf echo must carry both self_deaf and self_mute.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_self_deaf_implies_self_mute() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_a, mut rx_a, _voice_rx_a) = test_client_sender();
    let (sender_b, mut rx_b, _voice_rx_b) = test_client_sender();
    let mut client1 = ready_client(1, 0);
    es.client_manager
        .add_client(client1.clone(), sender_a)
        .await;
    es.client_manager
        .add_client(ready_client(2, 0), sender_b)
        .await;

    client1.self_deaf = true;
    client1.self_mute = true;
    es.client_manager.update_client(client1).await;

    let es = run_event_listener_task(es).await;
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 1,
        delta: RemoteUserStateDelta {
            self_mute: Some(true),
            self_deaf: Some(true),
            ..Default::default()
        },
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: Some(1),
    });

    let msg_a = decode_user_state(&rx_a.recv().await.unwrap());
    assert_eq!(msg_a.self_deaf, Some(true), "self: self_deaf must be true");
    assert_eq!(
        msg_a.self_mute,
        Some(true),
        "self: self_deaf=true must imply self_mute=true"
    );

    let msg_b = decode_user_state(&rx_b.recv().await.unwrap());
    assert_eq!(
        msg_b.self_deaf,
        Some(true),
        "observer: self_deaf must be true"
    );
    assert_eq!(
        msg_b.self_mute,
        Some(true),
        "observer: self_deaf=true must imply self_mute=true"
    );

    let c = es.client_manager.get_client(1).await.unwrap();
    assert!(c.self_deaf);
    assert!(
        c.self_mute,
        "client.self_mute must be set when self_deaf=true"
    );
}

// -----------------------------------------------------------------------
// Test: authoritative self-deaf=false echo alone does NOT clear self_mute.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_un_deaf_does_not_clear_self_mute() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_a, mut rx_a, _voice_rx_a) = test_client_sender();
    let mut c1 = ready_client(1, 0);
    c1.self_mute = true;
    c1.self_deaf = true;
    es.client_manager.add_client(c1.clone(), sender_a).await;

    c1.self_deaf = false;
    es.client_manager.update_client(c1).await;

    let es = run_event_listener_task(es).await;
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 1,
        delta: RemoteUserStateDelta {
            self_deaf: Some(false),
            ..Default::default()
        },
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: Some(1),
    });

    let msg = decode_user_state(&rx_a.recv().await.unwrap());
    assert_eq!(msg.self_deaf, Some(false), "self_deaf must be false");
    assert_eq!(
        msg.self_mute, None,
        "un-deaf alone must not change self_mute"
    );

    let c = es.client_manager.get_client(1).await.unwrap();
    assert!(!c.self_deaf);
    assert!(c.self_mute, "self_mute must remain true after un-deaf");
}

// -----------------------------------------------------------------------
// Test: authoritative recording stop echo broadcasts Some(false).
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_recording_flag_false_is_broadcast() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_a, mut rx_a, _voice_rx_a) = test_client_sender();
    let mut c1 = ready_client(1, 0);
    c1.recording = true;
    es.client_manager.add_client(c1.clone(), sender_a).await;

    c1.recording = false;
    es.client_manager.update_client(c1).await;

    let es = run_event_listener_task(es).await;
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 1,
        delta: RemoteUserStateDelta {
            recording: Some(false),
            ..Default::default()
        },
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: Some(1),
    });

    let msg = decode_user_state(&rx_a.recv().await.unwrap());
    assert_eq!(
        msg.recording,
        Some(false),
        "recording=false must be explicitly broadcast"
    );
}

// -----------------------------------------------------------------------
// Test: authoritative admin unmute echo must carry mute=false and actor.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_admin_mute_and_unmute_broadcast_false() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_admin, mut rx_admin, _voice_rx_admin) = test_client_sender();
    let (sender_target, mut rx_target, _voice_rx_target) = test_client_sender();
    es.client_manager
        .add_client(ready_client(1, 0), sender_admin)
        .await;
    let mut target = ready_client(2, 0);
    target.mute = true;
    es.client_manager
        .add_client(target.clone(), sender_target)
        .await;

    target.mute = false;
    es.client_manager.update_client(target).await;

    let es = run_event_listener_task(es).await;
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 2,
        delta: RemoteUserStateDelta {
            mute: Some(false),
            ..Default::default()
        },
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: Some(1),
    });

    let msg_admin = decode_user_state(&rx_admin.recv().await.unwrap());
    assert_eq!(msg_admin.session, Some(2));
    assert_eq!(
        msg_admin.actor,
        Some(1),
        "actor must be set to admin session"
    );
    assert_eq!(
        msg_admin.mute,
        Some(false),
        "admin: mute=false must be explicit"
    );

    let msg_target = decode_user_state(&rx_target.recv().await.unwrap());
    assert_eq!(
        msg_target.mute,
        Some(false),
        "target: mute=false must be explicit"
    );

    let c = es.client_manager.get_client(2).await.unwrap();
    assert!(!c.mute);
}

// -----------------------------------------------------------------------
// Helper: fire hub_event_listener as a background task.
// Returns the EdgeState whose event channel we can emit into.
async fn run_event_listener_task(es: Arc<EdgeState>) -> Arc<EdgeState> {
    let es2 = es.clone();
    tokio::spawn(async move {
        let mut rx = es2.subscribe_events();
        let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
        let hub_client = HubClient::new(&test_config(), es2.clone());
        hub_event_listener(es2, &mut rx, shutdown_tx, hub_client).await;
    });
    // Give the background task a moment to subscribe before the first emit.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    es
}

// Helper: build a RemoteUser (all-false booleans, default state).
fn remote_user(session: u32, channel: u32) -> crate::channel_manager::RemoteUser {
    crate::channel_manager::RemoteUser {
        session_id: session,
        edge_id: 99,
        user_id: session,
        username: format!("remote{}", session),
        channel_id: channel,
        cert_hash: None,
        groups: vec![],
        mute: false,
        deaf: false,
        suppress: false,
        self_mute: false,
        self_deaf: false,
        priority_speaker: false,
        recording: false,
        listening_channels: vec![],
    }
}

// -----------------------------------------------------------------------
// Regression: when a normal (unmuted) user RECONNECTS, RemoteUserJoined
// must NOT include Some(false) for any bool field. The Mumble client
// interprets every present bool field as a change notification, so
// omitting false values prevents spurious "userX unmuted / stopped
// recording / ..." messages.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_remote_user_joined_no_false_booleans() {
    let (es, _hub) = test_edge_and_hub();

    // One local observer.
    let (sender_obs, mut rx_obs, _voice_rx_obs) = test_client_sender();
    es.client_manager
        .add_client(ready_client(1, 0), sender_obs)
        .await;

    // Remote user (all defaults – nothing true).
    es.channel_manager
        .upsert_remote_user(remote_user(10, 0))
        .await;
    let es = run_event_listener_task(es).await;

    es.emit(EdgeEvent::RemoteUserJoined {
        session_id: 10,
        username: "remote10".to_string(),
        channel_id: 0,
        is_ninja: false,
    });

    let msg = decode_user_state(&rx_obs.recv().await.expect("must receive join announcement"));
    assert_eq!(msg.session, Some(10));
    assert_eq!(msg.name.as_deref(), Some("remote10"), "name must be set");

    // All boolean fields must be ABSENT (None) – not Some(false).
    assert_eq!(msg.mute, None, "mute must be absent for default-false user");
    assert_eq!(msg.deaf, None, "deaf must be absent");
    assert_eq!(msg.suppress, None, "suppress must be absent");
    assert_eq!(
        msg.self_mute, None,
        "self_mute must be absent (prevents 'user unmuted' notification)"
    );
    assert_eq!(msg.self_deaf, None, "self_deaf must be absent");
    assert_eq!(
        msg.priority_speaker, None,
        "priority_speaker must be absent"
    );
    assert_eq!(
        msg.recording, None,
        "recording must be absent (prevents 'user stopped recording' notification)"
    );
}

// -----------------------------------------------------------------------
// When a remote user joins WITH some true flags, those flags MUST appear.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_remote_user_joined_true_flags_are_included() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_obs, mut rx_obs, _voice_rx_obs) = test_client_sender();
    es.client_manager
        .add_client(ready_client(1, 0), sender_obs)
        .await;

    let mut ru = remote_user(11, 0);
    ru.self_mute = true;
    ru.recording = true;
    es.channel_manager.upsert_remote_user(ru).await;
    let es = run_event_listener_task(es).await;

    es.emit(EdgeEvent::RemoteUserJoined {
        session_id: 11,
        username: "remote11".to_string(),
        channel_id: 0,
        is_ninja: false,
    });

    let msg = decode_user_state(&rx_obs.recv().await.unwrap());
    assert_eq!(msg.self_mute, Some(true), "self_mute=true must be present");
    assert_eq!(msg.recording, Some(true), "recording=true must be present");
    assert_eq!(msg.self_deaf, None, "unset flags must remain absent");
}

// -----------------------------------------------------------------------
// Regression: after HubRegistered recovery, current LOCAL users must also be
// re-announced to local observers or source-edge views can remain stale after
// event-listener lag drops queued move/state events.
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Regression: RemoteUserStateChanged must only broadcast fields present
// in the delta, not ALL current state. Broadcasting all state would send
// Some(false) for every default-off field on every state update.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_remote_user_state_changed_only_broadcasts_delta() {
    use crate::state::RemoteUserStateDelta;

    let (es, _hub) = test_edge_and_hub();

    let (sender_obs, mut rx_obs, _voice_rx_obs) = test_client_sender();
    es.client_manager
        .add_client(ready_client(1, 0), sender_obs)
        .await;
    es.channel_manager
        .upsert_remote_user(remote_user(12, 0))
        .await;
    let es = run_event_listener_task(es).await;

    // Only self_mute changed – all other fields are absent in the delta.
    let delta = RemoteUserStateDelta {
        self_mute: Some(true),
        ..Default::default()
    };
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 12,
        delta,
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: None,
    });

    let msg = decode_user_state(&rx_obs.recv().await.unwrap());
    assert_eq!(msg.session, Some(12));
    assert_eq!(msg.self_mute, Some(true), "changed field must be included");
    // All unchanged fields must be absent (None) – not Some(false).
    assert_eq!(msg.self_deaf, None, "unchanged self_deaf must be absent");
    assert_eq!(msg.mute, None, "unchanged mute must be absent");
    assert_eq!(msg.deaf, None, "unchanged deaf must be absent");
    assert_eq!(msg.recording, None, "unchanged recording must be absent");
    assert_eq!(
        msg.priority_speaker, None,
        "unchanged priority_speaker must be absent"
    );
}

// -----------------------------------------------------------------------
// When delta un-mutes a remote user, Some(false) must propagate.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_remote_user_state_changed_unmute_carries_false() {
    use crate::state::RemoteUserStateDelta;

    let (es, _hub) = test_edge_and_hub();

    let (sender_obs, mut rx_obs, _voice_rx_obs) = test_client_sender();
    es.client_manager
        .add_client(ready_client(1, 0), sender_obs)
        .await;
    let mut ru = remote_user(13, 0);
    ru.self_mute = false; // now false after update
    es.channel_manager.upsert_remote_user(ru).await;
    let es = run_event_listener_task(es).await;

    let delta = RemoteUserStateDelta {
        self_mute: Some(false), // explicit false = "just un-muted"
        ..Default::default()
    };
    es.emit(EdgeEvent::RemoteUserStateChanged {
        session_id: 13,
        delta,
        listening_channel_add: vec![],
        listening_channel_remove: vec![],
        actor_session: None,
    });

    let msg = decode_user_state(&rx_obs.recv().await.unwrap());
    assert_eq!(
        msg.self_mute,
        Some(false),
        "un-mute delta must carry Some(false)"
    );
    // Other fields still absent.
    assert_eq!(msg.recording, None);
}

// -----------------------------------------------------------------------
// Regression: HubRegistered replay must also re-announce current LOCAL users.
// Without this, event-listener lag recovery can permanently lose same-edge
// user-state broadcasts while Hub notifications continue to update state.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_hub_registered_reannounces_local_users() {
    let (es, _hub) = test_edge_and_hub();

    let (sender_obs, mut rx_obs, _voice_rx_obs) = test_client_sender();
    let (sender_target, _rx_target, _voice_rx_target) = test_client_sender();

    es.client_manager
        .add_client(ready_client(1, 0), sender_obs)
        .await;

    let mut moved_local = ready_client(2, 0);
    moved_local.self_mute = true;
    es.client_manager
        .add_client(moved_local, sender_target)
        .await;

    let es = run_event_listener_task(es).await;
    es.emit(EdgeEvent::HubRegistered {
        disappeared_session_ids: vec![],
    });

    let msg = recv_user_state_for_session(&mut rx_obs, 2).await;
    assert_eq!(msg.session, Some(2));
    assert_eq!(msg.name.as_deref(), Some("user2"));
    assert_eq!(msg.channel_id, Some(0));
    assert_eq!(
        msg.self_mute,
        Some(true),
        "HubRegistered recovery must replay current local user state"
    );
}

// -----------------------------------------------------------------------
// Test: admin channel-move is DENIED when Hub is unreachable.
//
// When the Hub cannot be reached, all permission queries fail with Err,
// which our code maps to `false` (fail-closed).  The two Move/Enter checks
// therefore both return false → PermissionDenied is sent to the actor and
// the victim stays in its original channel.
//
// This test verifies the denial path of the two-step Move permission check
// added to mirror Murmur's msgUserState behaviour:
//   1. actor needs Move in victim's current channel   (check 1)
//   2. actor needs Move OR victim needs Enter in target (check 2)
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_admin_move_denied_when_hub_unreachable() {
    let (es, hub) = test_edge_and_hub(); // HubClient has no real connection

    let (sender_admin, mut rx_admin, _voice_rx_admin) = test_client_sender();
    let (sender_victim, _rx_victim, _voice_rx_victim) = test_client_sender();

    // Admin in channel 0, victim starts in channel 0.
    es.client_manager
        .add_client(ready_client(1, 0), sender_admin)
        .await;
    es.client_manager
        .add_client(ready_client(2, 0), sender_victim)
        .await;

    // Admin tries to drag victim to channel 1.
    let us = mumbleproto::UserState {
        session: Some(2),
        channel_id: Some(1),
        ..Default::default()
    };
    handle_admin_user_state_update(&es, &hub, 1, 2, &us).await;

    // Admin must receive PermissionDenied (not UserState).
    let raw = rx_admin.recv().await.expect("admin must receive a message");
    let mut buf = BytesMut::from(&raw[..]);
    let frame = decode_frame(&mut buf).unwrap().unwrap();
    assert_eq!(
        frame.message_type,
        MessageType::PermissionDenied,
        "admin must receive PermissionDenied when Hub is unreachable"
    );
    let pq = mumbleproto::PermissionDenied::decode(&frame.payload[..]).unwrap();
    assert_eq!(
        pq.r#type,
        Some(mumbleproto::permission_denied::DenyType::Permission as i32),
        "must be a generic Permission denial"
    );

    // Victim must NOT have been moved.
    let victim = es.client_manager.get_client(2).await.unwrap();
    assert_eq!(victim.channel_id, 0, "victim must remain in channel 0");
}

// -----------------------------------------------------------------------
// Test: admin mute-only op still bypasses move permission queries when Hub is
// unreachable, but before any authoritative Hub echo it must not fan out locally.
// -----------------------------------------------------------------------
#[tokio::test]
async fn test_admin_mute_without_move_does_not_locally_apply_before_hub_echo() {
    let (es, hub) = test_edge_and_hub();

    // Grant admin (session 1) MUTE_DEAFEN permission on channel 0.
    es.permission_cache.insert((1, 0), perm::MUTE_DEAFEN);

    let (sender_admin, mut rx_admin, _voice_rx_admin) = test_client_sender();
    let (sender_victim, mut rx_victim, _voice_rx_victim) = test_client_sender();
    es.client_manager
        .add_client(ready_client(1, 0), sender_admin)
        .await;
    es.client_manager
        .add_client(ready_client(2, 0), sender_victim)
        .await;

    // Admin mutes victim (no channel_id → no Move perm check).
    let us = mumbleproto::UserState {
        session: Some(2),
        mute: Some(true),
        ..Default::default()
    };

    let es_for_task = es.clone();
    let hub_for_task = hub.clone();
    let handle = tokio::spawn(async move {
        handle_admin_user_state_update(&es_for_task, &hub_for_task, 1, 2, &us).await;
    });

    assert_no_message(&mut rx_admin).await;
    assert_no_message(&mut rx_victim).await;

    let victim = es.client_manager.get_client(2).await.unwrap();
    assert!(
        !victim.mute,
        "without authoritative Hub echo the local victim state must remain unchanged"
    );

    handle.abort();
    let _ = handle.await;
}
