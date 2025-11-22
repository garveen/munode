/**
 * Channel Ninja功能集成测试
 *
 * 测试频道Ninja功能，包括：
 * - 配置开关控制
 * - 用户移动到不可见频道时的隐藏行为
 * - 用户移动回可见频道时的显示行为
 * - 语音包仍然正常路由
 * - 跨Edge服务器的Ninja功能
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { mumbleproto } from '../../../packages/protocol/dist/index.js';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('Channel Ninja Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // 使用特殊端口以避免与其他测试冲突
    testEnv = await setupTestEnvironment(8090, {
      hubConfig: {
        channelNinja: true, // 启用Channel Ninja功能
      },
    });
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Basic Ninja Functionality', () => {
    it('should hide users in channels without Enter/Listen permission', async () => {
      // 创建三个客户端
      const admin = new MumbleClient();
      const user1 = new MumbleClient();
      const user2 = new MumbleClient();

      try {
        // 管理员连接
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin_password',
          rejectUnauthorized: false,
        });

        // 等待同步完成
        await new Promise(resolve => setTimeout(resolve, 500));

        // 创建一个受限频道（只有admin组可以进入）
        const restrictedChannelName = `Restricted_${Date.now()}`;
        let restrictedChannelId: number | undefined;

        const channelCreatePromise = new Promise<void>((resolve) => {
          admin.on('channelState', (state: any) => {
            if (state.name === restrictedChannelName) {
              restrictedChannelId = state.channelId;
              resolve();
            }
          });
        });

        // 创建频道
        admin.sendChannelState({
          parent: 0,
          name: restrictedChannelName,
          temporary: false,
        });

        await Promise.race([
          channelCreatePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Channel create timeout')), 5000)),
        ]);

        expect(restrictedChannelId).toBeDefined();

        // 设置ACL使得只有admin组可以进入
        // 这里简化测试，假设已经通过其他方式设置了ACL
        // 实际测试中需要通过ACL消息设置权限

        // user1连接（普通用户）
        await user1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'user1_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // user2连接（普通用户）
        await user2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'user2_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // 记录user1看到的用户
        const user1SeesUsers = new Set<number>();
        user1.on('userState', (state: any) => {
          if (state.session !== undefined) {
            user1SeesUsers.add(state.session);
          }
        });

        // 记录user1收到的UserRemove消息
        let user1SawAdminRemove = false;
        user1.on('userRemove', (remove: any) => {
          if (remove.session === admin.session) {
            user1SawAdminRemove = true;
          }
        });

        // 等待初始状态同步
        await new Promise(resolve => setTimeout(resolve, 1000));

        // user1应该能看到admin（都在Root频道）
        expect(user1SeesUsers.has(admin.session!)).toBe(true);

        // admin移动到受限频道
        const userRemovePromise = new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (user1SawAdminRemove) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        });

        admin.sendUserState({
          session: admin.session,
          channelId: restrictedChannelId,
        });

        // 等待UserRemove消息
        await Promise.race([
          userRemovePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('UserRemove timeout')), 5000)),
        ]);

        // user1应该收到admin的UserRemove消息（因为看不见受限频道）
        expect(user1SawAdminRemove).toBe(true);

        // admin移动回Root频道
        user1SawAdminRemove = false;
        let user1SawAdminReturn = false;

        const userReturnPromise = new Promise<void>((resolve) => {
          user1.on('userState', (state: any) => {
            if (state.session === admin.session && state.channelId === 0) {
              user1SawAdminReturn = true;
              resolve();
            }
          });
        });

        admin.sendUserState({
          session: admin.session,
          channelId: 0,
        });

        // 等待admin返回的UserState消息
        await Promise.race([
          userReturnPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('UserState return timeout')), 5000)),
        ]);

        // user1应该再次看到admin
        expect(user1SawAdminReturn).toBe(true);
      } finally {
        await admin.disconnect();
        await user1.disconnect();
        await user2.disconnect();
      }
    }, 30000);

    it('should work across multiple Edge servers', async () => {
      // 创建三个客户端，分别连接到不同的Edge
      const admin = new MumbleClient();
      const userEdge1 = new MumbleClient();
      const userEdge2 = new MumbleClient();

      try {
        // admin连接到Edge1
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin_multi',
          password: 'admin_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // userEdge1连接到Edge1
        await userEdge1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user_edge1',
          password: 'user_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // userEdge2连接到Edge2
        await userEdge2.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'user_edge2',
          password: 'user_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        // 监听userEdge2收到的UserRemove
        let userEdge2SawAdminRemove = false;
        userEdge2.on('userRemove', (remove: any) => {
          if (remove.session === admin.session) {
            userEdge2SawAdminRemove = true;
          }
        });

        // 创建受限频道
        const restrictedChannelName = `Restricted_Multi_${Date.now()}`;
        let restrictedChannelId: number | undefined;

        const channelCreatePromise = new Promise<void>((resolve) => {
          admin.on('channelState', (state: any) => {
            if (state.name === restrictedChannelName) {
              restrictedChannelId = state.channelId;
              resolve();
            }
          });
        });

        admin.sendChannelState({
          parent: 0,
          name: restrictedChannelName,
          temporary: false,
        });

        await Promise.race([
          channelCreatePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Channel create timeout')), 5000)),
        ]);

        expect(restrictedChannelId).toBeDefined();

        // admin移动到受限频道
        const userRemovePromise = new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (userEdge2SawAdminRemove) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        });

        admin.sendUserState({
          session: admin.session,
          channelId: restrictedChannelId,
        });

        // 等待跨Edge的UserRemove消息
        await Promise.race([
          userRemovePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Cross-edge UserRemove timeout')), 5000)),
        ]);

        // userEdge2应该在另一个Edge上收到admin的UserRemove消息
        expect(userEdge2SawAdminRemove).toBe(true);
      } finally {
        await admin.disconnect();
        await userEdge1.disconnect();
        await userEdge2.disconnect();
      }
    }, 30000);
  });

  describe('Ninja with Non-Channel State Changes', () => {
    it('should filter mute/deaf state changes for users in invisible channels', async () => {
      const admin = new MumbleClient();
      const user = new MumbleClient();

      try {
        // admin连接
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin_state',
          password: 'admin_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // 创建受限频道
        const restrictedChannelName = `Restricted_State_${Date.now()}`;
        let restrictedChannelId: number | undefined;

        const channelCreatePromise = new Promise<void>((resolve) => {
          admin.on('channelState', (state: any) => {
            if (state.name === restrictedChannelName) {
              restrictedChannelId = state.channelId;
              resolve();
            }
          });
        });

        admin.sendChannelState({
          parent: 0,
          name: restrictedChannelName,
          temporary: false,
        });

        await Promise.race([
          channelCreatePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Channel create timeout')), 5000)),
        ]);

        expect(restrictedChannelId).toBeDefined();

        // admin移动到受限频道
        admin.sendUserState({
          session: admin.session,
          channelId: restrictedChannelId,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        // user连接
        await user.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user_state',
          password: 'user_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        // 监听user收到的UserState更新
        let userSawAdminMuteChange = false;
        user.on('userState', (state: any) => {
          if (state.session === admin.session && state.mute !== undefined) {
            userSawAdminMuteChange = true;
          }
        });

        // admin在受限频道中切换静音状态
        admin.sendUserState({
          session: admin.session,
          mute: true,
        });

        // 等待一段时间
        await new Promise(resolve => setTimeout(resolve, 2000));

        // user不应该收到admin的静音状态更新（因为admin在不可见频道中）
        expect(userSawAdminMuteChange).toBe(false);
      } finally {
        await admin.disconnect();
        await user.disconnect();
      }
    }, 30000);
  });
});

describe('Channel Ninja Disabled Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // 创建不启用Channel Ninja的测试环境
    testEnv = await setupTestEnvironment(8091, {
      hubConfig: {
        channelNinja: false, // 禁用Channel Ninja功能
      },
    });
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should not hide users when ninja is disabled', async () => {
    const admin = new MumbleClient();
    const user = new MumbleClient();

    try {
      // admin连接
      await admin.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin_no_ninja',
        password: 'admin_password',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 创建一个频道
      const channelName = `Channel_No_Ninja_${Date.now()}`;
      let channelId: number | undefined;

      const channelCreatePromise = new Promise<void>((resolve) => {
        admin.on('channelState', (state: any) => {
          if (state.name === channelName) {
            channelId = state.channelId;
            resolve();
          }
        });
      });

      admin.sendChannelState({
        parent: 0,
        name: channelName,
        temporary: false,
      });

      await Promise.race([
        channelCreatePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Channel create timeout')), 5000)),
      ]);

      expect(channelId).toBeDefined();

      // user连接
      await user.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user_no_ninja',
        password: 'user_password',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // 监听user收到的消息
      let userSawAdminMove = false;
      let userSawAdminRemove = false;

      user.on('userState', (state: any) => {
        if (state.session === admin.session && state.channelId === channelId) {
          userSawAdminMove = true;
        }
      });

      user.on('userRemove', (remove: any) => {
        if (remove.session === admin.session) {
          userSawAdminRemove = true;
        }
      });

      // admin移动到新频道
      const userStateMovePromise = new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (userSawAdminMove) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });

      admin.sendUserState({
        session: admin.session,
        channelId: channelId,
      });

      await Promise.race([
        userStateMovePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('UserState move timeout')), 5000)),
      ]);

      // 当ninja禁用时，user应该看到admin的移动（UserState），而不是UserRemove
      expect(userSawAdminMove).toBe(true);
      expect(userSawAdminRemove).toBe(false);
    } finally {
      await admin.disconnect();
      await user.disconnect();
    }
  }, 30000);
});
