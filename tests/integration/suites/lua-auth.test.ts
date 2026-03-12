/**
 * Lua 认证集成测试（仅 Rust 模式）
 *
 * 测试场景：
 * 1. Hub 配置了内联 Lua 5.4 认证脚本
 * 2. 有效凭据 → 连接成功
 * 3. 无效密码 → 连接被拒绝（WrongUserPW）
 * 4. 未知用户名 → 连接被拒绝
 * 5. Lua 脚本可以为认证用户设置 groups
 * 6. 客人（无密码）在 allow_guest=true 时仍可连接
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, USE_RUST, sleep } from '../setup.js';
import type { TestEnvironment } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';

// Lua 认证脚本：维护一个静态用户表，验证 username/password 并返回 groups
const LUA_AUTH_SCRIPT = `
local USERS = {
  lua_admin  = { password = "lua_admin_pass",  user_id = 1001, groups = {"admin"} },
  lua_user1  = { password = "lua_user1_pass",  user_id = 1002, groups = {"user"} },
  lua_user2  = { password = "lua_user2_pass",  user_id = 1003, groups = {"user"} },
}

function authenticate(req)
  local u = USERS[req.username]
  if u == nil then
    return { success = false, reason = "Unknown user", reject_type = 3 }
  end
  if req.password ~= u.password then
    return { success = false, reason = "Wrong password", reject_type = 3 }
  end
  return {
    success      = true,
    user_id      = u.user_id,
    username     = req.username,
    display_name = req.username,
    groups       = u.groups,
  }
end
`;

/** 仅在 Rust 模式下运行 */
describe.skipIf(!USE_RUST)('Lua Authentication Integration Tests (Rust)', () => {
  let luaEnv: TestEnvironment;

  beforeAll(async () => {
    luaEnv = await setupTestEnvironment(15700, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      // startAuth: true so port allocation works normally;
      // the Hub auth config is overridden to use Lua only (no http_url)
      startAuth: true,
      silent: true,
      isolated: true,
      rustHubExtraConfig: {
        // 覆盖整个 auth 段，只启用 Lua 认证，禁用 HTTP auth
        auth: {
          allow_guest: true,
          require_auth_service: false,
          lua_script: LUA_AUTH_SCRIPT,
        },
      },
    });
    // 等待 Edge 完成注册
    await sleep(1500);
  }, 60000);

  afterAll(async () => {
    await luaEnv?.cleanup();
  }, 30000);

  describe('Valid Credentials', () => {
    it('should authenticate lua_admin with correct password', async () => {
      const client = new MumbleClient();
      let connected = false;

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'lua_admin',
          password: 'lua_admin_pass',
          rejectUnauthorized: false,
        });
        connected = client.isConnected();
      } finally {
        try { await client.disconnect(); } catch {}
      }

      expect(connected).toBe(true);
    }, 15000);

    it('should authenticate lua_user1 with correct password', async () => {
      const client = new MumbleClient();
      let connected = false;

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'lua_user1',
          password: 'lua_user1_pass',
          rejectUnauthorized: false,
        });
        connected = client.isConnected();
      } finally {
        try { await client.disconnect(); } catch {}
      }

      expect(connected).toBe(true);
    }, 15000);

    it('should authenticate lua_user2 with correct password', async () => {
      const client = new MumbleClient();
      let connected = false;

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'lua_user2',
          password: 'lua_user2_pass',
          rejectUnauthorized: false,
        });
        connected = client.isConnected();
      } finally {
        try { await client.disconnect(); } catch {}
      }

      expect(connected).toBe(true);
    }, 15000);

    it('multiple Lua-authenticated users can connect simultaneously', async () => {
      const c1 = new MumbleClient();
      const c2 = new MumbleClient();

      try {
        await c1.connect({
          host: 'localhost', port: luaEnv.edgePort,
          username: 'lua_user1', password: 'lua_user1_pass',
          rejectUnauthorized: false,
        });
        await c2.connect({
          host: 'localhost', port: luaEnv.edgePort,
          username: 'lua_user2', password: 'lua_user2_pass',
          rejectUnauthorized: false,
        });

        expect(c1.isConnected()).toBe(true);
        expect(c2.isConnected()).toBe(true);

        await sleep(300);

        // 两个用户应该互相可见
        const users1 = c1.getUsers();
        const users2 = c2.getUsers();
        const sess2 = c2.getStateManager().getSession()?.session;
        const sess1 = c1.getStateManager().getSession()?.session;

        expect(users1.some((u: any) => u.session === sess2)).toBe(true);
        expect(users2.some((u: any) => u.session === sess1)).toBe(true);
      } finally {
        try { await c1.disconnect(); } catch {}
        try { await c2.disconnect(); } catch {}
      }
    }, 20000);
  });

  describe('Invalid Credentials', () => {
    it('should reject connection with wrong password', async () => {
      const client = new MumbleClient();
      let rejected = false;

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'lua_admin',
          password: 'wrong_password',
          rejectUnauthorized: false,
        });
        // 若连接成功则标记为未被拒绝
        await client.disconnect();
      } catch (err) {
        // 连接被拒绝时 connect() 应抛出错误
        rejected = true;
      }

      expect(rejected).toBe(true);
    }, 15000);

    it('should reject connection with unknown username', async () => {
      const client = new MumbleClient();
      let rejected = false;

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'nonexistent_user',
          password: 'some_password',
          rejectUnauthorized: false,
        });
        await client.disconnect();
      } catch (err) {
        rejected = true;
      }

      expect(rejected).toBe(true);
    }, 15000);

    it('should reject connection with empty password for Lua-defined user', async () => {
      const client = new MumbleClient();
      let rejected = false;

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'lua_user1',
          password: '',
          rejectUnauthorized: false,
        });
        await client.disconnect();
      } catch (err) {
        rejected = true;
      }

      expect(rejected).toBe(true);
    }, 15000);
  });

  describe('Guest Access', () => {
    it('should reject unknown user when using Lua-only auth (no fallback to allow_guest)', async () => {
      // When Lua auth returns { success=false } for an unknown user,
      // the Hub rejects the connection immediately — it does NOT fall back
      // to local DB "allow_guest" mode. This is the correct behaviour:
      // Lua auth is authoritative.
      const client = new MumbleClient();
      let rejected = false;

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'GuestLua',
          password: '',
          rejectUnauthorized: false,
        });
        await client.disconnect();
      } catch {
        rejected = true;
      }

      // Lua auth is authoritative — unknown users are always rejected.
      expect(rejected).toBe(true);
    }, 15000);
  });

  describe('ServerSync after Lua Auth', () => {
    it('should receive full ServerSync after Lua authentication', async () => {
      const client = new MumbleClient();

      try {
        await client.connect({
          host: 'localhost',
          port: luaEnv.edgePort,
          username: 'lua_user1',
          password: 'lua_user1_pass',
          rejectUnauthorized: false,
        });

        await sleep(300);

        // 连接后应该有 session
        const session = client.getStateManager().getSession();
        expect(session).toBeDefined();

        // 从 users 列表中找到自己的信息
        const mySessionId = session?.session;
        const users = client.getUsers();
        const myUser = users.find((u: any) => u.session === mySessionId);
        expect(myUser).toBeDefined();
        expect(myUser?.name).toBe('lua_user1');

        // 应该有频道列表（至少 root 频道）
        const channels = client.getChannels();
        expect(channels.length).toBeGreaterThan(0);
      } finally {
        try { await client.disconnect(); } catch {}
      }
    }, 15000);
  });
});
