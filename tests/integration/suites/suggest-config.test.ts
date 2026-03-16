/**
 * SuggestConfig 集成测试
 *
 * 测试 Edge 在客户端连接时发送 SuggestConfig 消息的功能：
 * - 配置了 suggest 时客户端收到 SuggestConfig 消息
 * - 未配置 suggest 时客户端不收到 SuggestConfig 消息
 * - 各字段值正确传递
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, USE_RUST } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';

describe.skipIf(!USE_RUST)('SuggestConfig Integration Tests (Rust)', () => {
  let suggestEnv: TestEnvironment;

  beforeAll(async () => {
    suggestEnv = await setupTestEnvironment(8404, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      rustHubExtraConfig: {
        suggest: {
          version: "20.114.125",
          positional: true,
          push_to_talk: false,
        },
      },
    });
  }, 60000);

  afterAll(async () => {
    await suggestEnv?.cleanup();
  }, 30000);

  it('should receive SuggestConfig message on connect when suggest is configured', async () => {
    const client = new MumbleClient();

    let suggestConfigReceived: unknown = null;
    const suggestPromise = new Promise<void>((resolve) => {
      client.on('suggestConfig', (msg: unknown) => {
        suggestConfigReceived = msg;
        resolve();
      });
    });

    await client.connect({
      host: 'localhost',
      port: suggestEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });

    await Promise.race([suggestPromise, new Promise(r => setTimeout(r, 3000))]);
    try { await client.disconnect(); } catch {}

    expect(suggestConfigReceived).not.toBeNull();
    const cfg = suggestConfigReceived as Record<string, unknown>;
    expect(cfg.version).toBe(1340029);
    expect(cfg.positional).toBe(true);
    expect(cfg.push_to_talk).toBe(false);
  }, 15000);

  it('should receive correct version number in SuggestConfig', async () => {
    const client = new MumbleClient();

    let version: number | null = null;
    const p = new Promise<void>((resolve) => {
      client.on('suggestConfig', (msg: Record<string, unknown>) => {
        version = msg.version as number;
        resolve();
      });
    });

    await client.connect({
      host: 'localhost', port: suggestEnv.edgePort,
      username: 'user2', password: 'password2', rejectUnauthorized: false,
    });

    await Promise.race([p, new Promise(r => setTimeout(r, 3000))]);
    try { await client.disconnect(); } catch {}

    expect(version).toBe(1340029);
  }, 15000);
});

describe('SuggestConfig - no config', () => {
  let noSuggestEnv: TestEnvironment;

  beforeAll(async () => {
    noSuggestEnv = await setupTestEnvironment(8454, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      // No suggest config
    });
  }, 60000);

  afterAll(async () => {
    await noSuggestEnv?.cleanup();
  }, 30000);

  it('should NOT receive SuggestConfig when suggest is not configured', async () => {
    const client = new MumbleClient();

    let received = false;
    client.on('suggestConfig', () => { received = true; });

    await client.connect({
      host: 'localhost', port: noSuggestEnv.edgePort,
      username: 'user1', password: 'password1', rejectUnauthorized: false,
    });

    // Wait enough time – if no message arrives, we're good
    await new Promise(r => setTimeout(r, 1500));
    try { await client.disconnect(); } catch {}

    expect(received).toBe(false);
  }, 15000);
});
