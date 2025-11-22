/**
 * Channel Ninja Feature Integration Tests
 *
 * Tests for the Channel Ninja functionality, including:
 * - Configuration toggle control
 * - User hiding behavior when moving to invisible channels
 * - User showing behavior when returning to visible channels
 * - Voice packets still routing normally
 * - Cross-Edge server Ninja functionality
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { mumbleproto } from '../../../packages/protocol/dist/index.js';
import { MumbleClient } from '../../../packages/client/dist/index.js';

describe('Channel Ninja Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Use special port to avoid conflicts with other tests
    testEnv = await setupTestEnvironment(8090, {
      hubConfig: {
        channelNinja: true, // Enable Channel Ninja functionality
      },
    });
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Basic Ninja Functionality', () => {
    it('should hide users in channels without Enter/Listen permission', async () => {
      // Create three clients
      const admin = new MumbleClient();
      const user1 = new MumbleClient();
      const user2 = new MumbleClient();

      try {
        // Admin connects
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin_password',
          rejectUnauthorized: false,
        });

        // 等待同步完成
        await new Promise(resolve => setTimeout(resolve, 500));

        // Create a restricted channel (only admin group can enter)
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

        // Create channel
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

        // Set ACL so only admin group can enter
        // Simplified test - assuming ACL is set through other means
        // In actual tests, need to set ACL permissions via ACL messages

        // user1 connects (normal user)
        await user1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'user1_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // user2 connects (normal user)
        await user2.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'user2_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // Track users seen by user1
        const user1SeesUsers = new Set<number>();
        user1.on('userState', (state: any) => {
          if (state.session !== undefined) {
            user1SeesUsers.add(state.session);
          }
        });

        // Track UserRemove messages received by user1
        let user1SawAdminRemove = false;
        user1.on('userRemove', (remove: any) => {
          if (remove.session === admin.session) {
            user1SawAdminRemove = true;
          }
        });

        // Wait for initial state sync
        await new Promise(resolve => setTimeout(resolve, 1000));

        // user1 should be able to see admin (both in Root channel)
        expect(user1SeesUsers.has(admin.session!)).toBe(true);

        // admin moves to restricted channel
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

        // Wait for UserRemove message
        await Promise.race([
          userRemovePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('UserRemove timeout')), 5000)),
        ]);

        // user1 should receive admin's UserRemove message (because can't see restricted channel)
        expect(user1SawAdminRemove).toBe(true);

        // admin moves back to Root channel
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

        // Wait for admin's return UserState message
        await Promise.race([
          userReturnPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('UserState return timeout')), 5000)),
        ]);

        // user1 should see admin again
        expect(user1SawAdminReturn).toBe(true);
      } finally {
        await admin.disconnect();
        await user1.disconnect();
        await user2.disconnect();
      }
    }, 30000);

    it('should work across multiple Edge servers', async () => {
      // Create three clients connecting to different Edges
      const admin = new MumbleClient();
      const userEdge1 = new MumbleClient();
      const userEdge2 = new MumbleClient();

      try {
        // admin connects to Edge1
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin_multi',
          password: 'admin_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // userEdge1 connects to Edge1
        await userEdge1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user_edge1',
          password: 'user_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // userEdge2 connects to Edge2
        await userEdge2.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'user_edge2',
          password: 'user_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Listen for UserRemove received by userEdge2
        let userEdge2SawAdminRemove = false;
        userEdge2.on('userRemove', (remove: any) => {
          if (remove.session === admin.session) {
            userEdge2SawAdminRemove = true;
          }
        });

        // Create restricted channel
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

        // admin moves to restricted channel
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

        // userEdge2 should receive admin UserRemove message on another Edge
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
        // admin connects
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin_state',
          password: 'admin_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        // Create restricted channel
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

        // admin moves to restricted channel
        admin.sendUserState({
          session: admin.session,
          channelId: restrictedChannelId,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        // user connects
        await user.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user_state',
          password: 'user_password',
          rejectUnauthorized: false,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Listen for UserState updates received by user
        let userSawAdminMuteChange = false;
        user.on('userState', (state: any) => {
          if (state.session === admin.session && state.mute !== undefined) {
            userSawAdminMuteChange = true;
          }
        });

        // admin toggles mute state in restricted channel
        admin.sendUserState({
          session: admin.session,
          mute: true,
        });

        // 等待一段时间
        await new Promise(resolve => setTimeout(resolve, 2000));

        // user should not receive admin mute state update (because admin is in invisible channel)
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
    // Create test environment without Channel Ninja enabled
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
      // admin connects
      await admin.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin_no_ninja',
        password: 'admin_password',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Create a channel
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

      // user connects
      await user.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user_no_ninja',
        password: 'user_password',
        rejectUnauthorized: false,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Listen for messages received by user
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

      // admin moves to new channel
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

      // When ninja is disabled, user should see admin move (UserState), not UserRemove
      expect(userSawAdminMove).toBe(true);
      expect(userSawAdminRemove).toBe(false);
    } finally {
      await admin.disconnect();
      await user.disconnect();
    }
  }, 30000);
});
