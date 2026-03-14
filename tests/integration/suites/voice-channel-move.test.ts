/**
 * 频道切换后语音路由集成测试
 *
 * 测试场景：用户登录后语音正常，切换频道再切换回来后语音路由应仍然正常。
 *
 * 根本原因（已修复）：
 *   handle_user_state_update 中执行频道切换时，remove_client() 会清除
 *   crypt_states 中的 CryptState，而 add_client() 不会恢复它。
 *   结果：UDP 语音包到达 handle_known_client() 时，get_crypt_state() 返回
 *   None，函数提前返回，语音包被静默丢弃。
 *
 * 修复：在 remove_client 前保存 CryptState，add_client 后通过
 *   restore_crypt_state() 恢复，保持频道切换前后 UDP 加密会话不变。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TestEnvironment,
  setupTestEnvironment,
  createClients,
  cleanupClients,
  sleep,
  USE_RUST,
} from '../setup';
import * as crypto from 'crypto';

interface VoiceData {
  session: number;
  codec: number;
  target: number;
  sequence: number;
  data: Buffer;
}

/** 创建最小 Opus（type=4）语音包，格式: [header(1B)][seq_varint][voice_data] */
function makeVoicePacket(sequence = 0): Buffer {
  const header = Buffer.alloc(1);
  header.writeUInt8((4 << 5) | 0, 0); // codec=4 (Opus), target=0
  const seq = Buffer.from([sequence & 0x7f]);
  const audio = crypto.randomBytes(20);
  return Buffer.concat([header, seq, audio]);
}

/**
 * 发送 n 个语音包并等待 waitMs 毫秒，返回接收到的数量。
 * 在等待期间每隔 intervalMs 发一包，以提高接收概率。
 */
async function sendAndCount(
  sender: { getConnectionManager: () => { sendVoicePacket: (p: Buffer) => Promise<void> } },
  counter: { count: number },
  n = 5,
  intervalMs = 200,
  waitMs = 1500,
): Promise<number> {
  const before = counter.count;
  for (let i = 0; i < n; i++) {
    await sender.getConnectionManager().sendVoicePacket(makeVoicePacket(i));
    if (i < n - 1) await sleep(intervalMs);
  }
  await sleep(waitMs);
  return counter.count - before;
}

// This test suite specifically targets the Rust edge server's UDP CryptState
// preservation bug. The TypeScript edge uses a different channel-move path.
describe.skipIf(!USE_RUST)('Voice routing after channel switch (Rust UDP)', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8094, { reuse: false, silent: false });
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should deliver UDP voice correctly after sender self-moves to another channel and back', async () => {
    // sender uses UDP voice so the OCB2 CryptState code path is exercised.
    // receiver uses TCP (default) and receives via TCP UdpTunnel forwarding.
    const clients = await createClients(testEnv, [
      { username: 'ch_move_sender',   edge: 1, channelId: 0, useUdpVoice: true },
      { username: 'ch_move_receiver', edge: 1, channelId: 0 },
    ]);
    const [sender, receiver] = clients;

    const senderSession = sender.getStateManager().getSession()?.session ?? 0;
    expect(senderSession).toBeGreaterThan(0);

    const counter = { count: 0 };
    receiver.on('voice', (data: VoiceData) => {
      if (data.session === senderSession) counter.count++;
    });

    // Phase 1: baseline – voice works before any channel switch
    const baseline = await sendAndCount(sender, counter);
    expect(baseline).toBeGreaterThan(0);

    // Phase 2: sender moves to channel 1, then back to channel 0
    await sender.sendUserState({ channel_id: 1 });
    await sleep(500); // let the server process the move
    await sender.sendUserState({ channel_id: 0 });
    await sleep(500); // let the server process the return move

    // Phase 3: voice should still work after returning
    const afterMove = await sendAndCount(sender, counter);
    expect(afterMove).toBeGreaterThan(0);

    await cleanupClients(clients);
  }, 30000);

  it('should deliver UDP voice correctly after sender is admin-moved and moved back', async () => {
    // Uses an admin client to forcibly move the sender, which exercises the
    // admin-move branch in handle_user_state_update (separate channel-move code path).
    const clients = await createClients(testEnv, [
      { username: 'ch_move_sender',   edge: 1, channelId: 0, useUdpVoice: true },
      { username: 'ch_move_receiver', edge: 1, channelId: 0 },
      { username: 'ch_move_admin',    edge: 1, channelId: 0 },
    ]);
    const [sender, receiver, admin] = clients;

    const senderSession = sender.getStateManager().getSession()?.session ?? 0;
    expect(senderSession).toBeGreaterThan(0);

    const counter = { count: 0 };
    receiver.on('voice', (data: VoiceData) => {
      if (data.session === senderSession) counter.count++;
    });

    // Baseline
    const baseline = await sendAndCount(sender, counter);
    expect(baseline).toBeGreaterThan(0);

    // Admin moves sender to channel 1, then back to channel 0
    await admin.sendUserState({ session: senderSession, channel_id: 1 });
    await sleep(500);
    await admin.sendUserState({ session: senderSession, channel_id: 0 });
    await sleep(500);

    // Voice should still route correctly
    const afterMove = await sendAndCount(sender, counter);
    expect(afterMove).toBeGreaterThan(0);

    await cleanupClients(clients);
  }, 30000);
});
