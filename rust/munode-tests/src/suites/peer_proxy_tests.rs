//! Peer relay tests for Edge diagnose output and static-peer fallback.

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use munode_client::ClientEvent;
use munode_client::{ConnectOptions, MumbleClient};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch};

use crate::harness::{
    certs_dir, cleanup_clients, create_clients, find_binary, find_free_port, sleep_ms,
    wait_for_port, ClientConfig, HMAC_SECRET, TestEnvBuilder,
};
use crate::users::find_user;

struct DiagCtx {
    cfg_path: PathBuf,
    _tmp: tempfile::TempDir,
}

struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct TcpProxyHandle {
    shutdown_tx: watch::Sender<bool>,
    join: tokio::task::JoinHandle<()>,
}

impl TcpProxyHandle {
    async fn stop(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.join.await;
    }
}

fn write_edge_cfg(
    name: &str,
    port: u16,
    static_peers: Option<Vec<(&str, u16)>>,
) -> Result<DiagCtx> {
    let tmp = tempfile::tempdir()?;
    let certs = certs_dir();
    let mut hub_server = json!({
        "host": "127.0.0.1",
        "control_port": 19300_u32,
        "hmac_secret": HMAC_SECRET,
    });
    if let Some(peers) = static_peers {
        hub_server["static_peers"] = json!(peers
            .iter()
            .map(|(h, p)| json!({"host": h, "relay_port": p}))
            .collect::<Vec<_>>());
    }
    let cfg = json!({
        "server_id": 1,
        "name": "RelayEdge",
        "network": {
            "host": "0.0.0.0",
            "port": port,
            "edge_port": port + 1,
            "external_host": "127.0.0.1",
        },
        "tls": {
            "cert": certs.join("server.pem").display().to_string(),
            "key": certs.join("server.key").display().to_string(),
            "ca": certs.join("ca.pem").display().to_string(),
        },
        "hub_server": hub_server,
    });
    let cfg_path = tmp.path().join(format!("{name}.json"));
    fs::write(&cfg_path, serde_json::to_string_pretty(&cfg)?)?;
    Ok(DiagCtx { cfg_path, _tmp: tmp })
}

fn write_bootstrap_edge_cfg(
    name: &str,
    client_port: u16,
    edge_port: u16,
    ws_port: u16,
    hub_control_port: u16,
    static_peer: (&str, u16),
    reconnect_interval: u64,
) -> Result<DiagCtx> {
    let tmp = tempfile::tempdir()?;
    let certs = certs_dir();
    let cfg = json!({
        "server_id": 2,
        "name": name,
        "network": {
            "host": "0.0.0.0",
            "port": client_port,
            "edge_port": edge_port,
            "external_host": "127.0.0.1",
        },
        "tls": {
            "cert": certs.join("server.pem").display().to_string(),
            "key": certs.join("server.key").display().to_string(),
            "ca": certs.join("ca.pem").display().to_string(),
        },
        "hub_server": {
            "host": "127.0.0.1",
            "control_port": hub_control_port,
            "hmac_secret": HMAC_SECRET,
            "reconnect_interval": reconnect_interval,
            "heartbeat_interval": 1000,
            "pool_size": 1,
            "static_peers": [
                {
                    "host": static_peer.0,
                    "relay_port": static_peer.1,
                }
            ],
        },
        "server": {
            "capacity": 1000,
            "max_bandwidth": 558000,
        },
        "webtransport": {
            "ws_fallback_port": ws_port,
        },
        "log_level": "error",
    });
    let cfg_path = tmp.path().join(format!("{name}.json"));
    fs::write(&cfg_path, serde_json::to_string_pretty(&cfg)?)?;
    Ok(DiagCtx { cfg_path, _tmp: tmp })
}

fn run_diagnose(cfg_path: &PathBuf) -> Result<(String, i32)> {
    let bin = find_binary("munode-edge")?;
    let out = Command::new(&bin)
        .args(["diagnose", &cfg_path.to_string_lossy()])
        .output()?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

async fn start_tcp_proxy(listen_port: u16, target_port: u16) -> Result<TcpProxyHandle> {
    let listener = TcpListener::bind(("127.0.0.1", listen_port)).await?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let join = tokio::spawn(async move {
        let mut accept_shutdown = shutdown_rx.clone();

        loop {
            tokio::select! {
                _ = accept_shutdown.changed() => {
                    break;
                }
                accepted = listener.accept() => {
                    let (mut inbound, _) = match accepted {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let mut conn_shutdown = shutdown_rx.clone();
                    tokio::spawn(async move {
                        let mut outbound = match TcpStream::connect(("127.0.0.1", target_port)).await {
                            Ok(stream) => stream,
                            Err(_) => return,
                        };

                        let _ = tokio::select! {
                            _ = conn_shutdown.changed() => Ok::<(), std::io::Error>(()),
                            res = tokio::io::copy_bidirectional(&mut inbound, &mut outbound) => {
                                res.map(|_| ())
                            }
                        };
                    });
                }
            }
        }
    });

    Ok(TcpProxyHandle { shutdown_tx, join })
}

async fn wait_for_client_login(port: u16, username: &str, timeout: Duration) -> Result<MumbleClient> {
    let user = find_user(username).expect("known integration test user");
    let deadline = Instant::now() + timeout;

    loop {
        let client = MumbleClient::new();
        match client.connect(ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            username: username.to_string(),
            password: Some(user.password.to_string()),
            reject_unauthorized: false,
            force_tcp_voice: true,
            connect_timeout: Duration::from_secs(2),
            ..Default::default()
        }).await {
            Ok(()) => return Ok(client),
            Err(err) => {
                let error_text = err.to_string();
                if Instant::now() >= deadline {
                    bail!(
                        "client login to edge port {} did not succeed within {:?}; last error: {}",
                        port,
                        timeout,
                        error_text
                    );
                }
                sleep_ms(250).await;
            }
        }
    }
}

async fn wait_for_user_joined(
    rx: &mut broadcast::Receiver<ClientEvent>,
    username: &str,
    timeout: Duration,
) -> Result<()> {
    tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ClientEvent::UserJoined(user)) if user.name == username => return Ok(()),
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(err) => bail!("event channel closed while waiting for {} join: {}", username, err),
            }
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for UserJoined({})", username))??;

    Ok(())
}

#[test]
fn test_diagnose_control_relay_uses_edge_port() -> Result<()> {
    let ctx = write_edge_cfg("relay-auto", 19310, None)?;
    let (stdout, code) = run_diagnose(&ctx.cfg_path)?;
    assert_eq!(code, 0, "stdout=\n{stdout}");
    assert!(stdout.contains("control_relay:"), "{stdout}");
    assert!(stdout.contains("enabled"), "{stdout}");
    assert!(stdout.contains("19311"), "expected edge_port 19311 in:\n{stdout}");
    Ok(())
}

#[test]
fn test_diagnose_static_peers_listed() -> Result<()> {
    let ctx = write_edge_cfg(
        "relay-static",
        19330,
        Some(vec![("10.0.0.2", 19335), ("10.0.0.3", 19336)]),
    )?;
    let (stdout, code) = run_diagnose(&ctx.cfg_path)?;
    assert_eq!(code, 0);
    assert!(stdout.contains("static_peers:"), "{stdout}");
    assert!(stdout.contains("10.0.0.2:19335"));
    assert!(stdout.contains("10.0.0.3:19336"));
    Ok(())
}

#[test]
fn test_diagnose_no_static_peers() -> Result<()> {
    let ctx = write_edge_cfg("relay-no-static", 19340, None)?;
    let (stdout, code) = run_diagnose(&ctx.cfg_path)?;
    assert_eq!(code, 0);
    assert!(!stdout.contains("static_peers:"), "{stdout}");
    Ok(())
}

#[tokio::test]
async fn test_edge_relay_ws_port_reachable_after_startup() -> Result<()> {
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    let env = TestEnvBuilder::new()
        .edges(1)
        .port_base(19400)
        .start()
        .await?;

    sleep_ms(1500).await;

    let edge_port = env.edges[0].edge_port;
    let conn = timeout(
        Duration::from_secs(5),
        TcpStream::connect(("127.0.0.1", edge_port)),
    )
    .await;
    assert!(conn.is_ok(), "edge_port {edge_port} not reachable within 5s");
    assert!(
        conn.unwrap().is_ok(),
        "edge_port {edge_port} TCP connect error"
    );
    drop(env);
    Ok(())
}

#[tokio::test]
async fn test_edge_bootstraps_via_static_peer_relay_when_direct_hub_is_unreachable() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .port_base(19420)
        .start()
        .await?;

    let fallback_client_port = find_free_port(19520)?;
    let fallback_edge_port = find_free_port(fallback_client_port + 1)?;
    let fallback_ws_port = find_free_port(fallback_edge_port + 1)?;
    let dead_hub_port = find_free_port(fallback_ws_port + 1)?;

    let cfg = write_bootstrap_edge_cfg(
        "relay-bootstrap-edge",
        fallback_client_port,
        fallback_edge_port,
        fallback_ws_port,
        dead_hub_port,
        ("127.0.0.1", env.edges[0].edge_port),
        100,
    )?;

    let edge_bin = find_binary("munode-edge")?;
    let edge_child = Command::new(&edge_bin)
        .arg(&cfg.cfg_path)
        .spawn()?;
    let _edge_guard = ChildGuard(Some(edge_child));

    wait_for_port(fallback_client_port, Duration::from_secs(15))?;

    let client = wait_for_client_login(fallback_client_port, "user1", Duration::from_secs(8)).await?;
    assert!(client.is_connected(), "fallback edge client should connect after peer relay bootstrap");
    assert!(!client.channels().is_empty(), "fallback edge should complete Hub sync via peer relay");

    cleanup_clients(vec![client]).await;
    drop(env);
    Ok(())
}

#[tokio::test]
async fn test_edge_switches_from_direct_hub_to_relay_and_keeps_control_plane() -> Result<()> {
    let env = TestEnvBuilder::new()
        .edges(1)
        .port_base(19440)
        .start()
        .await?;

    let proxy_port = find_free_port(19540)?;
    let proxy = start_tcp_proxy(proxy_port, env.control_port).await?;

    let fallback_client_port = find_free_port(proxy_port + 1)?;
    let fallback_edge_port = find_free_port(fallback_client_port + 1)?;
    let fallback_ws_port = find_free_port(fallback_edge_port + 1)?;

    let cfg = write_bootstrap_edge_cfg(
        "relay-cutover-edge",
        fallback_client_port,
        fallback_edge_port,
        fallback_ws_port,
        proxy_port,
        ("127.0.0.1", env.edges[0].edge_port),
        100,
    )?;

    let edge_bin = find_binary("munode-edge")?;
    let edge_child = Command::new(&edge_bin)
        .arg(&cfg.cfg_path)
        .spawn()?;
    let _edge_guard = ChildGuard(Some(edge_child));

    wait_for_port(fallback_client_port, Duration::from_secs(15))?;

    let edge1_clients = create_clients(&env, &[ClientConfig::new("user1", 1)]).await?;
    let observer_edge2 = wait_for_client_login(fallback_client_port, "user2", Duration::from_secs(8)).await?;

    sleep_ms(500).await;
    let mut edge1_rx = edge1_clients[0].subscribe();
    let mut edge2_rx = observer_edge2.subscribe();

    proxy.stop().await;

    // reconnect_interval=100ms -> after direct disconnect the first relay attempt
    // should happen within roughly 1s on the fast-fail path; give it headroom.
    sleep_ms(2500).await;
    assert!(
        observer_edge2.is_connected(),
        "edge2 client should remain connected while relay takes over control-plane traffic"
    );

    let guest_edge2 = wait_for_client_login(fallback_client_port, "guest", Duration::from_secs(8)).await?;
    wait_for_user_joined(&mut edge1_rx, "guest", Duration::from_secs(8)).await?;

    let admin_edge1 = create_clients(&env, &[ClientConfig::new("admin", 1)]).await?;
    wait_for_user_joined(&mut edge2_rx, "admin", Duration::from_secs(8)).await?;

    cleanup_clients(admin_edge1).await;
    cleanup_clients(vec![guest_edge2, observer_edge2]).await;
    cleanup_clients(edge1_clients).await;
    drop(env);
    Ok(())
}
