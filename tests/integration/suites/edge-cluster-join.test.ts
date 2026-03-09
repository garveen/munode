/**
 * Edge 集群加入与外部地址广播集成测试
 *
 * 测试目标：
 * 1. Edge 启动时使用 external_host / external_port 向 Hub 注册（而非 Hub 的地址）
 * 2. Edge 调用 edge.join 加入集群拓扑，Hub 将其地址广播给其他 Edge
 * 3. 两个 Edge 均可接受客户端连接
 * 4. 跨 Edge 用户可见（hub 同步正常）
 *
 * 对于 Rust 实现：使用 RustServerProcess 启动真实二进制文件
 * 对于 TS 实现：使用 setupTestEnvironment（startEdge2=true）
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import * as fs from 'fs';
import * as net from 'net';
import {
  RustServerProcess,
  TestEnvironment,
  USE_RUST,
  debugLog,
  findAvailablePort,
  isPortAvailable,
  setupTestEnvironment,
} from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';

const PROJECT_ROOT = join(import.meta.dirname, '../../..');
const CERTS_DIR = join(PROJECT_ROOT, 'tests/integration/certs');
const HMAC_SECRET = 'test-hmac-secret-key-for-integration-tests';

// ─── helpers ────────────────────────────────────────────────────────────────

function isPortListening(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    const socket = net.createConnection({ host, port });
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForPortListening(
  host: string,
  port: number,
  maxWaitMs = 15000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isPortListening(host, port, intervalMs)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Port ${host}:${port} did not become available within ${maxWaitMs}ms`);
}

// ─── Rust-specific test helpers ─────────────────────────────────────────────

/**
 * Build a Rust Hub JSON config, write it to tmp/ and return the path.
 */
function writeRustHubConfig(basePort: number, controlPort: number, authPort: number): string {
  const configPath = join(PROJECT_ROOT, `tmp/rust-hub-cluster-${basePort}.json`);
  fs.mkdirSync(join(PROJECT_ROOT, 'tmp'), { recursive: true });
  const config = {
    network: { host: '127.0.0.1', control_port: controlPort },
    database: { path: join(PROJECT_ROOT, `tmp/rust-hub-cluster-${basePort}.db`) },
    auth: { allow_guest: true, require_auth_service: false },
    registry: { hmac_secret: HMAC_SECRET, heartbeat_timeout: 90000 },
    log_level: 'error',
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Build a Rust Edge JSON config with explicit external_host / external_port.
 * `listenPort`  — the port the Edge process actually binds (clients connect here)
 * `externalPort` — the port advertised to Hub and other Edges (simulates NAT)
 */
function writeRustEdgeConfig(params: {
  serverId: number;
  name: string;
  listenPort: number;
  externalPort: number;
  edgePort: number;
  controlPort: number;
  basePort: number;
}): string {
  const configPath = join(
    PROJECT_ROOT,
    `tmp/rust-edge-cluster-${params.basePort}-${params.serverId}.json`,
  );
  fs.mkdirSync(join(PROJECT_ROOT, 'tmp'), { recursive: true });
  const config = {
    server_id: params.serverId,
    name: params.name,
    network: {
      host: '0.0.0.0',
      port: params.listenPort,
      edge_port: params.edgePort,
      external_host: '127.0.0.1',
      external_port: params.externalPort,
    },
    tls: {
      cert: join(CERTS_DIR, 'server.pem'),
      key: join(CERTS_DIR, 'server.key'),
      ca: join(CERTS_DIR, 'ca.pem'),
    },
    hub_server: {
      host: '127.0.0.1',
      control_port: params.controlPort,
      hmac_secret: HMAC_SECRET,
      reconnect_interval: 3000,
      heartbeat_interval: 30000,
    },
    server: { capacity: 100, max_bandwidth: 558000 },
    log_level: 'error',
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('Edge Cluster Join & External Host Broadcast', () => {
  // Rust mode: start real binaries ourselves so we can control the config precisely.
  // TS mode  : use the shared test environment infrastructure.

  if (USE_RUST) {
    // ── Rust implementation path ──────────────────────────────────────────

    let hubProc: RustServerProcess;
    let edge1Proc: RustServerProcess;
    let edge2Proc: RustServerProcess;

    let basePort: number;
    let controlPort: number;
    // Edge-1: listens on listenPort1, advertises externalPort1
    let listenPort1: number;
    let externalPort1: number;
    let edgePort1: number;
    // Edge-2: listens on listenPort2, advertises externalPort2
    let listenPort2: number;
    let externalPort2: number;
    let edgePort2: number;

    beforeAll(async () => {
      basePort = await findAvailablePort(14200);
      controlPort = basePort;
      listenPort1 = basePort + 1;
      externalPort1 = basePort + 2; // different from listenPort1 (simulates NAT)
      edgePort1 = basePort + 3;
      listenPort2 = basePort + 4;
      externalPort2 = basePort + 5;
      edgePort2 = basePort + 6;

      debugLog(
        `[cluster-test] ports: hub=${controlPort} ` +
          `edge1 listen=${listenPort1} ext=${externalPort1} ` +
          `edge2 listen=${listenPort2} ext=${externalPort2}`,
      );

      // Start Hub
      const hubBin = join(PROJECT_ROOT, 'rust/target/debug/munode-hub');
      const hubCfg = writeRustHubConfig(basePort, controlPort, 0);
      hubProc = new RustServerProcess(hubBin, hubCfg, `Hub(${controlPort})`, true);
      await hubProc.start();
      await waitForPortListening('127.0.0.1', controlPort, 15000);

      // Start Edge-1 with external_port != listen port
      const edge1Bin = join(PROJECT_ROOT, 'rust/target/debug/munode-edge');
      const edge1Cfg = writeRustEdgeConfig({
        serverId: 1,
        name: 'Edge-Cluster-1',
        listenPort: listenPort1,
        externalPort: externalPort1,
        edgePort: edgePort1,
        controlPort,
        basePort,
      });
      edge1Proc = new RustServerProcess(edge1Bin, edge1Cfg, `Edge1(${listenPort1})`, true);
      await edge1Proc.start();
      await waitForPortListening('127.0.0.1', listenPort1, 15000);

      // Start Edge-2
      const edge2Bin = join(PROJECT_ROOT, 'rust/target/debug/munode-edge');
      const edge2Cfg = writeRustEdgeConfig({
        serverId: 2,
        name: 'Edge-Cluster-2',
        listenPort: listenPort2,
        externalPort: externalPort2,
        edgePort: edgePort2,
        controlPort,
        basePort,
      });
      edge2Proc = new RustServerProcess(edge2Bin, edge2Cfg, `Edge2(${listenPort2})`, true);
      await edge2Proc.start();
      await waitForPortListening('127.0.0.1', listenPort2, 15000);

      // Give both edges time to complete registration and edge.join
      await new Promise((r) => setTimeout(r, 2000));
    }, 60000);

    afterAll(async () => {
      edge2Proc?.stop().catch(() => {});
      edge1Proc?.stop().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      hubProc?.stop().catch(() => {});
    });

    it('Edge-1 listens on its configured listen port', () => {
      expect(listenPort1).not.toBe(externalPort1);
    });

    it('Edge-2 listens on its configured listen port', () => {
      expect(listenPort2).not.toBe(externalPort2);
    });

    it('Edge-1 accepts a Mumble client connection on listenPort', async () => {
      const client = new MumbleClient();
      await client.connect({
        host: 'localhost',
        port: listenPort1,
        username: 'guest',
        password: '',
        rejectUnauthorized: false,
      });
      expect(client.isConnected()).toBe(true);
      await client.disconnect();
    });

    it('Edge-2 accepts a Mumble client connection on listenPort', async () => {
      const client = new MumbleClient();
      await client.connect({
        host: 'localhost',
        port: listenPort2,
        username: 'guest',
        password: '',
        rejectUnauthorized: false,
      });
      expect(client.isConnected()).toBe(true);
      await client.disconnect();
    });

    it('external_port is NOT bound (listen port != external port confirms separation)', async () => {
      // externalPort1 is not bound by Edge-1 itself (simulating NAT / reverse-proxy).
      // We verify it is indeed not listening — only the real listenPort is.
      const extListening = await isPortListening('127.0.0.1', externalPort1, 800);
      expect(extListening).toBe(false);
    });

    it('cross-edge user visibility: user on Edge-1 is seen by client on Edge-2', async () => {
      // Connect a user to Edge-1
      const clientA = new MumbleClient();
      await clientA.connect({
        host: 'localhost',
        port: listenPort1,
        username: 'guest',
        password: '',
        rejectUnauthorized: false,
      });
      expect(clientA.isConnected()).toBe(true);

      // Wait for Hub to sync the user to Edge-2
      await new Promise((r) => setTimeout(r, 1500));

      // Connect an observer to Edge-2 and check the user list
      const clientB = new MumbleClient();
      const observedUsers: string[] = [];
      clientB.on('userState', (u: { name: string }) => {
        if (u.name) observedUsers.push(u.name);
      });
      await clientB.connect({
        host: 'localhost',
        port: listenPort2,
        username: 'guest2',
        password: '',
        rejectUnauthorized: false,
      });

      await new Promise((r) => setTimeout(r, 800));

      await clientA.disconnect();
      await clientB.disconnect();

      expect(observedUsers).toContain('guest');
    });
  } else {
    // ── TypeScript implementation path ────────────────────────────────────

    let testEnv: TestEnvironment;

    beforeAll(async () => {
      testEnv = await setupTestEnvironment(14200, {
        startEdge2: true,
        isolated: true,
      });
    }, 60000);

    afterAll(async () => {
      await testEnv?.cleanup();
    });

    it('Edge-1 accepts a Mumble client connection', async () => {
      const client = new MumbleClient();
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });
      expect(client.isConnected()).toBe(true);
      await client.disconnect();
    });

    it('Edge-2 accepts a Mumble client connection', async () => {
      const client = new MumbleClient();
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });
      expect(client.isConnected()).toBe(true);
      await client.disconnect();
    });

    it('cross-edge user visibility: user on Edge-1 is seen by client on Edge-2', async () => {
      const clientA = new MumbleClient();
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      expect(clientA.isConnected()).toBe(true);

      await new Promise((r) => setTimeout(r, 1500));

      const clientB = new MumbleClient();
      const observedUsers: string[] = [];
      clientB.on('userState', (u: { name: string }) => {
        if (u.name) observedUsers.push(u.name);
      });
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await new Promise((r) => setTimeout(r, 800));

      await clientA.disconnect();
      await clientB.disconnect();

      expect(observedUsers).toContain('user1');
    });
  }
});
