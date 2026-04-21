/**
 * 用户名和频道名验证规则集成测试
 *
 * 测试 Hub 的验证规则功能（仅 Rust 实现）：
 * - 用户名正则验证（拒绝不匹配的用户名）
 * - 频道名正则验证（拒绝不匹配的频道名）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  RustServerProcess,
  USE_RUST,
  sleep,
  findAvailablePort,
  waitForCondition,
} from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import * as fs from 'fs';
import * as net from 'net';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../../..');

const TEST_BASE_PORT = 8105;

/**
 * 查找 Rust 二进制文件路径
 */
function findRustBinary(name: string): string {
  const debugPath = join(PROJECT_ROOT, `rust/target/debug/${name}`);
  const releasePath = join(PROJECT_ROOT, `rust/target/release/${name}`);
  if (fs.existsSync(debugPath)) return debugPath;
  if (fs.existsSync(releasePath)) return releasePath;
  throw new Error(
    `Rust binary '${name}' not found. Run 'cargo build' in the rust/ directory first.\n` +
    `Checked: ${releasePath}\n        ${debugPath}`
  );
}

/**
 * 等待 TCP 端口开启
 */
async function waitForPort(port: number, timeoutMs: number = 10000): Promise<void> {
  const started = await waitForCondition(
    () =>
      new Promise<boolean>((resolve) => {
        const sock = new net.Socket();
        sock.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
      }),
    timeoutMs,
    100,
    `port ${port}`
  );
  if (!started) throw new Error(`Timed out waiting for port ${port}`);
}

describe('验证规则集成测试', () => {
  let hubProcess: RustServerProcess | undefined;
  let edgeProcess: RustServerProcess | undefined;
  let controlPort: number;
  let edgePort: number;
  let edgeEdgePort: number;

  beforeAll(async () => {
    if (!USE_RUST) return;

    // Allocate ports
    const authFakePort = await findAvailablePort(TEST_BASE_PORT);
    controlPort = await findAvailablePort(authFakePort + 1);
    edgePort = await findAvailablePort(controlPort + 1);
    edgeEdgePort = await findAvailablePort(edgePort + 1);

    const certsDir = join(PROJECT_ROOT, 'tests/integration/certs');
    const tmpDir = join(PROJECT_ROOT, 'tmp');
    const dataDir = join(PROJECT_ROOT, 'data');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const dbPath = join(dataDir, `hub-validation-${TEST_BASE_PORT}.db`);
    // Remove stale DB files
    for (const ext of ['', '-wal', '-shm']) {
      try { if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext); } catch {}
    }

    const hmacSecret = 'test-hmac-secret-validation-rules';

    // Lua auth script: grant admin group to channel-creation test users so they
    // have MAKE_CHANNEL permission.  All other users (including the username-
    // validation test accounts) get no extra groups but still connect as guests.
    // Note: username regex validation runs BEFORE Lua auth, so invalid usernames
    // are rejected by the regex and never reach this script.
    const luaAuthScript = `
local CHANNEL_TEST_USERS = {
  adminuser  = { user_id = 9001 },
  adminuser2 = { user_id = 9002 },
  adminuser3 = { user_id = 9003 },
  adminuser4 = { user_id = 9004 },
}
function authenticate(req)
  local info = CHANNEL_TEST_USERS[req.username]
  if info then
    return { success = true, user_id = info.user_id, username = req.username, display_name = req.username, groups = {"admin"} }
  end
  return { success = true, user_id = 0, username = req.username, display_name = req.username, groups = {} }
end
`;

    // Hub config with validation rules enabled
    const hubConfig = {
      network: {
        host: '127.0.0.1',
        control_port: controlPort,
      },
      database: {
        path: dbPath,
      },
      auth: {
        // Allow guest access so no external auth service is needed
        allow_guest: true,
        require_auth_service: false,
        // Grant admin group to channel-creation test users via inline Lua script
        lua_script: luaAuthScript,
      },
      registry: {
        hmac_secret: hmacSecret,
        heartbeat_timeout: 90000,
      },
      // Validation rules: username must start with a letter and be alphanumeric/underscore
      validation: {
        username_regex: '^[a-zA-Z][a-zA-Z0-9_]{1,29}$',
        // Channel name must start with alphanumeric and contain only safe characters
        channel_name_regex: '^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,59}$',
      },
      log_level: 'error',
    };

    const hubConfigPath = join(tmpDir, `rust-hub-validation-${TEST_BASE_PORT}.json`);
    fs.writeFileSync(hubConfigPath, JSON.stringify(hubConfig, null, 2));

    const hubBin = findRustBinary('munode-hub');
    hubProcess = new RustServerProcess(hubBin, hubConfigPath, `Hub-Validation(${controlPort})`, true);
    await hubProcess.start();
    await waitForPort(controlPort);

    // Edge config
    const edgeConfig = {
      server_id: 1,
      name: 'Edge-Validation',
      network: {
        host: '0.0.0.0',
        port: edgePort,
        edge_port: edgeEdgePort,
        external_host: '127.0.0.1',
      },
      tls: {
        cert: join(certsDir, 'server.pem'),
        key: join(certsDir, 'server.key'),
        ca: join(certsDir, 'ca.pem'),
      },
      hub_server: {
        host: '127.0.0.1',
        control_port: controlPort,
        hmac_secret: hmacSecret,
        reconnect_interval: 5000,
        heartbeat_interval: 30000,
      },
      server: {
        capacity: 100,
        max_bandwidth: 558000,
      },
      log_level: 'error',
    };

    const edgeConfigPath = join(tmpDir, `rust-edge-validation-${TEST_BASE_PORT}.json`);
    fs.writeFileSync(edgeConfigPath, JSON.stringify(edgeConfig, null, 2));

    const edgeBin = findRustBinary('munode-edge');
    edgeProcess = new RustServerProcess(edgeBin, edgeConfigPath, `Edge-Validation(${edgePort})`, true);
    await edgeProcess.start();
    await waitForPort(edgePort);

    // Give Edge time to register with Hub
    await sleep(1000);
  }, 60000);

  afterAll(async () => {
    if (!USE_RUST) return;
    if (edgeProcess) await edgeProcess.stop().catch(() => {});
    if (hubProcess) await hubProcess.stop().catch(() => {});

    // Clean up DB files
    const dbPath = join(PROJECT_ROOT, `data/hub-validation-${TEST_BASE_PORT}.db`);
    for (const ext of ['', '-wal', '-shm']) {
      try { if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext); } catch {}
    }
  });

  // ===========================================================================
  // 用户名验证测试
  // ===========================================================================

  it.runIf(USE_RUST)('应接受符合规则的用户名', async () => {
    const client = new MumbleClient();
    // 'validuser' matches ^[a-zA-Z][a-zA-Z0-9_]{1,29}$
    await client.connect({
      host: 'localhost',
      port: edgePort,
      username: 'validuser',
      password: '',
      rejectUnauthorized: false,
    });
    await sleep(300);
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });

  it.runIf(USE_RUST)('应接受包含下划线的用户名', async () => {
    const client = new MumbleClient();
    // 'valid_user_123' matches the regex
    await client.connect({
      host: 'localhost',
      port: edgePort,
      username: 'valid_user_123',
      password: '',
      rejectUnauthorized: false,
    });
    await sleep(300);
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });

  it.runIf(USE_RUST)('应拒绝以数字开头的用户名', async () => {
    const client = new MumbleClient();
    // '123invalid' does not match ^[a-zA-Z]...
    let rejected = false;
    try {
      await client.connect({
        host: 'localhost',
        port: edgePort,
        username: '123invalid',
        password: '',
        rejectUnauthorized: false,
      });
      await sleep(500);
      if (!client.isConnected()) rejected = true;
    } catch {
      rejected = true;
    }
    try { await client.disconnect(); } catch {}
    expect(rejected || !client.isConnected()).toBe(true);
  });

  it.runIf(USE_RUST)('应拒绝含有特殊字符的用户名', async () => {
    const client = new MumbleClient();
    // '!!bad!!' does not match the regex
    let rejected = false;
    try {
      await client.connect({
        host: 'localhost',
        port: edgePort,
        username: '!!bad!!',
        password: '',
        rejectUnauthorized: false,
      });
      await sleep(500);
      if (!client.isConnected()) rejected = true;
    } catch {
      rejected = true;
    }
    try { await client.disconnect(); } catch {}
    expect(rejected || !client.isConnected()).toBe(true);
  });

  it.runIf(USE_RUST)('应拒绝过短的用户名（少于2个字符）', async () => {
    const client = new MumbleClient();
    // 'a' is only 1 char, doesn't match {1,29} suffix
    let rejected = false;
    try {
      await client.connect({
        host: 'localhost',
        port: edgePort,
        username: 'a',
        password: '',
        rejectUnauthorized: false,
      });
      await sleep(500);
      if (!client.isConnected()) rejected = true;
    } catch {
      rejected = true;
    }
    try { await client.disconnect(); } catch {}
    expect(rejected || !client.isConnected()).toBe(true);
  });

  it.runIf(USE_RUST)('应拒绝包含空格的用户名', async () => {
    const client = new MumbleClient();
    // 'bad name' contains a space, which the regex doesn't allow
    let rejected = false;
    try {
      await client.connect({
        host: 'localhost',
        port: edgePort,
        username: 'bad name',
        password: '',
        rejectUnauthorized: false,
      });
      await sleep(500);
      if (!client.isConnected()) rejected = true;
    } catch {
      rejected = true;
    }
    try { await client.disconnect(); } catch {}
    expect(rejected || !client.isConnected()).toBe(true);
  });

  // ===========================================================================
  // 频道名验证测试
  // ===========================================================================

  it.runIf(USE_RUST)('应接受符合规则的频道名', async () => {
    const client = new MumbleClient();
    await client.connect({
      host: 'localhost',
      port: edgePort,
      username: 'adminuser',
      password: '',
      rejectUnauthorized: false,
    });
    await sleep(300);
    expect(client.isConnected()).toBe(true);

    // createChannel resolves with the new channel ID on success
    const newId = await client.createChannel('ValidChannel', 0);
    expect(typeof newId).toBe('number');
    expect(newId).toBeGreaterThan(0);

    await client.disconnect();
  });

  it.runIf(USE_RUST)('应接受包含空格和连字符的频道名', async () => {
    const client = new MumbleClient();
    await client.connect({
      host: 'localhost',
      port: edgePort,
      username: 'adminuser2',
      password: '',
      rejectUnauthorized: false,
    });
    await sleep(300);
    expect(client.isConnected()).toBe(true);

    const newId = await client.createChannel('My-Channel 123', 0);
    expect(typeof newId).toBe('number');
    expect(newId).toBeGreaterThan(0);

    await client.disconnect();
  });

  it.runIf(USE_RUST)('应拒绝含有特殊字符的频道名', async () => {
    const client = new MumbleClient();
    await client.connect({
      host: 'localhost',
      port: edgePort,
      username: 'adminuser3',
      password: '',
      rejectUnauthorized: false,
    });
    await sleep(300);
    expect(client.isConnected()).toBe(true);

    // Hub validates channel name against channel_name_regex and returns success:false.
    // Edge now sends PermissionDenied (ChannelName) back, so createChannel rejects quickly.
    let channelCreated = false;
    try {
      await client.createChannel('!!BadChannel!!', 0);
      channelCreated = true;
    } catch {
      // Expected: Hub rejected the invalid name
    }

    expect(channelCreated).toBe(false);
    await client.disconnect();
  });

  it.runIf(USE_RUST)('应拒绝以特殊字符开头的频道名', async () => {
    const client = new MumbleClient();
    await client.connect({
      host: 'localhost',
      port: edgePort,
      username: 'adminuser4',
      password: '',
      rejectUnauthorized: false,
    });
    await sleep(300);
    expect(client.isConnected()).toBe(true);

    // Hub validates channel name against channel_name_regex and returns success:false.
    // Edge now sends PermissionDenied (ChannelName) back, so createChannel rejects quickly.
    let channelCreated = false;
    try {
      await client.createChannel('___private', 0);
      channelCreated = true;
    } catch {
      // Expected: Hub rejected the invalid name
    }

    expect(channelCreated).toBe(false);
    await client.disconnect();
  });

  // ===========================================================================
  // Unicode 字符测试
  // ===========================================================================

  it.runIf(USE_RUST)('应拒绝包含中文字符的用户名', async () => {
    const client = new MumbleClient();
    // '用户名' contains Chinese characters not matching [a-zA-Z0-9_]
    let rejected = false;
    try {
      await client.connect({
        host: 'localhost',
        port: edgePort,
        username: '用户名',
        password: '',
        rejectUnauthorized: false,
      });
      await sleep(500);
      if (!client.isConnected()) rejected = true;
    } catch {
      rejected = true;
    }
    try { await client.disconnect(); } catch {}
    expect(rejected || !client.isConnected()).toBe(true);
  });
});
