//! `generate-config` subcommand tests — migrated from
//! `tests/integration/suites/generate-config.test.ts`.

use std::fs;
use std::process::Command;

use anyhow::Result;
use tempfile::TempDir;

use crate::harness::find_binary;

fn run(
    bin: &std::path::Path,
    args: &[&str],
    cwd: Option<&std::path::Path>,
) -> (i32, String, String) {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let out = cmd.output().expect("spawn binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

// ── Hub generate-config ────────────────────────────────────────────────────

#[test]
fn test_hub_generate_config_creates_file() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("hub.toml");
    let bin = find_binary("munode-hub")?;
    let (code, stdout, _) = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    assert_eq!(code, 0, "exit code should be 0");
    assert!(stdout.contains("hub.toml"));
    assert!(out.exists(), "file must exist");
    Ok(())
}

#[test]
fn test_hub_generate_config_contains_sections() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("hub.toml");
    let bin = find_binary("munode-hub")?;
    let _ = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    let content = fs::read_to_string(&out)?;
    for section in [
        "[network]",
        "[database]",
        "[registry]",
        "[auth]",
        "[web_api]",
        "[blob_store]",
    ] {
        assert!(content.contains(section), "missing section {}", section);
    }
    Ok(())
}

#[test]
fn test_hub_generate_config_validates() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("hub.toml");
    let bin = find_binary("munode-hub")?;
    let _ = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    let (code, stdout, stderr) = run(&bin, &["validate-config", out.to_str().unwrap()], None);
    assert_eq!(code, 0, "validate-config should succeed: stderr={}", stderr);
    assert!(
        stdout.contains("valid") || stderr.contains("valid"),
        "expected 'valid' in output: stdout={} stderr={}",
        stdout,
        stderr
    );
    Ok(())
}

#[test]
fn test_hub_generate_config_refuses_overwrite() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("hub.toml");
    fs::write(&out, "# existing")?;
    let bin = find_binary("munode-hub")?;
    let (code, _, stderr) = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    assert_ne!(code, 0, "should refuse overwrite");
    assert!(stderr.contains("already exists"), "stderr: {}", stderr);
    Ok(())
}

#[test]
fn test_hub_generate_config_default_path() -> Result<()> {
    let tmp = TempDir::new()?;
    let bin = find_binary("munode-hub")?;
    let (code, stdout, _) = run(&bin, &["generate-config"], Some(tmp.path()));
    assert_eq!(code, 0);
    assert!(stdout.contains("hub.toml"));
    assert!(tmp.path().join("hub.toml").exists());
    Ok(())
}

// ── Edge generate-config ───────────────────────────────────────────────────

#[test]
fn test_edge_generate_config_creates_file() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("edge.toml");
    let bin = find_binary("munode-edge")?;
    let (code, stdout, _) = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    assert_eq!(code, 0);
    assert!(stdout.contains("edge.toml"));
    assert!(out.exists());
    Ok(())
}

#[test]
fn test_edge_generate_config_contains_sections() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("edge.toml");
    let bin = find_binary("munode-edge")?;
    let _ = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    let content = fs::read_to_string(&out)?;
    for section in ["[network]", "[tls]", "[hub_server]", "[server]"] {
        assert!(content.contains(section), "missing {}", section);
    }
    Ok(())
}

#[test]
fn test_edge_generate_config_validates() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("edge.toml");
    let bin = find_binary("munode-edge")?;
    let _ = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    let (code, stdout, stderr) = run(&bin, &["validate-config", out.to_str().unwrap()], None);
    assert_eq!(code, 0, "stderr={}", stderr);
    assert!(
        stdout.contains("valid") || stderr.contains("valid"),
        "expected 'valid': stdout={} stderr={}",
        stdout,
        stderr
    );
    Ok(())
}

#[test]
fn test_edge_generate_config_refuses_overwrite() -> Result<()> {
    let tmp = TempDir::new()?;
    let out = tmp.path().join("edge.toml");
    fs::write(&out, "# existing")?;
    let bin = find_binary("munode-edge")?;
    let (code, _, stderr) = run(&bin, &["generate-config", out.to_str().unwrap()], None);
    assert_ne!(code, 0);
    assert!(stderr.contains("already exists"), "stderr: {}", stderr);
    Ok(())
}

#[test]
fn test_edge_generate_config_default_path() -> Result<()> {
    let tmp = TempDir::new()?;
    let bin = find_binary("munode-edge")?;
    let (code, stdout, _) = run(&bin, &["generate-config"], Some(tmp.path()));
    assert_eq!(code, 0);
    assert!(stdout.contains("edge.toml"));
    assert!(tmp.path().join("edge.toml").exists());
    Ok(())
}
