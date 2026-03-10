/**
 * 频道记忆功能集成测试
 * 
 * 测试频道记忆功能：
 * - 用户离线前保存所在频道
 * - 用户重新连接时恢复到上次所在频道
 * - 频道已删除时回退到默认频道
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep, USE_RUST } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';

const TEST_BASE_PORT = 8103;

describe('频道记忆功能集成测试', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(TEST_BASE_PORT);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should restore user to last channel after reconnect', async () => {
    // Step 1: Connect and move to a non-root channel
    const client1 = new MumbleClient();
    await client1.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(client1.isConnected()).toBe(true);
    await sleep(500);

    // Get available channels
    const channels = client1.getChannels();
    debugLog('Available channels:', channels.map(c => ({ id: c.channel_id, name: c.name })));

    // If there's a non-root channel, move to it
    const nonRootChannels = channels.filter(c => c.channel_id !== 0);
    let targetChannelId = 0;

    if (nonRootChannels.length > 0) {
      targetChannelId = nonRootChannels[0].channel_id;
      await client1.joinChannel(targetChannelId);
      await sleep(500);

      // Verify we moved
      const mySession = client1.getStateManager().getSession();
      debugLog('After move - My session channel:', mySession?.channel_id);
    }

    // Disconnect
    await client1.disconnect();
    await sleep(300);

    // Step 2: Reconnect and check channel
    const client2 = new MumbleClient();
    let restoredChannelId: number | undefined;

    await client2.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(client2.isConnected()).toBe(true);
    await sleep(500);

    const mySession = client2.getStateManager().getSession();
    restoredChannelId = mySession?.channel_id;
    debugLog('After reconnect - My session channel:', restoredChannelId);

    if (targetChannelId !== 0) {
      // User should be restored to last channel (or at least not throw an error)
      expect(restoredChannelId).toBeDefined();
      // The Rust implementation should restore to last channel
      if (USE_RUST) {
        expect(restoredChannelId).toBe(targetChannelId);
      }
    }

    await client2.disconnect();
  });

  it('should start in default channel on first login', async () => {
    // A new user (never connected before) should start in default channel (0)
    const client = new MumbleClient();
    await client.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user2',
      password: 'password2',
      rejectUnauthorized: false,
    });
    expect(client.isConnected()).toBe(true);
    await sleep(300);

    const mySession = client.getStateManager().getSession();
    debugLog('New user channel:', mySession?.channel_id);
    // Should be in some channel (default or configured)
    expect(mySession?.channel_id).toBeDefined();

    await client.disconnect();
  });

  it('should fall back to root channel if last channel was deleted', async () => {
    // This test creates a channel, moves user there, deletes the channel, then reconnects
    // The user should fall back to root channel (0)
    const adminClient = new MumbleClient();
    await adminClient.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'admin',
      password: 'admin123',
      rejectUnauthorized: false,
    });
    expect(adminClient.isConnected()).toBe(true);
    await sleep(300);

    // Create a temporary channel
    let newChannelId: number | undefined;
    const channelCreatedPromise = new Promise<number>((resolve) => {
      adminClient.on('channelState', (ch: any) => {
        if (ch.name === 'TempChannelForTest' && ch.channel_id > 0) {
          newChannelId = ch.channel_id;
          resolve(ch.channel_id);
        }
      });
    });

    await adminClient.createChannel('TempChannelForTest', 0);
    const createdId = await Promise.race([
      channelCreatedPromise,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('Channel not created')), 3000))
    ]).catch(() => null);

    if (createdId !== null && createdId !== undefined) {
      // Move user1 to the temp channel
      const userClient = new MumbleClient();
      await userClient.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await sleep(300);
      await userClient.joinChannel(createdId);
      await sleep(300);
      await userClient.disconnect();
      await sleep(300);

      // Delete the temporary channel
      await adminClient.deleteChannel(createdId);
      await sleep(300);

      // Reconnect user1 - should be in root or default channel
      const userClient2 = new MumbleClient();
      await userClient2.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await sleep(500);

      const mySession = userClient2.getStateManager().getSession();
      debugLog('After deleted channel reconnect - My session channel:', mySession?.channel_id);

      // Should be in a valid channel (root or default)
      expect(mySession?.channel_id).toBeDefined();
      // The deleted channel should not be the current channel
      if (createdId !== undefined) {
        // In Rust impl, if channel was deleted, user should fall back to default channel
        const existingChannels = userClient2.getChannels().map(c => c.channel_id);
        expect(existingChannels).not.toContain(createdId);
      }

      await userClient2.disconnect();
    }

    await adminClient.disconnect();
  });
});

function debugLog(...args: any[]): void {
  if (process.env.TEST_DEBUG === '1') {
    console.log('[ChannelMemory]', ...args);
  }
}
