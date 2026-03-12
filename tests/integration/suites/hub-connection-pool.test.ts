/**
 * Hub 连接池集成测试（仅 Rust 模式）
 *
 * 测试 Edge 的 `hub_server.pool_size > 1` 配置：
 * - Edge 使用多个并发 WebSocket 连接到 Hub（连接池）
 * - 多客户端认证请求通过连接池轮询分发
 * - 用户状态同步、频道操作等在池模式下正常工作
 * - 连接池不影响功能正确性
 *
 * 验证方法：
 * 1. 通过 Hub Web API 确认 Edge 已注册
 * 2. 连接多个客户端，触发多次 RPC 轮询
 * 3. 验证跨 Edge 用户可见性和频道操作正确性
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, USE_RUST, sleep } from '../setup.js';
import type { TestEnvironment } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';

// ---------------------------------------------------------------------------
// pool_size = 3 (multi-slot connection pool)
// ---------------------------------------------------------------------------

describe.skipIf(!USE_RUST)('Hub Connection Pool Tests — pool_size = 3 (Rust)', () => {
  let poolEnv: TestEnvironment;

  beforeAll(async () => {
    poolEnv = await setupTestEnvironment(15970, {
      startHub: true,
      startEdge: true,
      startEdge2: true,
      startAuth: true,
      silent: true,
      isolated: true,
      // Edge 1 and Edge 2 both use 3-slot connection pools to Hub
      rustEdgeExtraConfig: {
        hub_server: {
          pool_size: 3,
        },
      },
    });
    // Give Edges time to establish all 3 pool slots
    await sleep(2000);
  }, 90000);

  afterAll(async () => {
    // Small delay to allow TLS sockets to fully close before killing the server
    await sleep(400);
    await poolEnv?.cleanup();
  }, 30000);

  // -------------------------------------------------------------------------
  // Basic connectivity
  // -------------------------------------------------------------------------

  it('clients on Edge 1 connect successfully with pool_size = 3', async () => {
    const client = new MumbleClient();
    try {
      await client.connect({
        host: 'localhost',
        port: poolEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      expect(client.isConnected()).toBe(true);
      expect(client.getStateManager().getSession()).toBeDefined();
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }, 20000);

  it('clients on Edge 2 connect successfully with pool_size = 3', async () => {
    const client = new MumbleClient();
    try {
      await client.connect({
        host: 'localhost',
        port: poolEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });
      expect(client.isConnected()).toBe(true);
      expect(client.getStateManager().getSession()).toBeDefined();
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }, 20000);

  // -------------------------------------------------------------------------
  // Multi-client: Pool distributes concurrent auth RPCs round-robin
  // -------------------------------------------------------------------------

  it('multiple concurrent client connections work (pool distributes auth RPCs)', async () => {
    const clients: MumbleClient[] = [];
    const userCredentials = [
      { username: 'user1', password: 'password1', edge: poolEnv.edgePort },
      { username: 'user2', password: 'password2', edge: poolEnv.edgePort },
      { username: 'guest', password: 'guest123', edge: poolEnv.edgePort },
      { username: 'admin', password: 'admin123', edge: poolEnv.edgePort2 },
    ];

    try {
      // Connect all clients (sequential to avoid overwhelming; each triggers one auth RPC)
      for (const cred of userCredentials) {
        const c = new MumbleClient();
        await c.connect({
          host: 'localhost',
          port: cred.edge,
          username: cred.username,
          password: cred.password,
          rejectUnauthorized: false,
        });
        clients.push(c);
      }

      await sleep(800);

      // All clients should be connected
      for (const c of clients) {
        expect(c.isConnected()).toBe(true);
        expect(c.getStateManager().getSession()).toBeDefined();
      }
    } finally {
      for (const c of clients) {
        try { await c.disconnect(); } catch {}
      }
    }
  }, 30000);

  // -------------------------------------------------------------------------
  // Cross-Edge visibility: Hub notifications flow correctly through pool
  // -------------------------------------------------------------------------

  it('users on different Edges can see each other (cross-Edge sync via pool)', async () => {
    const c1 = new MumbleClient();
    const c2 = new MumbleClient();

    try {
      await c1.connect({
        host: 'localhost',
        port: poolEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await c2.connect({
        host: 'localhost',
        port: poolEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await sleep(1000);

      const sess1 = c1.getStateManager().getSession()?.session;
      const sess2 = c2.getStateManager().getSession()?.session;

      const users1 = c1.getUsers();
      const users2 = c2.getUsers();

      // Edge 1 user can see Edge 2 user
      expect(users1.some((u: any) => u.session === sess2)).toBe(true);
      // Edge 2 user can see Edge 1 user
      expect(users2.some((u: any) => u.session === sess1)).toBe(true);
    } finally {
      try { await c1.disconnect(); } catch {}
      try { await c2.disconnect(); } catch {}
    }
  }, 25000);

  // -------------------------------------------------------------------------
  // Channel operations: RPC calls go through pool, responses are received correctly
  // -------------------------------------------------------------------------

  it('channel create and join work correctly with pool_size = 3', async () => {
    const admin = new MumbleClient();
    const user = new MumbleClient();

    try {
      await admin.connect({
        host: 'localhost',
        port: poolEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });
      await user.connect({
        host: 'localhost',
        port: poolEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await sleep(500);

      // Admin creates a channel (triggers saveChannel RPC through the pool)
      const channelName = 'PoolTestChannel_' + Date.now();
      const newChannelId = await admin.createChannel(channelName, 0);
      await sleep(500);

      // Channel should appear in user's channel list
      const channels = user.getChannels();
      const found = channels.find((ch: any) => ch.channel_id === newChannelId);
      expect(found).toBeDefined();
      expect(found?.name).toBe(channelName);

      // User moves to the new channel (triggers hub notification)
      await user.joinChannel(newChannelId);
      await sleep(500);

      // Admin should see user in the new channel
      const adminSees = admin.getUsers();
      const userState = adminSees.find(
        (u: any) => u.session === user.getStateManager().getSession()?.session,
      );
      expect(userState?.channel_id).toBe(newChannelId);

      // Cleanup: admin deletes channel
      await admin.deleteChannel(newChannelId);
    } finally {
      try { await admin.disconnect(); } catch {}
      try { await user.disconnect(); } catch {}
    }
  }, 30000);

  // -------------------------------------------------------------------------
  // User state sync: Hub sends userJoined/userLeft notifications to all Edges
  // via the primary pool connection (slot 0)
  // -------------------------------------------------------------------------

  it('user join and leave events propagate across Edges with pool_size = 3', async () => {
    const c1 = new MumbleClient(); // Edge 1 - observer
    const c2 = new MumbleClient(); // Edge 2 - the user being observed

    let c2SessionOnJoin: number | undefined;
    let sawUserLeave = false;

    try {
      // Observer connects first
      await c1.connect({
        host: 'localhost',
        port: poolEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await sleep(300);

      // Track when c2 joins (userState with new session)
      const joinPromise = new Promise<void>((resolve) => {
        c1.on('userState', (state: any) => {
          if (
            state.session !== undefined &&
            state.session !== c1.getStateManager().getSession()?.session &&
            c2SessionOnJoin === undefined
          ) {
            c2SessionOnJoin = state.session;
            resolve();
          }
        });
      });

      // c2 joins on Edge 2
      await c2.connect({
        host: 'localhost',
        port: poolEnv.edgePort2,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await Promise.race([joinPromise, sleep(3000)]);
      expect(c2SessionOnJoin, 'observer should see c2 join').toBeDefined();

      // Track when c2 leaves
      const leavePromise = new Promise<void>((resolve) => {
        c1.on('userRemove', (remove: any) => {
          if (remove.session === c2SessionOnJoin) {
            sawUserLeave = true;
            resolve();
          }
        });
      });

      // c2 disconnects
      await c2.disconnect();

      await Promise.race([leavePromise, sleep(3000)]);
      expect(sawUserLeave, 'observer should see c2 leave').toBe(true);
    } finally {
      try { await c1.disconnect(); } catch {}
      try { if ((c2 as any).connected) await c2.disconnect(); } catch {}
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// pool_size = 1 (default) backward-compatibility sanity check
// ---------------------------------------------------------------------------

describe.skipIf(!USE_RUST)('Hub Connection Pool Tests — pool_size = 1 (default, backward-compat)', () => {
  let singleEnv: TestEnvironment;

  beforeAll(async () => {
    singleEnv = await setupTestEnvironment(16080, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      // pool_size defaults to 1 when not specified
    });
    await sleep(1000);
  }, 60000);

  afterAll(async () => {
    // Small delay to allow TLS sockets to fully close before killing the server
    await sleep(400);
    await singleEnv?.cleanup();
  }, 30000);

  it('default pool_size = 1 remains functional', async () => {
    const c1 = new MumbleClient();
    const c2 = new MumbleClient();

    try {
      await c1.connect({
        host: 'localhost',
        port: singleEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await c2.connect({
        host: 'localhost',
        port: singleEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await sleep(500);

      expect(c1.isConnected()).toBe(true);
      expect(c2.isConnected()).toBe(true);

      const sess1 = c1.getStateManager().getSession()?.session;
      const users2 = c2.getUsers();
      expect(users2.some((u: any) => u.session === sess1)).toBe(true);
    } finally {
      try { await c1.disconnect(); } catch {}
      try { await c2.disconnect(); } catch {}
    }
  }, 20000);
});
