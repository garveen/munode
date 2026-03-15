/**
 * 频道链接/取消链接实时通知集成测试
 *
 * 验证 Bug Fix：有权限的客户端发出 ChannelState(links_add/links_remove) 后，
 * 其他客户端（同 Edge 或跨 Edge）应当立即收到含 links_add/links_remove 的
 * ChannelState 消息，UI 和语音路由在不重连的情况下实时生效。
 *
 * 修复前问题：hub.channelUpdated 通知经 upsert_channel 更新内存后，
 * 广播给 Mumble 客户端的 ChannelState 缺少 links_add/links_remove 字段，
 * 导致客户端链接状态不更新。
 *
 * 覆盖的代码路径：
 *   Edge  : server.rs  ChannelState 消息处理 → notify_channel_state
 *   Hub   : rpc_handler.rs on_channel_state → broadcast hub.channelUpdated
 *   Edge  : hub_client.rs "hub.channelUpdated" handler（计算 links_add/links_remove）
 *   Edge  : server.rs EdgeEvent::ChannelUpdated → 广播 ChannelState to clients
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TestEnvironment,
  setupTestEnvironment,
  sleep,
  createClients,
  cleanupClients,
} from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * 等待指定客户端在 `channelId` 上收到含有 `expectedLinkId` 的 `field`
 * (links_add 或 links_remove) ChannelState 消息。
 */
function waitForLinkUpdate(
  client: MumbleClient,
  channelId: number,
  field: 'links_add' | 'links_remove',
  expectedLinkId: number,
  timeout = 8000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener('channelState', handler);
      reject(
        new Error(
          `Timeout: channel ${channelId} did not receive ${field}=[...${expectedLinkId}...] within ${timeout}ms`,
        ),
      );
    }, timeout);

    const handler = (msg: { channel_id?: number; links_add?: number[]; links_remove?: number[] }) => {
      if (msg.channel_id === channelId) {
        const list: number[] = (msg[field] as number[] | undefined) ?? [];
        if (list.includes(expectedLinkId)) {
          clearTimeout(timer);
          client.removeListener('channelState', handler);
          resolve();
        }
      }
    };

    client.on('channelState', handler);
  });
}

// ─── test suite ─────────────────────────────────────────────────────────────

describe('Channel Link/Unlink Real-Time Notification Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8093, { silent: true });
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  // ── Test 1: same-edge observer ─────────────────────────────────────────────
  it('link_add is delivered to same-edge observer immediately', async () => {
    const ts = Date.now();
    const [admin, observer] = await createClients(testEnv, [
      { username: 'admin', edge: 1 },
      { username: 'user1', edge: 1 },
    ]);

    try {
      // Create two fresh channels (admin gets their IDs back from the server).
      const chAId = await admin.createChannel(`LinkSameA_${ts}`, 0);
      const chBId = await admin.createChannel(`LinkSameB_${ts}`, 0);
      expect(chAId).toBeGreaterThan(0);
      expect(chBId).toBeGreaterThan(0);

      // Allow channel-created notifications to propagate to the observer.
      await sleep(500);

      // ── Link ──────────────────────────────────────────────────────────────
      const linkPromise = waitForLinkUpdate(observer, chAId, 'links_add', chBId);
      await admin.sendChannelState({ channel_id: chAId, links_add: [chBId] });
      await linkPromise;

      // Observer's in-memory state should reflect the new link.
      const chAAfterLink = observer.getStateManager().getChannel(chAId);
      expect(chAAfterLink).not.toBeNull();
      expect(chAAfterLink!.links).toContain(chBId);

      // ── Unlink ────────────────────────────────────────────────────────────
      const unlinkPromise = waitForLinkUpdate(observer, chAId, 'links_remove', chBId);
      await admin.sendChannelState({ channel_id: chAId, links_remove: [chBId] });
      await unlinkPromise;

      const chAAfterUnlink = observer.getStateManager().getChannel(chAId);
      expect(chAAfterUnlink!.links).not.toContain(chBId);
    } finally {
      await cleanupClients([admin, observer]);
    }
  }, 30000);

  // ── Test 2: cross-edge observer ────────────────────────────────────────────
  it('link_add is delivered to cross-edge observer immediately', async () => {
    const ts = Date.now();
    const [admin, observer] = await createClients(testEnv, [
      { username: 'admin', edge: 1 },
      { username: 'user2', edge: 2 },
    ]);

    try {
      const chAId = await admin.createChannel(`LinkCrossA_${ts}`, 0);
      const chBId = await admin.createChannel(`LinkCrossB_${ts}`, 0);
      expect(chAId).toBeGreaterThan(0);
      expect(chBId).toBeGreaterThan(0);

      await sleep(600); // cross-edge propagation takes a bit longer

      // ── Link ──────────────────────────────────────────────────────────────
      const linkPromise = waitForLinkUpdate(observer, chAId, 'links_add', chBId);
      await admin.sendChannelState({ channel_id: chAId, links_add: [chBId] });
      await linkPromise;

      const chAAfterLink = observer.getStateManager().getChannel(chAId);
      expect(chAAfterLink).not.toBeNull();
      expect(chAAfterLink!.links).toContain(chBId);

      // ── Unlink ────────────────────────────────────────────────────────────
      const unlinkPromise = waitForLinkUpdate(observer, chAId, 'links_remove', chBId);
      await admin.sendChannelState({ channel_id: chAId, links_remove: [chBId] });
      await unlinkPromise;

      const chAAfterUnlink = observer.getStateManager().getChannel(chAId);
      expect(chAAfterUnlink!.links).not.toContain(chBId);
    } finally {
      await cleanupClients([admin, observer]);
    }
  }, 30000);

  // ── Test 3: peer channels receive symmetric link/unlink notifications ─────
  // Both tests (peer links_add + peer links_remove) share the same setup,
  // so they are merged: link → verify both sides → unlink → verify both sides.
  it('both peer channels receive symmetric links_add then links_remove notifications', async () => {
    const ts = Date.now();
    const [admin, observer] = await createClients(testEnv, [
      { username: 'admin', edge: 1 },
      { username: 'guest', edge: 1 },
    ]);

    try {
      const chAId = await admin.createChannel(`LinkPeerA_${ts}`, 0);
      const chBId = await admin.createChannel(`LinkPeerB_${ts}`, 0);

      await sleep(500);

      // ── Link: Hub broadcasts channelUpdated for BOTH A and B ──────────────
      const linkAPromise = waitForLinkUpdate(observer, chAId, 'links_add', chBId);
      const linkBPromise = waitForLinkUpdate(observer, chBId, 'links_add', chAId);

      await admin.sendChannelState({ channel_id: chAId, links_add: [chBId] });

      await Promise.all([linkAPromise, linkBPromise]);

      // Both channels' state managers should have each other in their link lists.
      const chAState = observer.getStateManager().getChannel(chAId);
      const chBState = observer.getStateManager().getChannel(chBId);
      expect(chAState!.links).toContain(chBId);
      expect(chBState!.links).toContain(chAId);

      // ── Unlink: both A and B should receive symmetric links_remove ────────
      const unlinkAPromise = waitForLinkUpdate(observer, chAId, 'links_remove', chBId);
      const unlinkBPromise = waitForLinkUpdate(observer, chBId, 'links_remove', chAId);
      await admin.sendChannelState({ channel_id: chAId, links_remove: [chBId] });
      await Promise.all([unlinkAPromise, unlinkBPromise]);

      const chAFinal = observer.getStateManager().getChannel(chAId)!;
      expect(chAFinal.links).not.toContain(chBId);
      // Link list should be completely empty (not just missing chBId).
      expect(chAFinal.links.length).toBe(0);

      // Peer channel B should also no longer reference A.
      const chBFinal = observer.getStateManager().getChannel(chBId)!;
      expect(chBFinal.links).not.toContain(chAId);
    } finally {
      await cleanupClients([admin, observer]);
    }
  }, 30000);
});
