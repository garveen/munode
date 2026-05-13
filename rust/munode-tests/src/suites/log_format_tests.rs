//! Structured JSON log format tests — migrated from
//! `tests/integration/suites/log-format.test.ts`.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;
use tempfile::TempDir;

use crate::harness::{ReservedPortBlock, certs_dir, find_binary};

/// Spawn `bin args...`, read combined stdout/stderr lines for `dur`, then kill the process.
fn capture_output(bin: &std::path::Path, args: &[&str], dur: Duration) -> Vec<String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let h_out = std::thread::spawn(move || {
        BufReader::new(stdout)
            .lines()
            .filter_map(|l| l.ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    });
    let h_err = std::thread::spawn(move || {
        BufReader::new(stderr)
            .lines()
            .filter_map(|l| l.ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    });

    let deadline = Instant::now() + dur;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();

    let mut out = h_out.join().unwrap_or_default();
    out.extend(h_err.join().unwrap_or_default());
    out
}

/// Validate that `raw` is a tracing-subscriber JSON log line.
fn parse_and_validate(raw: &str) -> Value {
    let v: Value = serde_json::from_str(raw).unwrap_or_else(|_| panic!("not JSON: {raw}"));
    let obj = v.as_object().expect("object");
    assert!(
        obj.get("timestamp").and_then(|x| x.as_str()).is_some(),
        "timestamp: {raw}"
    );
    let level = obj.get("level").and_then(|x| x.as_str()).expect("level");
    assert!(
        ["INFO", "WARN", "ERROR", "DEBUG", "TRACE"].contains(&level),
        "bad level: {raw}"
    );
    assert!(
        obj.get("target").and_then(|x| x.as_str()).is_some(),
        "target: {raw}"
    );
    let fields = obj
        .get("fields")
        .and_then(|x| x.as_object())
        .expect("fields obj");
    assert!(
        fields.get("message").and_then(|x| x.as_str()).is_some(),
        "fields.message: {raw}"
    );
    v
}

fn next_port(ports: &mut ReservedPortBlock) -> u16 {
    ports.next_port().expect("free port")
}

// ── Hub JSON log format ───────────────────────────────────────────────────

fn write_hub_config_json(
    tmp: &TempDir,
    control_port: u16,
    web_api_port: u16,
    log_format: Option<&str>,
) -> std::path::PathBuf {
    let cfg_path = tmp.path().join("hub.json");
    let mut cfg = serde_json::json!({
        "network": { "host": "127.0.0.1", "control_port": control_port },
        "database": { "path": tmp.path().join("hub.db").to_str().unwrap() },
        "blob_store": { "path": tmp.path().join("blobs").to_str().unwrap() },
        "web_api": { "enabled": true, "host": "127.0.0.1", "port": web_api_port },
        "auth": { "allow_guest": true, "require_auth_service": false },
        "registry": { "hmac_secret": "test-secret", "heartbeat_timeout": 90000 },
        "log_level": "info",
    });
    if let Some(fmt) = log_format {
        cfg.as_object_mut()
            .unwrap()
            .insert("log_format".into(), Value::String(fmt.into()));
    }
    std::fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
    cfg_path
}

#[test]
fn test_hub_json_format_emits_valid_json_lines() -> Result<()> {
    let tmp = TempDir::new()?;
    let mut ports = ReservedPortBlock::acquire(19000)?;
    let cfg = write_hub_config_json(
        &tmp,
        next_port(&mut ports),
        next_port(&mut ports),
        Some("json"),
    );
    let bin = find_binary("munode-hub")?;
    let lines = capture_output(&bin, &[cfg.to_str().unwrap()], Duration::from_millis(2000));
    assert!(!lines.is_empty(), "no log output captured");
    for line in &lines {
        parse_and_validate(line);
    }
    Ok(())
}

#[test]
fn test_hub_json_format_startup_message_has_control_port() -> Result<()> {
    let tmp = TempDir::new()?;
    let mut ports = ReservedPortBlock::acquire(19000)?;
    let cfg = write_hub_config_json(
        &tmp,
        next_port(&mut ports),
        next_port(&mut ports),
        Some("json"),
    );
    let bin = find_binary("munode-hub")?;
    let lines = capture_output(&bin, &[cfg.to_str().unwrap()], Duration::from_millis(2000));
    let parsed: Vec<Value> = lines.iter().map(|l| parse_and_validate(l)).collect();
    let startup = parsed.iter().find(|v| {
        v.get("level").and_then(|x| x.as_str()) == Some("INFO")
            && v.get("fields")
                .and_then(|f| f.get("message"))
                .and_then(|x| x.as_str())
                .map(|m| m.contains("MuNode Hub"))
                .unwrap_or(false)
    });
    let s = startup.expect("expected Hub startup INFO line");
    assert!(
        s.get("fields")
            .and_then(|f| f.get("control_port"))
            .is_some(),
        "startup line missing control_port field"
    );
    Ok(())
}

#[test]
fn test_hub_text_format_default_is_not_json() -> Result<()> {
    let tmp = TempDir::new()?;
    let mut ports = ReservedPortBlock::acquire(19000)?;
    let cfg = write_hub_config_json(&tmp, next_port(&mut ports), next_port(&mut ports), None);
    let bin = find_binary("munode-hub")?;
    let lines = capture_output(&bin, &[cfg.to_str().unwrap()], Duration::from_millis(2000));
    assert!(!lines.is_empty());
    let has_non_json = lines
        .iter()
        .any(|l| serde_json::from_str::<Value>(l).is_err());
    assert!(
        has_non_json,
        "text mode should emit at least one non-JSON line"
    );
    Ok(())
}

// ── Edge JSON log format ──────────────────────────────────────────────────

fn write_edge_config_json(
    tmp: &TempDir,
    ports: &mut ReservedPortBlock,
    server_id: u32,
    log_format: Option<&str>,
) -> std::path::PathBuf {
    let cfg_path = tmp.path().join("edge.json");
    let port = next_port(ports);
    let edge_port = next_port(ports);
    let certs = certs_dir();
    let mut cfg = serde_json::json!({
        "server_id": server_id,
        "name": format!("Edge-LogTest-{}", server_id),
        "network": {
            "host": "0.0.0.0",
            "port": port,
            "edge_port": edge_port,
            "external_host": "127.0.0.1",
        },
        "tls": {
            "cert": certs.join("server.pem").to_str().unwrap(),
            "key":  certs.join("server.key").to_str().unwrap(),
            "ca":   certs.join("ca.pem").to_str().unwrap(),
        },
        "hub_server": {
            "host": "127.0.0.1",
            "control_port": 1, // unreachable — edge logs startup then fails
            "hmac_secret": "test-secret",
            "reconnect_interval": 500,
            "heartbeat_interval": 30000,
        },
        "server": { "capacity": 100, "max_bandwidth": 558000 },
        "log_level": "info",
    });
    if let Some(fmt) = log_format {
        cfg.as_object_mut()
            .unwrap()
            .insert("log_format".into(), Value::String(fmt.into()));
    }
    std::fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
    cfg_path
}

#[test]
fn test_edge_json_format_emits_valid_json_lines() -> Result<()> {
    let tmp = TempDir::new()?;
    let mut ports = ReservedPortBlock::acquire(19000)?;
    let cfg = write_edge_config_json(&tmp, &mut ports, 1, Some("json"));
    let bin = find_binary("munode-edge")?;
    let lines = capture_output(&bin, &[cfg.to_str().unwrap()], Duration::from_millis(2000));
    assert!(!lines.is_empty(), "no log output captured from edge");
    for line in &lines {
        parse_and_validate(line);
    }
    Ok(())
}

#[test]
fn test_edge_json_format_startup_has_server_id() -> Result<()> {
    let tmp = TempDir::new()?;
    let mut ports = ReservedPortBlock::acquire(19000)?;
    let cfg = write_edge_config_json(&tmp, &mut ports, 42, Some("json"));
    let bin = find_binary("munode-edge")?;
    let lines = capture_output(&bin, &[cfg.to_str().unwrap()], Duration::from_millis(2000));
    let parsed: Vec<Value> = lines.iter().map(|l| parse_and_validate(l)).collect();
    let startup = parsed.iter().find(|v| {
        v.get("level").and_then(|x| x.as_str()) == Some("INFO")
            && v.get("fields")
                .and_then(|f| f.get("message"))
                .and_then(|x| x.as_str())
                .map(|m| m.contains("MuNode Edge"))
                .unwrap_or(false)
    });
    let s = startup.expect("expected Edge startup INFO line");
    assert!(
        s.get("fields").and_then(|f| f.get("server_id")).is_some(),
        "edge startup line missing server_id field"
    );
    Ok(())
}
