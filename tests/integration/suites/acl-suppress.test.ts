/**
 * ACL Suppress 集成测试
 * 
 * 测试基于频道 ACL 的自动 suppress 功能：
 * - 用户进入没有 Speak 权限的频道时自动设置 suppress=true
 * - 用户进入有 Speak 权限的频道时自动清除 suppress
 * - suppress 与管理员设置的 mute/deaf 和用户自己设置的 self_mute/self_deaf 的区别
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { PermissionFlag } from '../fixtures';

describe('ACL Suppress Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8095);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should auto-suppress user when entering channel without Speak permission', async () => {
    const adminClient = new MumbleClient();
    const userClient = new MumbleClient();

    try {
      // 管理员登录
      await adminClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      // 普通用户登录
      await userClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 创建一个限制说话的频道
      const channelName = 'NoSpeakChannel_' + Date.now();
      const channelId = await adminClient.createChannel(channelName, 0);
      
      await new Promise(resolve => setTimeout(resolve, 300));

      // 设置 ACL：允许进入但拒绝说话
      await adminClient.addACLEntry(channelId, {
        applyHere: true,
        applySubs: false,
        group: 'all',
        grant: PermissionFlag.Enter | PermissionFlag.Traverse,
        deny: PermissionFlag.Speak,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 获取用户当前状态
      const userSession = userClient.getStateManager().getSession();
      expect(userSession).toBeDefined();
      expect(userSession?.suppress).toBe(false); // 初始状态不应该被 suppress

      // 用户移动到限制频道
      await userClient.moveToChannel(channelId);
      
      await new Promise(resolve => setTimeout(resolve, 800));

      // 检查用户状态：应该被自动设置 suppress=true
      const updatedSession = userClient.getStateManager().getSession();
      expect(updatedSession).toBeDefined();
      expect(updatedSession?.channel_id).toBe(channelId);
      expect(updatedSession?.suppress).toBe(true); // 应该被 suppress

      // 验证其他状态没有被改变
      expect(updatedSession?.mute).toBe(false); // 不是管理员 mute
      expect(updatedSession?.deaf).toBe(false);
      expect(updatedSession?.self_mute).toBe(false); // 不是用户自己 mute
      expect(updatedSession?.self_deaf).toBe(false);

      // 清理
      await adminClient.deleteChannel(channelId);
    } finally {
      await adminClient.disconnect();
      await userClient.disconnect();
    }
  }, 30000);

  it('should clear suppress when user moves to channel with Speak permission', async () => {
    const adminClient = new MumbleClient();
    const userClient = new MumbleClient();

    try {
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
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 创建两个频道：一个不能说话，一个可以说话
      const noSpeakChannel = 'NoSpeak_' + Date.now();
      const noSpeakId = await adminClient.createChannel(noSpeakChannel, 0);
      
      const canSpeakChannel = 'CanSpeak_' + Date.now();
      const canSpeakId = await adminClient.createChannel(canSpeakChannel, 0);

      await new Promise(resolve => setTimeout(resolve, 300));

      // 设置 NoSpeak 频道 ACL
      await adminClient.addACLEntry(noSpeakId, {
        applyHere: true,
        applySubs: false,
        group: 'all',
        grant: PermissionFlag.Enter | PermissionFlag.Traverse,
        deny: PermissionFlag.Speak,
      });

      // 设置 CanSpeak 频道 ACL（明确允许说话）
      await adminClient.addACLEntry(canSpeakId, {
        applyHere: true,
        applySubs: false,
        group: 'all',
        grant: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Speak,
        deny: 0,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 用户先移动到 NoSpeak 频道
      await userClient.moveToChannel(noSpeakId);
      await new Promise(resolve => setTimeout(resolve, 800));

      let session = userClient.getStateManager().getSession();
      expect(session?.suppress).toBe(true); // 应该被 suppress

      // 用户移动到 CanSpeak 频道
      await userClient.moveToChannel(canSpeakId);
      await new Promise(resolve => setTimeout(resolve, 800));

      session = userClient.getStateManager().getSession();
      expect(session?.channel_id).toBe(canSpeakId);
      expect(session?.suppress).toBe(false); // suppress 应该被清除

      // 清理
      await adminClient.deleteChannel(noSpeakId);
      await adminClient.deleteChannel(canSpeakId);
    } finally {
      await adminClient.disconnect();
      await userClient.disconnect();
    }
  }, 30000);

  it('should distinguish suppress from self mute', async () => {
    const adminClient = new MumbleClient();
    const userClient = new MumbleClient();

    try {
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
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      const userSession = userClient.getStateManager().getSession();
      expect(userSession).toBeDefined();

      // 1. 用户自己设置 self_mute
      await userClient.setSelfMute(true);
      await new Promise(resolve => setTimeout(resolve, 500));

      let session = userClient.getStateManager().getSession();
      expect(session?.self_mute).toBe(true);
      expect(session?.suppress).toBe(false); // 不是 suppress

      // 清除 self_mute
      await userClient.setSelfMute(false);
      await new Promise(resolve => setTimeout(resolve, 500));

      // 2. 管理员设置 mute
      await adminClient.muteUser(userSession!.session, true);
      await new Promise(resolve => setTimeout(resolve, 500));

      session = userClient.getStateManager().getSession();
      expect(session?.mute).toBe(true); // 管理员 mute
      expect(session?.self_mute).toBe(false);
      expect(session?.suppress).toBe(false); // 不是 suppress

      // 清除 admin mute
      await adminClient.muteUser(userSession!.session, false);
      await new Promise(resolve => setTimeout(resolve, 500));

      // 3. 创建限制频道，测试 suppress
      const channelName = 'SuppressTest_' + Date.now();
      const channelId = await adminClient.createChannel(channelName, 0);

      await adminClient.addACLEntry(channelId, {
        applyHere: true,
        applySubs: false,
        group: 'all',
        grant: PermissionFlag.Enter | PermissionFlag.Traverse,
        deny: PermissionFlag.Speak,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await userClient.moveToChannel(channelId);
      await new Promise(resolve => setTimeout(resolve, 800));

      session = userClient.getStateManager().getSession();
      expect(session?.suppress).toBe(true); // 基于 ACL 的 suppress
      expect(session?.mute).toBe(false); // 不是管理员 mute
      expect(session?.self_mute).toBe(false); // 不是用户自己 mute

      // 清理
      await adminClient.deleteChannel(channelId);
    } finally {
      await adminClient.disconnect();
      await userClient.disconnect();
    }
  }, 30000);

  it('should suppress user on first login if channel lacks Speak permission', async () => {
    const adminClient = new MumbleClient();

    try {
      // 管理员登录
      await adminClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 创建限制频道
      const channelName = 'InitialSuppress_' + Date.now();
      const channelId = await adminClient.createChannel(channelName, 0);

      await new Promise(resolve => setTimeout(resolve, 300));

      // 设置 ACL：允许进入但拒绝说话
      await adminClient.addACLEntry(channelId, {
        applyHere: true,
        applySubs: false,
        group: 'all',
        grant: PermissionFlag.Enter | PermissionFlag.Traverse,
        deny: PermissionFlag.Speak,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 创建新用户，直接登录到该频道
      const userClient = new MumbleClient();
      
      try {
        // 注意：新用户首次登录会进入默认频道（根频道），需要手动移动
        await userClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // 移动到限制频道
        await userClient.moveToChannel(channelId);
        await new Promise(resolve => setTimeout(resolve, 800));

        // 检查用户状态
        let session = userClient.getStateManager().getSession();
        expect(session).toBeDefined();
        expect(session?.channel_id).toBe(channelId);
        expect(session?.suppress).toBe(true); // 应该被 suppress

        // 现在断开并重新连接 - 用户应该会回到上次的频道，并且仍然被 suppress
        await userClient.disconnect();
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 重新连接
        await userClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'guest',
          password: 'guest123',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        // 检查用户状态 - 应该回到上次的频道并被 suppress
        session = userClient.getStateManager().getSession();
        expect(session).toBeDefined();
        expect(session?.channel_id).toBe(channelId); // 回到上次的频道
        expect(session?.suppress).toBe(true); // 仍然被 suppress
      } finally {
        await userClient.disconnect();
      }

      // 清理
      await adminClient.deleteChannel(channelId);
    } finally {
      await adminClient.disconnect();
    }
  }, 40000);
});
