/**
 * Hub 管理工具集成测试（Rust 模式）
 *
 * 测试 `munode-hub migrate`、`munode-hub backup`、`munode-hub admin` 子命令：
 * - migrate: 首次运行应用所有迁移；再次运行显示 up-to-date
 * - backup: 生成 DB 备份文件和 manifest.json
 * - admin: list-users、list-channels、list-bans、cleanup-bans、schema-version
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { USE_RUST } from '../setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const TMP = path.join(PROJECT_ROOT, 'tmp', 'admin-tests');

function findBinary(name: string): string {
  const debug = path.join(PROJECT_ROOT, `rust/target/debug/${name}`);
  const release = path.join(PROJECT_ROOT, `rust/target/release/${name}`);
  if (fs.existsSync(debug)) return debug;
  if (fs.existsSync(release)) return release;
  throw new Error(`Binary not found: ${name}`);
}

function run(bin: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000 });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/** Write a minimal valid Hub config JSON/TOML to a temp file. */
function writeHubConfig(name: string, extra: object = {}): string {
  fs.mkdirSync(TMP, { recursive: true });
  const cfgPath = path.join(TMP, `${name}.json`);
  const cfg = {
    network: { control_port: 19200 },
    database: { path: path.join(TMP, `${name}.db`) },
    blob_store: { path: path.join(TMP, `${name}-blobs`) },
    auth: { allow_guest: true },
    registry: { hmac_secret: 'test-secret' },
    log_level: 'error',
    ...extra,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  // Clean up temp files
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── migrate ─────────────────────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Hub migrate subcommand', () => {
  const HUB = () => findBinary('munode-hub');

  it('first run applies all migrations and exits 0', () => {
    const cfg = writeHubConfig('migrate-fresh');
    const { stdout, exitCode } = run(HUB(), ['migrate', cfg]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('MuNode Hub Database Migration');
    expect(stdout).toContain('Current schema version: 0');
    expect(stdout).toContain('✅ v1:');
    expect(stdout).toContain('✅ Applied');
  });

  it('second run reports up to date and exits 0', () => {
    const cfg = writeHubConfig('migrate-idempotent');
    // Run once to apply all
    run(HUB(), ['migrate', cfg]);
    // Run again — should be up to date
    const { stdout, exitCode } = run(HUB(), ['migrate', cfg]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('up to date');
  });

  it('migrate prints list of applied migrations on second run', () => {
    const cfg = writeHubConfig('migrate-list');
    run(HUB(), ['migrate', cfg]);
    const { stdout } = run(HUB(), ['migrate', cfg]);
    expect(stdout).toContain('Applied migrations');
    expect(stdout).toContain('v1');
    expect(stdout).toContain('Add ext_users table');
  });

  it('migrate with invalid config exits non-zero', () => {
    const { exitCode } = run(HUB(), ['migrate', '/nonexistent/hub.json']);
    expect(exitCode).not.toBe(0);
  });
});

// ─── backup ──────────────────────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Hub backup subcommand', () => {
  const HUB = () => findBinary('munode-hub');

  it('backup creates destination directory and DB backup', () => {
    const cfg = writeHubConfig('backup-basic');
    // Ensure DB exists by running migrate first
    run(HUB(), ['migrate', cfg]);
    const dest = path.join(TMP, 'backup-basic-out');
    const { stdout, exitCode } = run(HUB(), ['backup', cfg, dest]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('MuNode Hub Backup');
    expect(stdout).toContain('✅ Database backed up');
    expect(fs.existsSync(path.join(dest, 'munode.db'))).toBe(true);
  });

  it('backup writes manifest.json with created_at field', () => {
    const cfg = writeHubConfig('backup-manifest');
    // Ensure DB exists by running migrate first
    run(HUB(), ['migrate', cfg]);
    const dest = path.join(TMP, 'backup-manifest-out');
    run(HUB(), ['backup', cfg, dest]);
    const manifestPath = path.join(dest, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    interface ManifestFile {
      created_at: number;
      db_path: string;
      blob_path: string;
      version: string;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ManifestFile;
    expect(typeof manifest.created_at).toBe('number');
    expect(manifest.version).toBe('1');
  });

  it('backup with blob store directory also copies blobs', () => {
    const cfg = writeHubConfig('backup-blobs');
    // Ensure DB exists by running migrate first
    run(HUB(), ['migrate', cfg]);
    // The config sets blob_store.path = TMP/backup-blobs-blobs (writeHubConfig appends "-blobs")
    const blobDir = path.join(TMP, 'backup-blobs-blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'test-blob.bin'), Buffer.from('hello'));
    const dest = path.join(TMP, 'backup-blobs-out');
    const { stdout } = run(HUB(), ['backup', cfg, dest]);
    expect(stdout).toContain('Blobs backed up');
    expect(fs.existsSync(path.join(dest, 'blobs', 'test-blob.bin'))).toBe(true);
  });

  it('backup with missing source DB still exits 0 and reports warning', () => {
    const cfg = writeHubConfig('backup-nodbfile');
    // Remove the DB that was just auto-created by writeHubConfig loading
    const dest = path.join(TMP, 'backup-nodbfile-out');
    const cfgObj = JSON.parse(fs.readFileSync(cfg, 'utf-8')) as Record<string, unknown>;
    const dbPath = cfgObj.database as Record<string, string>;
    if (fs.existsSync(dbPath.path)) {
      fs.rmSync(dbPath.path);
    }
    const { stdout, exitCode } = run(HUB(), ['backup', cfg, dest]);
    // Should still succeed (backup is best-effort for missing files)
    expect(exitCode).toBe(0);
    expect(stdout).toContain('skipping');
  });

  it('backup with invalid config exits non-zero', () => {
    const { exitCode } = run(HUB(), ['backup', '/nonexistent/hub.json', '/tmp/dest']);
    expect(exitCode).not.toBe(0);
  });
});

// ─── admin ───────────────────────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Hub admin subcommand', () => {
  const HUB = () => findBinary('munode-hub');
  let adminCfg: string;

  beforeAll(() => {
    adminCfg = writeHubConfig('admin-basic');
  });

  it('admin list-users shows header and total', () => {
    const { stdout, exitCode } = run(HUB(), ['admin', adminCfg, 'list-users']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Username');
    expect(stdout).toContain('Total:');
  });

  it('admin list-channels shows Root channel', () => {
    const { stdout, exitCode } = run(HUB(), ['admin', adminCfg, 'list-channels']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Root');
    expect(stdout).toContain('Total:');
  });

  it('admin list-bans shows header and total', () => {
    const { stdout, exitCode } = run(HUB(), ['admin', adminCfg, 'list-bans']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Total:');
  });

  it('admin cleanup-bans exits 0', () => {
    const { stdout, exitCode } = run(HUB(), ['admin', adminCfg, 'cleanup-bans']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Removed');
  });

  it('admin schema-version shows numeric version', () => {
    const { stdout, exitCode } = run(HUB(), ['admin', adminCfg, 'schema-version']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Schema version:');
    const match = stdout.match(/Schema version:\s*(\d+)/);
    expect(match).not.toBeNull();
    // Version should be >= 0
    expect(parseInt(match![1])).toBeGreaterThanOrEqual(0);
  });

  it('admin with unknown command shows help', () => {
    const { stdout, exitCode } = run(HUB(), ['admin', adminCfg, 'help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('list-users');
    expect(stdout).toContain('list-channels');
  });

  it('admin with invalid config exits non-zero', () => {
    const { exitCode } = run(HUB(), ['admin', '/nonexistent/hub.json', 'list-users']);
    expect(exitCode).not.toBe(0);
  });
});
