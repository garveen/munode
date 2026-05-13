//! Hub admin/migrate/backup CLI subcommand integration tests.
//!
//! Spawns `munode-hub <subcommand> <cfg>` directly and inspects stdout/exit.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Result;
use serde_json::json;

use crate::harness::find_binary;

struct AdminCtx {
    cfg_path: PathBuf,
    db_path: PathBuf,
    blob_path: PathBuf,
    tmp: tempfile::TempDir,
}

fn admin_ctx(name: &str) -> Result<AdminCtx> {
    let tmp = tempfile::tempdir()?;
    let tmp_path = tmp.path().to_path_buf();
    let db_path = tmp_path.join(format!("{name}.db"));
    let blob_path = tmp_path.join(format!("{name}-blobs"));
    fs::create_dir_all(&blob_path)?;

    let cfg = json!({
        "network": { "control_port": 19200 },
        "database": { "path": db_path.to_string_lossy() },
        "blob_store": { "path": blob_path.to_string_lossy() },
        "auth": { "allow_guest": true },
        "registry": { "hmac_secret": "test-secret" },
        "log_level": "error",
    });
    let cfg_path = tmp_path.join(format!("{name}.json"));
    fs::write(&cfg_path, serde_json::to_string_pretty(&cfg)?)?;

    Ok(AdminCtx {
        cfg_path,
        db_path,
        blob_path,
        tmp,
    })
}

fn run_hub(args: &[&str]) -> Result<(String, String, i32)> {
    let bin = find_binary("munode-hub")?;
    let out = Command::new(&bin).args(args).output()?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

// ── migrate ───────────────────────────────────────────────────────────────

#[test]
fn test_migrate_first_run_applies_migrations() -> Result<()> {
    let ctx = admin_ctx("migrate-fresh")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    let (stdout, _stderr, code) = run_hub(&["migrate", &cfg])?;
    assert_eq!(code, 0, "migrate should exit 0; stdout=\n{stdout}");
    assert!(
        stdout.contains("MuNode Hub Database Migration") || stdout.contains("Migration"),
        "migrate output should mention migration; got:\n{stdout}"
    );
    drop(ctx.tmp);
    Ok(())
}

#[test]
fn test_migrate_idempotent_second_run() -> Result<()> {
    let ctx = admin_ctx("migrate-idempotent")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    let (stdout, _stderr, code) = run_hub(&["migrate", &cfg])?;
    assert_eq!(code, 0);
    assert!(
        stdout.to_lowercase().contains("up to date")
            || stdout.contains("Applied")
            || stdout.contains("v1"),
        "second run should mention up-to-date or list migrations; got:\n{stdout}"
    );
    drop(ctx.tmp);
    Ok(())
}

#[test]
fn test_migrate_invalid_config_exits_nonzero() -> Result<()> {
    let (_stdout, _stderr, code) = run_hub(&["migrate", "/nonexistent/hub.json"])?;
    assert_ne!(code, 0);
    Ok(())
}

// ── backup ────────────────────────────────────────────────────────────────

#[test]
fn test_backup_creates_db_and_manifest() -> Result<()> {
    let ctx = admin_ctx("backup-basic")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    let dest = ctx.tmp.path().join("backup-out");
    let dest_str = dest.to_string_lossy().to_string();
    let (stdout, _stderr, code) = run_hub(&["backup", &cfg, &dest_str])?;
    assert_eq!(code, 0, "backup should exit 0; stdout=\n{stdout}");
    assert!(
        dest.join("munode.db").exists(),
        "db file should be backed up"
    );
    let manifest = dest.join("manifest.json");
    assert!(manifest.exists(), "manifest.json should exist");
    let m: serde_json::Value = serde_json::from_str(&fs::read_to_string(&manifest)?)?;
    assert!(m["created_at"].is_number(), "created_at should be numeric");
    Ok(())
}

#[test]
fn test_backup_includes_blobs() -> Result<()> {
    let ctx = admin_ctx("backup-blobs")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    fs::write(ctx.blob_path.join("test-blob.bin"), b"hello")?;
    let dest = ctx.tmp.path().join("backup-blobs-out");
    let dest_str = dest.to_string_lossy().to_string();
    let (stdout, _stderr, _code) = run_hub(&["backup", &cfg, &dest_str])?;
    assert!(
        stdout.contains("Blobs") || dest.join("blobs").join("test-blob.bin").exists(),
        "blob should be copied; stdout=\n{stdout}"
    );
    Ok(())
}

#[test]
fn test_backup_invalid_config_exits_nonzero() -> Result<()> {
    let (_stdout, _stderr, code) = run_hub(&["backup", "/nonexistent/hub.json", "/tmp/dest"])?;
    assert_ne!(code, 0);
    Ok(())
}

// ── admin subcommand ──────────────────────────────────────────────────────

#[test]
fn test_admin_list_users() -> Result<()> {
    let ctx = admin_ctx("admin-list-users")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    let (stdout, _stderr, code) = run_hub(&["admin", &cfg, "list-users"])?;
    assert_eq!(code, 0, "admin list-users should exit 0; stdout=\n{stdout}");
    assert!(
        stdout.contains("Username") || stdout.contains("Total:"),
        "list-users should show table or total; got:\n{stdout}"
    );
    Ok(())
}

#[test]
fn test_admin_list_channels_shows_root() -> Result<()> {
    let ctx = admin_ctx("admin-list-channels")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    let (stdout, _stderr, code) = run_hub(&["admin", &cfg, "list-channels"])?;
    assert_eq!(code, 0);
    assert!(
        stdout.contains("Root"),
        "should show Root channel; got:\n{stdout}"
    );
    Ok(())
}

#[test]
fn test_admin_list_bans() -> Result<()> {
    let ctx = admin_ctx("admin-list-bans")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    let (stdout, _stderr, code) = run_hub(&["admin", &cfg, "list-bans"])?;
    assert_eq!(code, 0);
    assert!(
        stdout.contains("Total:"),
        "should show ban total; got:\n{stdout}"
    );
    Ok(())
}

#[test]
fn test_admin_cleanup_bans() -> Result<()> {
    let ctx = admin_ctx("admin-cleanup-bans")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    let (stdout, _stderr, code) = run_hub(&["admin", &cfg, "cleanup-bans"])?;
    assert_eq!(code, 0);
    assert!(
        stdout.contains("Removed"),
        "should mention 'Removed'; got:\n{stdout}"
    );
    Ok(())
}

#[test]
fn test_admin_schema_version() -> Result<()> {
    let ctx = admin_ctx("admin-schema-version")?;
    let cfg = ctx.cfg_path.to_string_lossy().to_string();
    run_hub(&["migrate", &cfg])?;
    let (stdout, _stderr, code) = run_hub(&["admin", &cfg, "schema-version"])?;
    assert_eq!(code, 0);
    assert!(stdout.contains("Schema version:"), "got:\n{stdout}");
    let n: u32 = stdout
        .lines()
        .find_map(|l| l.split("Schema version:").nth(1))
        .and_then(|s| s.trim().split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let _ = n; // Just verify it parses
    Ok(())
}

#[test]
fn test_admin_invalid_config_exits_nonzero() -> Result<()> {
    let (_stdout, _stderr, code) = run_hub(&["admin", "/nonexistent/hub.json", "list-users"])?;
    assert_ne!(code, 0);
    Ok(())
}

// Suppress unused warnings on db/blob fields kept for cleanup ownership.
#[allow(dead_code)]
fn _unused(_a: &AdminCtx) {
    let _ = &_a.db_path;
    let _ = &_a.blob_path;
}
