/**
 * 诊断工具集成测试（Rust 模式）
 *
 * 测试 `munode-hub diagnose` 和 `munode-edge diagnose` 子命令：
 * - 输出包含预期的检查项
 * - 有效配置输出 ✅ 和摘要
 * - 无效配置以非零退出码退出
 * - 缺失文件（TLS 证书、DB、blob 路径）正确报告
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { USE_RUST } from '../setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const CERTS_DIR = path.join(PROJECT_ROOT, 'tests', 'integration', 'certs');

/** Find the compiled Rust binary path. */
function findBinary(name: string): string {
  const debug = path.join(PROJECT_ROOT, `rust/target/debug/${name}`);
  const release = path.join(PROJECT_ROOT, `rust/target/release/${name}`);
  if (fs.existsSync(debug)) return debug;
  if (fs.existsSync(release)) return release;
  throw new Error(`Binary not found: ${name}`);
}

/** Run binary with arguments synchronously and return stdout+stderr combined. */
function run(bin: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

// ─── Hub diagnose ────────────────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Hub diagnose subcommand', () => {
  const HUB_BIN = () => findBinary('munode-hub');

  it('diagnose with valid config exits 0', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-hub-valid.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      network: { control_port: 19001 },
      database: { path: '/tmp/diag-test.db' },
      blob_store: { path: '/tmp/diag-blobs' },
      auth: { allow_guest: true, require_auth_service: false },
      registry: { hmac_secret: 'test-secret', heartbeat_timeout: 90000 },
      log_level: 'error',
    }));

    const { stdout, exitCode } = run(HUB_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('MuNode Hub Diagnostics');
    expect(stdout).toContain('Config parse: OK');
  });

  it('diagnose prints Configuration Summary section', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-hub-summary.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      network: { control_port: 19002 },
      database: { path: '/tmp/diag-test2.db' },
      blob_store: { path: '/tmp/diag-blobs2' },
      auth: { allow_guest: false, require_auth_service: false },
      registry: { hmac_secret: 'test-secret', heartbeat_timeout: 90000 },
      limits: { max_users: 500 },
      log_level: 'warn',
    }));

    const { stdout, exitCode } = run(HUB_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Configuration Summary');
    expect(stdout).toContain('19002'); // control_port
    expect(stdout).toContain('500');   // max_users
    expect(stdout).toContain('warn');  // log_level
  });

  it('diagnose with web_api enabled prints web_api address', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-hub-webapi.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      network: { control_port: 19003 },
      database: { path: '/tmp/diag-test3.db' },
      blob_store: { path: '/tmp/diag-blobs3' },
      auth: { allow_guest: true, require_auth_service: false },
      registry: { hmac_secret: 'test-secret', heartbeat_timeout: 90000 },
      web_api: { enabled: true, host: '127.0.0.1', port: 19009 },
      log_level: 'error',
    }));

    const { stdout, exitCode } = run(HUB_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('19009');     // web_api port
    expect(stdout).toContain('127.0.0.1');
  });

  it('diagnose with lua_script pointing to non-existent file reports error', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-hub-lua.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      network: { control_port: 19004 },
      database: { path: '/tmp/diag-test4.db' },
      blob_store: { path: '/tmp/diag-blobs4' },
      auth: { allow_guest: true, require_auth_service: false, lua_script: '/nonexistent/auth.lua' },
      registry: { hmac_secret: 'test-secret', heartbeat_timeout: 90000 },
      log_level: 'error',
    }));

    const { stdout, exitCode } = run(HUB_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0); // Still exits 0 — diagnose doesn't fail for optional files
    expect(stdout).toContain('Lua auth script');
    expect(stdout).toContain('NOT FOUND');
  });

  it('diagnose with invalid config exits non-zero', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-hub-invalid.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ invalid json {{{{');

    const { exitCode } = run(HUB_BIN(), ['diagnose', configPath]);
    expect(exitCode).not.toBe(0);
  });

  it('diagnose with missing config file exits non-zero', () => {
    const { exitCode } = run(HUB_BIN(), ['diagnose', '/nonexistent/hub.toml']);
    expect(exitCode).not.toBe(0);
  });
});

// ─── Edge diagnose ───────────────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Edge diagnose subcommand', () => {
  const EDGE_BIN = () => findBinary('munode-edge');

  const validEdgeConfig = (port: number) => ({
    server_id: 1,
    name: 'DiagEdge',
    network: {
      host: '0.0.0.0',
      port,
      edge_port: port + 1,
      external_host: '127.0.0.1',
    },
    tls: {
      cert: path.join(CERTS_DIR, 'server.pem'),
      key: path.join(CERTS_DIR, 'server.key'),
      ca: path.join(CERTS_DIR, 'ca.pem'),
    },
    hub_server: {
      host: '127.0.0.1',
      control_port: 1, // port 1 — connection refused, not timeout
      hmac_secret: 'test-secret',
      reconnect_interval: 500,
      heartbeat_interval: 30000,
    },
    server: { capacity: 100, max_bandwidth: 558000 },
    log_level: 'error',
  });

  it('diagnose with valid config exits 0', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-edge-valid.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(validEdgeConfig(19100)));

    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('MuNode Edge Diagnostics');
    expect(stdout).toContain('Config parse: OK');
  });

  it('diagnose reports TLS cert found when files exist', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-edge-tls.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(validEdgeConfig(19102)));

    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('TLS cert: found');
    expect(stdout).toContain('TLS key: found');
    expect(stdout).toContain('TLS CA cert: found');
  });

  it('diagnose reports TLS cert NOT FOUND when cert is missing', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-edge-nocert.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const cfg = validEdgeConfig(19104);
    cfg.tls.cert = '/nonexistent/server.pem';
    fs.writeFileSync(configPath, JSON.stringify(cfg));

    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0); // exits 0 even with missing files
    expect(stdout).toContain('TLS cert: NOT FOUND');
  });

  it('diagnose reports Hub TCP reachability', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-edge-hub.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(validEdgeConfig(19106)));

    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0);
    // Either "reachable" or "connection refused" — both are valid outcomes
    expect(stdout).toContain('Hub TCP reachability');
  });

  it('diagnose prints Configuration Summary section', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-edge-summary.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const cfg = {
      ...validEdgeConfig(19108),
      server_id: 42,
      name: 'SummaryEdge',
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg));

    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', configPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Configuration Summary');
    expect(stdout).toContain('42');           // server_id
    expect(stdout).toContain('SummaryEdge'); // name
    expect(stdout).toContain('19108');        // port
    expect(stdout).toContain('auto_fallback'); // default connection_strategy
  });

  it('diagnose with invalid JSON config exits non-zero', () => {
    const configPath = path.join(PROJECT_ROOT, 'tmp', 'diag-edge-invalid.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ broken json !!');

    const { exitCode } = run(EDGE_BIN(), ['diagnose', configPath]);
    expect(exitCode).not.toBe(0);
  });

  it('diagnose with missing config file exits non-zero', () => {
    const { exitCode } = run(EDGE_BIN(), ['diagnose', '/nonexistent/edge.toml']);
    expect(exitCode).not.toBe(0);
  });
});
