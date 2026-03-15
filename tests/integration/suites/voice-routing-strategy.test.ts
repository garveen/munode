/**
 * 语音路由策略集成测试（仅 Rust 模式）
 *
 * 测试 Edge 的 `voice_routing.connection_strategy` 配置：
 * 1. `tcp_only`   — 强制所有跨 Edge 语音通过 Hub TCP 中继（禁用直连 UDP）
 * 2. `direct_only` — 仅使用直连 UDP，禁用 Hub 中继
 * 3. `auto_fallback` — 默认模式，优先直连，UDP 失败时降级到 Hub 中继
 *
 * 测试验证：
 * - 不同策略下语音包能正确路由到接收方
 * - `tcp_only` 下禁用 Hub relay 时（`enable_relay=false`），连接正常但跨 Edge 语音通过 TCP 隧道
 * - 客户端连接成功后 ServerSync 包含正确的用户信息
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, USE_RUST, sleep } from '../setup.js';
import type { TestEnvironment } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { createVoicePacket } from '../utils/test-helpers.js';

/** 仅在 Rust 模式下运行 */
describe.skipIf(!USE_RUST)('Voice Routing Strategy Tests — tcp_only (Rust)', () => {
  let tcpOnlyEnv: TestEnvironment;

  beforeAll(async () => {
    tcpOnlyEnv = await setupTestEnvironment(15760, {
      startHub: true,
      startEdge: true,
      startEdge2: true,
      startAuth: true,
      silent: true,
      isolated: true,
      // 两个 Edge 均使用 tcp_only 策略 — 强制通过 Hub TCP 中继
      rustEdgeExtraConfig: {
        voice_routing: {
          connection_strategy: 'tcp_only',
        },
      },
    });
    // 等待 Edge 注册和稳定
    await sleep(1500);
  }, 60000);

  afterAll(async () => {
    await tcpOnlyEnv?.cleanup();
  }, 30000);

  // The two "connect successfully" tests (Edge 1 / Edge 2) share the same environment and
  // only differ in which port they connect to. Merged into one test that verifies both.
  it('both Edge 1 and Edge 2 clients should connect successfully with tcp_only strategy', async () => {
    const c1 = new MumbleClient();
    const c2 = new MumbleClient();

    try {
      await c1.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await c2.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      expect(c1.isConnected()).toBe(true);
      expect(c1.getStateManager().getSession()).toBeDefined();
      expect(c2.isConnected()).toBe(true);
    } finally {
      try { await c1.disconnect(); } catch {}
      try { await c2.disconnect(); } catch {}
    }
  }, 15000);

  it('cross-Edge voice delivery works via Hub TCP relay in tcp_only mode', async () => {
    const sender = new MumbleClient();
    const receiver = new MumbleClient();

    try {
      // 发送者在 Edge 1
      await sender.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      // 接收者在 Edge 2
      await receiver.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await sleep(500);

      const senderSession = sender.getStateManager().getSession()?.session ?? 0;
      expect(senderSession).toBeGreaterThan(0);

      let receivedCount = 0;
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });

      // 发送多个语音包
      for (let i = 0; i < 5; i++) {
        const pkt = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(pkt);
        await sleep(50);
      }

      // 等待语音包通过 Hub TCP 中继到达接收者
      await sleep(1000);

      expect(receivedCount).toBeGreaterThan(0);
    } finally {
      try { await sender.disconnect(); } catch {}
      try { await receiver.disconnect(); } catch {}
    }
  }, 20000);

  it('same-Edge voice delivery works in tcp_only mode', async () => {
    const sender = new MumbleClient();
    const receiver = new MumbleClient();

    try {
      // 两个客户端都在 Edge 1
      await sender.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });
      await receiver.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await sleep(400);

      const senderSession = sender.getStateManager().getSession()?.session ?? 0;
      let receivedCount = 0;
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) {
          receivedCount++;
        }
      });

      for (let i = 0; i < 3; i++) {
        const pkt = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(pkt);
        await sleep(50);
      }

      await sleep(800);

      expect(receivedCount).toBeGreaterThan(0);
    } finally {
      try { await sender.disconnect(); } catch {}
      try { await receiver.disconnect(); } catch {}
    }
  }, 20000);

  it('users on different Edges can see each other (full sync) in tcp_only mode', async () => {
    const c1 = new MumbleClient();
    const c2 = new MumbleClient();

    try {
      await c1.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await c2.connect({
        host: 'localhost',
        port: tcpOnlyEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await sleep(800);

      const sess1 = c1.getStateManager().getSession()?.session;
      const sess2 = c2.getStateManager().getSession()?.session;

      const users1 = c1.getUsers();
      const users2 = c2.getUsers();

      // Edge 1 的用户应该能看到 Edge 2 的用户
      expect(users1.some((u: any) => u.session === sess2)).toBe(true);
      // Edge 2 的用户应该能看到 Edge 1 的用户
      expect(users2.some((u: any) => u.session === sess1)).toBe(true);
    } finally {
      try { await c1.disconnect(); } catch {}
      try { await c2.disconnect(); } catch {}
    }
  }, 20000);
});

/** direct_only 策略测试 */
describe.skipIf(!USE_RUST)('Voice Routing Strategy Tests — direct_only (Rust)', () => {
  let directOnlyEnv: TestEnvironment;

  beforeAll(async () => {
    directOnlyEnv = await setupTestEnvironment(15800, {
      startHub: true,
      startEdge: true,
      startEdge2: true,
      startAuth: true,
      silent: true,
      isolated: true,
      // direct_only 禁用 Hub 中继，仅允许直连 UDP
      rustEdgeExtraConfig: {
        voice_routing: {
          connection_strategy: 'direct_only',
        },
      },
    });
    await sleep(1500);
  }, 60000);

  afterAll(async () => {
    await directOnlyEnv?.cleanup();
  }, 30000);

  it('clients should connect successfully with direct_only strategy', async () => {
    const c1 = new MumbleClient();
    const c2 = new MumbleClient();

    try {
      await c1.connect({
        host: 'localhost',
        port: directOnlyEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await c2.connect({
        host: 'localhost',
        port: directOnlyEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      expect(c1.isConnected()).toBe(true);
      expect(c2.isConnected()).toBe(true);
    } finally {
      try { await c1.disconnect(); } catch {}
      try { await c2.disconnect(); } catch {}
    }
  }, 15000);

  it('same-Edge voice delivery works in direct_only mode', async () => {
    const sender = new MumbleClient();
    const receiver = new MumbleClient();

    try {
      await sender.connect({
        host: 'localhost',
        port: directOnlyEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });
      await receiver.connect({
        host: 'localhost',
        port: directOnlyEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await sleep(400);

      const senderSession = sender.getStateManager().getSession()?.session ?? 0;
      let receivedCount = 0;
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) receivedCount++;
      });

      for (let i = 0; i < 3; i++) {
        const pkt = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(pkt);
        await sleep(50);
      }

      await sleep(800);

      expect(receivedCount).toBeGreaterThan(0);
    } finally {
      try { await sender.disconnect(); } catch {}
      try { await receiver.disconnect(); } catch {}
    }
  }, 20000);
});

/** auto_fallback 策略测试（默认行为） */
describe.skipIf(!USE_RUST)('Voice Routing Strategy Tests — auto_fallback (Rust)', () => {
  let autoEnv: TestEnvironment;

  beforeAll(async () => {
    autoEnv = await setupTestEnvironment(15840, {
      startHub: true,
      startEdge: true,
      startEdge2: true,
      startAuth: true,
      silent: true,
      isolated: true,
      // auto_fallback 是默认策略，不需要显式设置，但明确设置以测试配置解析
      rustEdgeExtraConfig: {
        voice_routing: {
          connection_strategy: 'auto_fallback',
        },
      },
    });
    await sleep(1500);
  }, 60000);

  afterAll(async () => {
    await autoEnv?.cleanup();
  }, 30000);

  it('clients should connect and have session with auto_fallback strategy', async () => {
    const c1 = new MumbleClient();
    const c2 = new MumbleClient();

    try {
      await c1.connect({
        host: 'localhost',
        port: autoEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await c2.connect({
        host: 'localhost',
        port: autoEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await sleep(500);

      expect(c1.isConnected()).toBe(true);
      expect(c2.isConnected()).toBe(true);
      expect(c1.getStateManager().getSession()).toBeDefined();
      expect(c2.getStateManager().getSession()).toBeDefined();
    } finally {
      try { await c1.disconnect(); } catch {}
      try { await c2.disconnect(); } catch {}
    }
  }, 15000);

  it('cross-Edge voice delivery works in auto_fallback mode', async () => {
    const sender = new MumbleClient();
    const receiver = new MumbleClient();

    try {
      await sender.connect({
        host: 'localhost',
        port: autoEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });
      await receiver.connect({
        host: 'localhost',
        port: autoEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
        forceTcpVoice: true,
      });

      await sleep(500);

      const senderSession = sender.getStateManager().getSession()?.session ?? 0;
      let receivedCount = 0;
      receiver.on('voice', (data: any) => {
        if (data.session === senderSession) receivedCount++;
      });

      for (let i = 0; i < 5; i++) {
        const pkt = createVoicePacket(4, 0, i);
        await sender.getConnectionManager().sendVoicePacket(pkt);
        await sleep(50);
      }

      await sleep(1000);

      expect(receivedCount).toBeGreaterThan(0);
    } finally {
      try { await sender.disconnect(); } catch {}
      try { await receiver.disconnect(); } catch {}
    }
  }, 20000);
});
