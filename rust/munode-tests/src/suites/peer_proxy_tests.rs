//! Edge `diagnose` CLI tests — migrated from `tests/integration/suites/peer-proxy.test.ts`.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Result;
use serde_json::json;

use crate::harness::{certs_dir, find_binary};

struct DiagCtx {
    cfg_path: PathBuf,
    _tmp: tempfile::TempDir,
}

fn write_edge_cfg(
    name: &str,
    port: u16,
    relay_port: u16,
    static_peers: Option<Vec<(&str, u16)>>,
) -> Result<DiagCtx> {
    let tmp = tempfile::tempdir()?;
    let certs = certs_dir();
    let mut hub_server = json!({
        "host": "127.0.0.1",
        "control_port": 19300_u32,
        "hmac_secret": "test-secret",
    });
    if relay_port > 0 {
        hub_server["relay_port"] = json!(relay_port);
    }
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

#[test]
fn test_diagnose_auto_relay_port() -> Result<()> {
    let ctx = write_edge_cfg("relay-auto", 19310, 0, None)?;
    let (stdout, code) = run_diagnose(&ctx.cfg_path)?;
    assert_eq!(code, 0, "stdout=\n{stdout}");
    assert!(stdout.contains("control_relay:"), "{stdout}");
    assert!(stdout.contains("enabled"), "{stdout}");
    // edge_port = port+1 = 19311; auto = edge_port+2 = 19313
    assert!(stdout.contains("19313"), "expected auto port 19313 in:\n{stdout}");
    Ok(())
}

#[test]
fn test_diagnose_explicit_relay_port() -> Result<()> {
    let ctx = write_edge_cfg("relay-explicit", 19320, 19325, None)?;
    let (stdout, code) = run_diagnose(&ctx.cfg_path)?;
    assert_eq!(code, 0);
    assert!(stdout.contains("control_relay:"));
    assert!(stdout.contains("enabled"));
    assert!(stdout.contains("19325"), "{stdout}");
    Ok(())
}

#[test]
fn test_diagnose_static_peers_listed() -> Result<()> {
    let ctx = write_edge_cfg(
        "relay-static",
        19330,
        0,
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
    let ctx = write_edge_cfg("relay-no-static", 19340, 0, None)?;
    let (stdout, code) = run_diagnose(&ctx.cfg_path)?;
    assert_eq!(code, 0);
    assert!(!stdout.contains("static_peers:"), "{stdout}");
    Ok(())
}

#[tokio::test]
async fn test_edge_relay_ws_port_reachable_after_startup() -> Result<()> {
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    // The relay server binds to `edge_port` (the same port used for direct
    // Edge-to-Edge voice + control). `hub_server.relay_port` is purely advisory
    // metadata advertised in peer notifications. Validate that the relay/voice
    // WS listener is reachable on the edge port assigned by the harness.
    let env = crate::harness::TestEnvBuilder::new()
        .edges(1)
        .port_base(19400)
        .start()
        .await?;

    tokio::time::sleep(Duration::from_millis(1500)).await;

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
