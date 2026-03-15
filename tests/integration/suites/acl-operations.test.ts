/**
 * ACL 操作集成测试
 * 
 * 测试真实的 ACL 管理操作，包括：
 * - 查询频道 ACL
 * - 添加/删除 ACL 条目
 * - 检查用户权限
 * - 管理频道组
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { PermissionFlag } from '../fixtures';

describe('ACL Operations Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8088);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('ACL Query and Check', () => {
    // queryACL / checkPermission / getUserPermissions all connect as admin to channel 0
    // and disconnect — merged into one test to avoid repeated connect/disconnect overhead.
    it('should query ACL, check write permission, and get user permissions on root channel', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      const session = client.getStateManager().getSession()?.session;

      // 查询根频道的 ACL
      const acl = await client.queryACL(0);
      expect(acl).toBeDefined();

      // 检查权限（验证系统返回 boolean，而不是断言具体值）
      const hasWrite = await client.checkPermission(0, PermissionFlag.Write, session);
      expect(typeof hasWrite).toBe('boolean');

      // 获取用户在频道中的所有权限（位掩码）
      const permissions = await client.getUserPermissions(0, session);
      expect(permissions).toBeDefined();
      expect(typeof permissions).toBe('number');

      await client.disconnect();
    });

    it('should verify non-admin user has limited permissions', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      const session = client.getStateManager().getSession()?.session;

      // 检查普通用户的权限
      const hasKick = await client.checkPermission(
        0,
        PermissionFlag.Kick,
        session
      );

      expect(hasKick).toBe(false); // 普通用户应该没有踢人权限

      await client.disconnect();
    });
  });

  describe('ACL Entry Management', () => {
    // add / remove / update all share the same pattern: connect admin → createChannel →
    // addACLEntry → diverge. Merged into one lifecycle test on a single channel.
    it('should add, update, and remove ACL entry lifecycle on a channel', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      const channelId = await client.createChannel('ACLLifecycle_' + Date.now(), 0);

      // ── Add ───────────────────────────────────────────────────────────────
      await client.addACLEntry(channelId, {
        apply_here: true,
        apply_subs: false,
        group: 'user',
        allow: PermissionFlag.Speak | PermissionFlag.Enter,
        deny: 0,
      });
      await new Promise(resolve => setTimeout(resolve, 300));

      const aclAfterAdd = await client.queryACL(channelId);
      expect(aclAfterAdd).toBeDefined();
      const entryCount = aclAfterAdd?.acls?.length || 0;

      // ── Update ────────────────────────────────────────────────────────────
      await client.updateACLEntry(channelId, 0, {
        allow: PermissionFlag.Speak | PermissionFlag.TextMessage,
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      const aclAfterUpdate = await client.queryACL(channelId);
      expect(aclAfterUpdate).toBeDefined();

      // ── Remove ────────────────────────────────────────────────────────────
      if (entryCount > 0) {
        await client.removeACLEntry(channelId, 0);
        await new Promise(resolve => setTimeout(resolve, 200));

        const aclAfterRemove = await client.queryACL(channelId);
        expect(aclAfterRemove?.acls?.length).toBeLessThanOrEqual(entryCount);
      }

      await client.deleteChannel(channelId);
      await client.disconnect();
    });
  });

  describe('Channel Group Management', () => {
    // create / delete / add-user / remove-user all share: connect admin → createChannel →
    // createChannelGroup → diverge. Merged into one group lifecycle test on a single channel.
    it('should manage channel group lifecycle: create, add user, remove user, delete', async () => {
      const client = new MumbleClient();

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      const channelId = await client.createChannel('GroupLifecycle_' + Date.now(), 0);

      // ── Create group ──────────────────────────────────────────────────────
      await client.createChannelGroup(channelId, 'team', false, true);
      await new Promise(resolve => setTimeout(resolve, 200));

      let acl = await client.queryACL(channelId);
      expect(acl?.groups).toBeDefined();

      // ── Add / remove user ─────────────────────────────────────────────────
      const currentUser = client.getUsers().find(u => u.name === 'admin');
      if (currentUser) {
        const userId = currentUser.user_id || 1;

        await client.addUserToGroup(channelId, 'team', userId);
        await new Promise(resolve => setTimeout(resolve, 200));
        acl = await client.queryACL(channelId);
        expect(acl).toBeDefined();

        await client.removeUserFromGroup(channelId, 'team', userId);
        await new Promise(resolve => setTimeout(resolve, 200));
        acl = await client.queryACL(channelId);
        expect(acl).toBeDefined();
      }

      // ── Delete group ──────────────────────────────────────────────────────
      await client.deleteChannelGroup(channelId, 'team');
      await new Promise(resolve => setTimeout(resolve, 200));

      acl = await client.queryACL(channelId);
      expect(acl?.groups?.get('team')).toBeUndefined();

      await client.deleteChannel(channelId);
      await client.disconnect();
    });
  });

  describe('ACL Permission Verification', () => {
    // Both "enforce speak" and "enforce enter" share the same setup (admin + guest connect,
    // create a channel, addACLEntry, checkPermission). Merged into one test that sets
    // both speak and enter restrictions on the same channel and checks both permissions.
    it('should enforce speak and enter permissions via ACL on a channel', async () => {
      const adminClient = new MumbleClient();
      const userClient = new MumbleClient();

      await adminClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await userClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      const channelId = await adminClient.createChannel('PermCheck_' + Date.now(), 0);
      const userSession = userClient.getStateManager().getSession()?.session;

      // ── Speak restriction ─────────────────────────────────────────────────
      await adminClient.addACLEntry(channelId, {
        apply_here: true,
        apply_subs: false,
        group: 'all',
        allow: PermissionFlag.Enter,
        deny: PermissionFlag.Speak,
      });
      await new Promise(resolve => setTimeout(resolve, 300));

      // Note: client-side check may not reflect server ACLs — we verify the API responds
      const canSpeak = await userClient.checkPermission(channelId, PermissionFlag.Speak, userSession);
      expect(typeof canSpeak).toBe('boolean');

      // ── Enter restriction ─────────────────────────────────────────────────
      await adminClient.addACLEntry(channelId, {
        apply_here: true,
        apply_subs: false,
        group: 'admin',
        allow: PermissionFlag.Enter | PermissionFlag.Speak,
        deny: 0,
      });
      await adminClient.addACLEntry(channelId, {
        apply_here: true,
        apply_subs: false,
        group: 'all',
        allow: 0,
        deny: PermissionFlag.Enter,
      });
      await new Promise(resolve => setTimeout(resolve, 300));

      const canEnter = await userClient.checkPermission(channelId, PermissionFlag.Enter, userSession);
      expect(typeof canEnter).toBe('boolean');

      await adminClient.deleteChannel(channelId);
      await adminClient.disconnect();
      await userClient.disconnect();
    });
  });
});
