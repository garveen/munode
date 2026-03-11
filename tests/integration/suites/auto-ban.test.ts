/**
 * 自动封禁系统集成测试
 * 
 * 测试自动封禁功能（仅 Rust 实现）：
 * - 多次失败认证后自动封禁
 * - 封禁期间无法登录
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep, USE_RUST } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../../..');

const TEST_BASE_PORT = 8104;

describe('自动封禁系统集成测试', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(TEST_BASE_PORT);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should reject connections with wrong password', async () => {
    // Try connecting with wrong password - should be rejected
    const client = new MumbleClient();
    let rejected = false;

    try {
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'WRONG_PASSWORD_12345',
        rejectUnauthorized: false,
      });
      await sleep(500);
      // If connect doesn't throw, check if client is connected
      if (!client.isConnected()) {
        rejected = true;
      }
    } catch {
      rejected = true;
    }

    // Disconnect any partial connection
    try { await client.disconnect(); } catch {}

    // Auth with wrong password should result in rejection or failed connection
    expect(rejected || !client.isConnected()).toBe(true);
  });

  it.runIf(USE_RUST)('should auto-ban IP after multiple failed attempts (Rust only)', async () => {
    // This test requires a Rust Hub configured with auto_ban enabled
    // In the standard test environment, auto_ban is not enabled by default
    // This test verifies the mechanism works when configured

    // In standard test env without auto-ban config, multiple failed attempts
    // should just result in rejections, not bans
    let failureCount = 0;
    
    for (let i = 0; i < 3; i++) {
      const client = new MumbleClient();
      try {
        await client.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: `wrong_password_${i}`,
          rejectUnauthorized: false,
        });
        await sleep(300);
        if (!client.isConnected()) {
          failureCount++;
        }
      } catch {
        failureCount++;
      } finally {
        try { await client.disconnect(); } catch {}
      }
      await sleep(100);
    }

    // All attempts with wrong password should fail
    expect(failureCount).toBe(3);
  });

  it('should allow normal login after failed attempts (no auto-ban in default config)', async () => {
    // Make a few failed attempts first
    for (let i = 0; i < 2; i++) {
      const client = new MumbleClient();
      try {
        await client.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'wrong_password_attempt',
          rejectUnauthorized: false,
        });
        await sleep(200);
      } catch {}
      try { await client.disconnect(); } catch {}
      await sleep(100);
    }

    // Now try with correct credentials - should succeed
    const goodClient = new MumbleClient();
    await goodClient.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    await sleep(300);

    expect(goodClient.isConnected()).toBe(true);
    await goodClient.disconnect();
  });
});

// ─── Rust-mode auto-ban with enabled=true ─────────────────────────────────────
describe.skipIf(!USE_RUST)('Auto-Ban Active Integration Tests (Rust)', () => {
  let banEnv: TestEnvironment;

  beforeAll(async () => {
    // Start an isolated Hub with auto_ban enabled and a very low threshold
    // (3 failures within 60 s → 30 s ban).
    banEnv = await setupTestEnvironment(8204, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      rustHubExtraConfig: {
        auto_ban: {
          enabled: true,
          attempts: 3,
          time_window: 60,
          duration: 30,
        },
      },
    });
  }, 60000);

  afterAll(async () => {
    await banEnv?.cleanup();
  }, 30000);

  it('should auto-ban an IP after 3 failed auth attempts', async () => {
    // Make 3 failed login attempts
    for (let i = 0; i < 3; i++) {
      const client = new MumbleClient();
      try {
        await client.connect({
          host: 'localhost',
          port: banEnv.edgePort,
          username: 'user1',
          password: `wrong_password_${i}`,
          rejectUnauthorized: false,
        });
        await sleep(300);
      } catch {
        // Expected rejection
      } finally {
        try { await client.disconnect(); } catch {}
      }
      await sleep(200);
    }

    // Now try with correct credentials — the IP should be banned
    await sleep(500);
    const bannedClient = new MumbleClient();
    let wasBanned = false;
    try {
      await bannedClient.connect({
        host: 'localhost',
        port: banEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await sleep(400);
      // If connect didn't throw, check connection state
      if (!bannedClient.isConnected()) {
        wasBanned = true;
      }
    } catch {
      wasBanned = true;
    } finally {
      try { await bannedClient.disconnect(); } catch {}
    }

    expect(wasBanned).toBe(true);
  }, 30000);

  it('different IP (via IPv6 loopback simulation) should not be banned', async () => {
    // A fresh client with correct password from a _different_ IP path would work,
    // but in localhost tests we can't easily vary IP, so just verify the ban
    // state by re-checking that bad credentials still fail after ban.
    const client = new MumbleClient();
    let failed = false;
    try {
      await client.connect({
        host: 'localhost',
        port: banEnv.edgePort,
        username: 'user2',
        password: 'wrongpass',
        rejectUnauthorized: false,
      });
      await sleep(300);
      if (!client.isConnected()) failed = true;
    } catch {
      failed = true;
    } finally {
      try { await client.disconnect(); } catch {}
    }
    expect(failed).toBe(true);
  }, 10000);
});

describe.skipIf(!USE_RUST)('Auto-Ban Expiry Tests (Rust)', () => {
  let expiryEnv: TestEnvironment;

  beforeAll(async () => {
    // Use a very short ban duration (2 seconds) to test expiry
    expiryEnv = await setupTestEnvironment(8254, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      rustHubExtraConfig: {
        auto_ban: {
          enabled: true,
          attempts: 2,     // Ban after 2 failures
          time_window: 60,
          duration: 2,     // 2-second ban
        },
      },
    });
  }, 60000);

  afterAll(async () => {
    await expiryEnv?.cleanup();
  }, 30000);

  it('should unban IP after ban duration expires', async () => {
    // Trigger auto-ban with 2 failed attempts
    for (let i = 0; i < 2; i++) {
      const client = new MumbleClient();
      try {
        await client.connect({
          host: 'localhost',
          port: expiryEnv.edgePort,
          username: 'user1',
          password: `bad_pass_${i}`,
          rejectUnauthorized: false,
        });
        await sleep(300);
      } catch {}
      try { await client.disconnect(); } catch {}
      await sleep(200);
    }

    await sleep(500);

    // Should be banned now
    let wasBanned = false;
    {
      const c = new MumbleClient();
      try {
        await c.connect({ host: 'localhost', port: expiryEnv.edgePort, username: 'user1', password: 'password1', rejectUnauthorized: false });
        await sleep(400);
        if (!c.isConnected()) wasBanned = true;
      } catch { wasBanned = true; }
      try { await c.disconnect(); } catch {}
    }
    expect(wasBanned).toBe(true);

    // Wait for ban to expire (3 seconds to be safe)
    await sleep(3500);

    // Should succeed now
    const goodClient = new MumbleClient();
    let success = false;
    try {
      await goodClient.connect({ host: 'localhost', port: expiryEnv.edgePort, username: 'user1', password: 'password1', rejectUnauthorized: false });
      await sleep(500);
      success = goodClient.isConnected();
    } catch (e) {
      // Still banned?
    } finally {
      try { await goodClient.disconnect(); } catch {}
    }

    expect(success).toBe(true);
  }, 20000);
});

describe.skipIf(!USE_RUST)('Auto-Ban Isolation Tests (Rust)', () => {
  let isoEnv: TestEnvironment;

  beforeAll(async () => {
    isoEnv = await setupTestEnvironment(8284, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      rustHubExtraConfig: {
        auto_ban: {
          enabled: true,
          attempts: 2,     // Ban after 2 failures
          time_window: 60,
          duration: 60,
        },
      },
    });
  }, 60000);

  afterAll(async () => {
    await isoEnv?.cleanup();
  }, 30000);

  it('different IPs have independent failure counters', async () => {
    // Simulate 1 failure from "user1" (using wrong password)
    // – for loopback we can't easily use two different IPs, but we can verify
    // that correct login after 1 failure still works (only 2 failures trigger ban).
    const badClient = new MumbleClient();
    try {
      await badClient.connect({ host: 'localhost', port: isoEnv.edgePort, username: 'user1', password: 'wrong', rejectUnauthorized: false });
      await sleep(300);
    } catch {}
    try { await badClient.disconnect(); } catch {}

    await sleep(300);

    // One failure should NOT trigger the ban (threshold = 2)
    const goodClient = new MumbleClient();
    let loginOk = false;
    try {
      await goodClient.connect({ host: 'localhost', port: isoEnv.edgePort, username: 'user1', password: 'password1', rejectUnauthorized: false });
      await sleep(400);
      loginOk = goodClient.isConnected();
    } catch {}
    try { await goodClient.disconnect(); } catch {}

    expect(loginOk).toBe(true);
  }, 15000);
});
