//! CLI diagnose subcommand tests.
//!
//! Covers the behavior previously exercised by
//! `tests/integration/suites/diagnose.test.ts`.

use std::fs;
use std::process::Command;

use anyhow::Result;
use serde_json::json;

use crate::harness::{certs_dir, find_binary};

fn run_bin(name: &str, args: &[&str]) -> Result<(String, String, i32)> {
    let bin = find_binary(name)?;
    let out = Command::new(&bin).args(args).output()?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

#[test]
fn test_hub_diagnose_valid_config_prints_summary() -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let cfg_path = tmp.path().join("hub-diagnose-valid.json");
    fs::write(
        &cfg_path,
        serde_json::to_string_pretty(&json!({
            "network": { "control_port": 19601 },
            "database": { "path": tmp.path().join("diag.db").to_string_lossy() },
            "blob_store": { "path": tmp.path().join("blobs").to_string_lossy() },
            "auth": { "allow_guest": true, "require_auth_service": false },
            "registry": { "hmac_secret": "diag-secret", "heartbeat_timeout": 90000 },
            "web_api": { "enabled": true, "host": "127.0.0.1", "port": 19609 },
            "log_level": "warn"
        }))?,
    )?;

    let cfg = cfg_path.to_string_lossy().to_string();
    let (stdout, _stderr, code) = run_bin("munode-hub", &["diagnose", &cfg])?;
    assert_eq!(code, 0, "hub diagnose should exit 0; stdout=\n{stdout}");
    assert!(stdout.contains("MuNode Hub Diagnostics"), "{stdout}");
    assert!(stdout.contains("Config parse: OK"), "{stdout}");
    assert!(stdout.contains("Configuration Summary"), "{stdout}");
    assert!(stdout.contains("19609"), "{stdout}");
    assert!(stdout.contains("warn"), "{stdout}");
    Ok(())
}

#[test]
fn test_hub_diagnose_reports_missing_lua_script_nonfatally() -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let cfg_path = tmp.path().join("hub-diagnose-lua.json");
    fs::write(
        &cfg_path,
        serde_json::to_string_pretty(&json!({
            "network": { "control_port": 19602 },
            "database": { "path": tmp.path().join("diag.db").to_string_lossy() },
            "blob_store": { "path": tmp.path().join("blobs").to_string_lossy() },
            "auth": {
                "allow_guest": true,
                "require_auth_service": false,
                "lua_script": "/nonexistent/auth.lua"
            },
            "registry": { "hmac_secret": "diag-secret", "heartbeat_timeout": 90000 },
            "log_level": "error"
        }))?,
    )?;

    let cfg = cfg_path.to_string_lossy().to_string();
    let (stdout, _stderr, code) = run_bin("munode-hub", &["diagnose", &cfg])?;
    assert_eq!(
        code, 0,
        "missing optional Lua script should not fail; stdout=\n{stdout}"
    );
    assert!(stdout.contains("Lua auth script"), "{stdout}");
    assert!(stdout.contains("NOT FOUND"), "{stdout}");
    Ok(())
}

#[test]
fn test_hub_diagnose_invalid_and_missing_configs_fail() -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let invalid_cfg = tmp.path().join("hub-diagnose-invalid.json");
    fs::write(&invalid_cfg, "{ invalid json {{{")?;

    let invalid = invalid_cfg.to_string_lossy().to_string();
    let (_stdout, _stderr, invalid_code) = run_bin("munode-hub", &["diagnose", &invalid])?;
    assert_ne!(invalid_code, 0, "invalid hub config should fail");

    let (_stdout, _stderr, missing_code) =
        run_bin("munode-hub", &["diagnose", "/nonexistent/hub.json"])?;
    assert_ne!(missing_code, 0, "missing hub config should fail");
    Ok(())
}

fn edge_cfg_json(base_port: u16) -> serde_json::Value {
    let certs = certs_dir();
    json!({
        "server_id": 42,
        "name": "DiagEdge",
        "network": {
            "host": "0.0.0.0",
            "port": base_port,
            "edge_port": base_port + 1,
            "external_host": "127.0.0.1"
        },
        "tls": {
            "cert": certs.join("server.pem").to_string_lossy(),
            "key": certs.join("server.key").to_string_lossy(),
            "ca": certs.join("ca.pem").to_string_lossy()
        },
        "hub_server": {
            "host": "127.0.0.1",
            "control_port": 1,
            "hmac_secret": "diag-secret",
            "reconnect_interval": 500,
            "heartbeat_interval": 30000
        },
        "server": { "capacity": 100, "max_bandwidth": 558000 },
        "log_level": "error"
    })
}

#[test]
fn test_edge_diagnose_valid_config_reports_tls_and_summary() -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let cfg_path = tmp.path().join("edge-diagnose-valid.json");
    fs::write(
        &cfg_path,
        serde_json::to_string_pretty(&edge_cfg_json(19620))?,
    )?;

    let cfg = cfg_path.to_string_lossy().to_string();
    let (stdout, _stderr, code) = run_bin("munode-edge", &["diagnose", &cfg])?;
    assert_eq!(code, 0, "edge diagnose should exit 0; stdout=\n{stdout}");
    assert!(stdout.contains("MuNode Edge Diagnostics"), "{stdout}");
    assert!(stdout.contains("Config parse: OK"), "{stdout}");
    assert!(stdout.contains("TLS cert: found"), "{stdout}");
    assert!(stdout.contains("Hub TCP reachability"), "{stdout}");
    assert!(stdout.contains("Configuration Summary"), "{stdout}");
    assert!(stdout.contains("42"), "{stdout}");
    assert!(stdout.contains("19620"), "{stdout}");
    Ok(())
}

#[test]
fn test_edge_diagnose_reports_missing_cert_nonfatally() -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let mut cfg = edge_cfg_json(19630);
    cfg["tls"]["cert"] = serde_json::Value::String("/nonexistent/server.pem".to_string());
    let cfg_path = tmp.path().join("edge-diagnose-missing-cert.json");
    fs::write(&cfg_path, serde_json::to_string_pretty(&cfg)?)?;

    let cfg = cfg_path.to_string_lossy().to_string();
    let (stdout, _stderr, code) = run_bin("munode-edge", &["diagnose", &cfg])?;
    assert_eq!(
        code, 0,
        "missing TLS file should not fail diagnose; stdout=\n{stdout}"
    );
    assert!(stdout.contains("TLS cert: NOT FOUND"), "{stdout}");
    Ok(())
}

#[test]
fn test_edge_diagnose_invalid_and_missing_configs_fail() -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let invalid_cfg = tmp.path().join("edge-diagnose-invalid.json");
    fs::write(&invalid_cfg, "{ broken json !!")?;

    let invalid = invalid_cfg.to_string_lossy().to_string();
    let (_stdout, _stderr, invalid_code) = run_bin("munode-edge", &["diagnose", &invalid])?;
    assert_ne!(invalid_code, 0, "invalid edge config should fail");

    let (_stdout, _stderr, missing_code) =
        run_bin("munode-edge", &["diagnose", "/nonexistent/edge.json"])?;
    assert_ne!(missing_code, 0, "missing edge config should fail");
    Ok(())
}
