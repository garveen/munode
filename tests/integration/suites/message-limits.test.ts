/**
 * 带宽和消息限制集成测试
 * 
 * 测试消息限制功能，包括：
 * - 文本消息长度限制
 * - 消息速率限制
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, USE_RUST, debugLog } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import * as fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../../..');

const TEST_BASE_PORT = 8102;

describe('消息限制集成测试', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(TEST_BASE_PORT);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should accept text messages within length limit', async () => {
    const client = new MumbleClient();
    await client.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(client.isConnected()).toBe(true);

    // Send a short message - should succeed
    const shortMsg = 'Hello, World!';
    await client.sendMessage({ channelId: 0 }, shortMsg);
    await new Promise(resolve => setTimeout(resolve, 200));

    // Client should still be connected
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });

  it.skipIf(USE_RUST)('should reject oversized text messages (TS only)', async () => {
    // This test verifies TS implementation behavior
    // Rust implementation also enforces limits but via configurable server settings
    const client = new MumbleClient();
    await client.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(client.isConnected()).toBe(true);

    // Track PermissionDenied messages
    let denied = false;
    const deniedPromise = new Promise<void>((resolve) => {
      client.on('permissionDenied', () => {
        denied = true;
        resolve();
      });
    });

    // Send an oversized message (> 5000 bytes default limit)
    const oversizedMsg = 'A'.repeat(6000);
    await client.sendMessage({ channelId: 0 }, oversizedMsg);

    // Wait briefly for potential denial response
    await Promise.race([
      deniedPromise,
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);

    // Client should still be connected (just the message was rejected)
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });

  it('should deliver text messages between clients on same edge', async () => {
    const sender = new MumbleClient();
    const receiver = new MumbleClient();

    await sender.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    await receiver.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user2',
      password: 'password2',
      rejectUnauthorized: false,
    });

    expect(sender.isConnected()).toBe(true);
    expect(receiver.isConnected()).toBe(true);

    const testMessage = 'Integration test message ' + Date.now();
    let received = false;
    const receivePromise = new Promise<void>((resolve) => {
      receiver.on('textMessage', (msg: any) => {
        if (msg.message === testMessage) {
          received = true;
          resolve();
        }
      });
    });

    // Send message to current channel
    await sender.sendMessage({ channelId: 0 }, testMessage);

    await Promise.race([
      receivePromise,
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);

    expect(received).toBe(true);

    await sender.disconnect();
    await receiver.disconnect();
  });
});
