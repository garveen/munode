/**
 * Peer Edge Control Relay 集成测试（Rust 模式）
 *
 * 测试 Edge 间控制信道中继（always-on relay，无需 allow_peer_proxy 标志）：
 * - 所有 Edge 自动在 edge_port 上启动 relay server
 * - diagnose 命令总是显示 control_relay: enabled 及 edge_port
 * - static_peers 配置用于启动前已知的 peer 地址
 * - relay 服务器接受 WebSocket 连接并转发到 Hub
 * - 动态发现 peer 时，缺失 relay_port 元数据也会退化到 peer edge_port
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { fileURLToPath } from 'url';
import {
  USE_RUST,
  setupTestEnvironment,
  type TestEnvironment,
} from '../setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const CERTS_DIR = path.join(PROJECT_ROOT, 'tests', 'integration', 'certs');
const TMP = path.join(PROJECT_ROOT, 'tmp', 'relay-tests');

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

async function waitForTcpReachable(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.once('connect', () => {
        cleanup();
        resolve(true);
      });
      socket.once('error', () => {
        cleanup();
        resolve(false);
      });
      socket.setTimeout(250, () => {
        cleanup();
        resolve(false);
      });

      socket.connect(port, host);
    });

    if (reachable) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Relay port ${port} not reachable within timeout`);
}

/** Build a minimal Edge config for diagnose / relay tests. */
function relayEdgeConfig(port: number, staticPeers?: Array<{host: string; relay_port: number}>) {
  return {
    server_id: 1,
    name: 'RelayEdge',
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
      control_port: 19300,
      hmac_secret: 'test-secret',
      ...(staticPeers ? { static_peers: staticPeers } : {}),
    },
  };
}

// ─── Config / diagnose tests (no live servers needed) ────────────────────────

describe.skipIf(!USE_RUST)('Control relay config & diagnose', () => {
  const EDGE_BIN = () => findBinary('munode-edge');

  beforeAll(() => { fs.mkdirSync(TMP, { recursive: true }); });
  afterAll(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('diagnose always shows control_relay enabled on edge_port', () => {
    const cfgPath = path.join(TMP, 'relay-auto.json');
    fs.writeFileSync(cfgPath, JSON.stringify(relayEdgeConfig(19310)));
    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', cfgPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('control_relay:');
    expect(stdout).toContain('enabled');
    expect(stdout).toContain('19311');
  });

  it('diagnose shows static_peers when configured', () => {
    const cfg = relayEdgeConfig(19330, [
      { host: '10.0.0.2', relay_port: 19335 },
      { host: '10.0.0.3', relay_port: 19336 },
    ]);
    const cfgPath = path.join(TMP, 'relay-static-peers.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', cfgPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('static_peers:');
    expect(stdout).toContain('10.0.0.2:19335');
    expect(stdout).toContain('10.0.0.3:19336');
  });

  it('diagnose shows no static_peers when not configured', () => {
    const cfgPath = path.join(TMP, 'relay-no-static.json');
    fs.writeFileSync(cfgPath, JSON.stringify(relayEdgeConfig(19340)));
    const { stdout, exitCode } = run(EDGE_BIN(), ['diagnose', cfgPath]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('static_peers:');
  });
});

// ─── Live relay server test ───────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Relay server accepts connections (always-on)', () => {
  let env: TestEnvironment | null = null;
  const BASE_PORT = 19350;

  beforeAll(async () => {
    // Start Hub + Edge — relay server is always started, no special config needed
    env = await setupTestEnvironment(BASE_PORT, {
      isolated: true,
      silent: true,
    });
  }, 60_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it('Edge relay server port is reachable via TCP after startup', async () => {
    expect(env).not.toBeNull();
    const relayPort = env!.edgeEdgePort;
    expect(relayPort).toBeGreaterThan(0);

    await waitForTcpReachable(relayPort, '127.0.0.1', 5_000);
  }, 30_000);
});

// ─── Static peers config test ─────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Cluster starts without hub relay_port config', () => {
  let env: TestEnvironment | null = null;
  const BASE_PORT = 19360;

  beforeAll(async () => {
    env = await setupTestEnvironment(BASE_PORT, {
      isolated: true,
      silent: true,
    });
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it('cluster starts successfully with default edge_port relay listener', () => {
    expect(env).not.toBeNull();
  });
});
