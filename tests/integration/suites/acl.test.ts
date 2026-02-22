/**
 * 权限系统集成测试
 * 
 * 测试 ACL 和权限检查，包括：
 * - ACL 继承
 * - 权限检查
 * - 组权限
 * - 频道权限
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup';
import { MumbleConnection } from '../helpers';
import { PermissionFlag } from '../fixtures';
import { MumbleClient } from '../../../packages/client/src/index.js';
import * as crypto from 'crypto';

interface VoiceData {
  session: number;
  codec: number;
  target: number;
  sequence: number;
  data: Buffer;
}

function createVoicePacket(codec: number = 4, target: number = 0, sequence: number = 0): Buffer {
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);
  const sequenceVarint = Buffer.from([sequence & 0x7F]);
  const voiceData = crypto.randomBytes(20);
  return Buffer.concat([header, sequenceVarint, voiceData]);
}

describe('ACL and Permissions Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8081);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Permission Flags', () => {
    it('should have correct permission flag values', () => {
      expect(PermissionFlag.None).toBe(0);
      expect(PermissionFlag.Write).toBe(1);
      expect(PermissionFlag.Traverse).toBe(2);
      expect(PermissionFlag.Enter).toBe(4);
      expect(PermissionFlag.Speak).toBe(8);
    });

    it('should support bitwise operations', () => {
      const permissions = PermissionFlag.Write | PermissionFlag.Speak;
      expect(permissions & PermissionFlag.Write).toBeTruthy();
      expect(permissions & PermissionFlag.Speak).toBeTruthy();
      expect(permissions & PermissionFlag.Enter).toBe(0);
    });

    it('should have all standard permission flags defined', () => {
      expect(PermissionFlag.Whisper).toBeDefined();
      expect(PermissionFlag.MuteDeafen).toBeDefined();
      expect(PermissionFlag.Move).toBeDefined();
      expect(PermissionFlag.MakeChannel).toBeDefined();
      expect(PermissionFlag.MakeTempChannel).toBeDefined();
      expect(PermissionFlag.LinkChannel).toBeDefined();
      expect(PermissionFlag.TextMessage).toBeDefined();
      expect(PermissionFlag.Kick).toBeDefined();
      expect(PermissionFlag.Ban).toBeDefined();
      expect(PermissionFlag.Register).toBeDefined();
      expect(PermissionFlag.SelfRegister).toBeDefined();
    });
  });

  describe('Permission Combinations', () => {
    it('should combine multiple permissions', () => {
      const userPerms = PermissionFlag.Enter | PermissionFlag.Speak | PermissionFlag.TextMessage;
      
      expect((userPerms & PermissionFlag.Enter) !== 0).toBe(true);
      expect((userPerms & PermissionFlag.Speak) !== 0).toBe(true);
      expect((userPerms & PermissionFlag.TextMessage) !== 0).toBe(true);
      expect((userPerms & PermissionFlag.Ban) !== 0).toBe(false);
    });

    it('should handle admin permissions', () => {
      const adminPerms = 
        PermissionFlag.Write |
        PermissionFlag.Traverse |
        PermissionFlag.Enter |
        PermissionFlag.Speak |
        PermissionFlag.Kick |
        PermissionFlag.Ban;
      
      expect((adminPerms & PermissionFlag.Kick) !== 0).toBe(true);
      expect((adminPerms & PermissionFlag.Ban) !== 0).toBe(true);
    });

    it('should handle channel creation permissions', () => {
      const channelCreatorPerms = 
        PermissionFlag.MakeChannel | 
        PermissionFlag.MakeTempChannel;
      
      expect((channelCreatorPerms & PermissionFlag.MakeChannel) !== 0).toBe(true);
      expect((channelCreatorPerms & PermissionFlag.MakeTempChannel) !== 0).toBe(true);
    });
  });

  describe('ACL Inheritance', () => {
    it('should collect inherited ACLs correctly', () => {
      // 模拟频道结构
      const channels = new Map();
      channels.set(0, { id: 0, name: 'Root', parent_id: undefined, inherit_acl: true });
      channels.set(1, { id: 1, name: 'Parent', parent_id: 0, inherit_acl: true });
      channels.set(2, { id: 2, name: 'Child', parent_id: 1, inherit_acl: true });
      channels.set(3, { id: 3, name: 'NoInherit', parent_id: 1, inherit_acl: false });
      channels.set(4, { id: 4, name: 'GrandChild', parent_id: 3, inherit_acl: true });

      // 模拟ACL映射
      const aclMap = new Map();
      aclMap.set(0, [
        { applyHere: true, applySubs: true, userId: 1, allow: 0x1, deny: 0x0 }
      ]);
      aclMap.set(1, [
        { applyHere: true, applySubs: true, group: 'admin', allow: 0xff, deny: 0x0 }
      ]);
      aclMap.set(2, [
        { applyHere: true, applySubs: false, userId: 2, allow: 0x4, deny: 0x0 }
      ]);
      aclMap.set(3, [
        { applyHere: true, applySubs: true, userId: 3, allow: 0x8, deny: 0x0 }
      ]);

      // 测试函数：构建频道链并收集继承的ACL
      function collectInheritedACLs(channelId: number) {
        const channel = channels.get(channelId);
        if (!channel) return [];

        const channelsInChain = [];
        let iter = channel;
        
        while (iter) {
          channelsInChain.unshift(iter);
          
          if ((iter.id === channel.id || iter.inherit_acl !== false) && 
              iter.parent_id !== undefined && 
              iter.parent_id >= 0) {
            iter = channels.get(iter.parent_id);
          } else {
            break;
          }
        }

        const allACLs = [];
        for (const iterChannel of channelsInChain) {
          const channelACLs = aclMap.get(iterChannel.id) || [];
          
          for (const aclEntry of channelACLs) {
            if (iterChannel.id === channel.id || aclEntry.applySubs) {
              allACLs.push({
                applyHere: aclEntry.applyHere,
                applySubs: aclEntry.applySubs,
                inherited: iterChannel.id !== channel.id,
                userId: aclEntry.userId,
                group: aclEntry.group,
                grant: aclEntry.allow,
                deny: aclEntry.deny,
                fromChannel: iterChannel.name
              });
            }
          }
        }

        return allACLs;
      }

      // 测试用例1：查询子频道(ID=2)的ACL，应该包含从Root和Parent继承的ACL
      const childACLs = collectInheritedACLs(2);
      expect(childACLs.length).toBe(3);
      expect(childACLs[0].inherited).toBe(true);
      expect(childACLs[1].inherited).toBe(true);
      expect(childACLs[2].inherited).toBe(false);

      // 测试用例2：查询不继承ACL的频道(ID=3)
      const noInheritACLs = collectInheritedACLs(3);
      expect(noInheritACLs.length).toBeGreaterThan(0);

      // 测试用例3：查询父频道(ID=1)的ACL
      const parentACLs = collectInheritedACLs(1);
      expect(parentACLs.length).toBe(2);
      expect(parentACLs[0].inherited).toBe(true);
      expect(parentACLs[1].inherited).toBe(false);

      // 测试用例4：applySubs 为 false 的ACL不应该被子频道继承
      const childOwnACL = aclMap.get(2)[0];
      expect(childOwnACL.applySubs).toBe(false);

      // 测试用例5：GrandChild频道
      const grandChildACLs = collectInheritedACLs(4);
      expect(grandChildACLs.length).toBe(1);
      expect(grandChildACLs[0].fromChannel).toBe('NoInherit');
      expect(grandChildACLs[0].inherited).toBe(true);
    });

    it('should handle permission inheritance with bitwise operations', () => {
      // 测试权限继承的位运算
      const parentPerms = PermissionFlag.Write | PermissionFlag.Traverse;
      const childPerms = PermissionFlag.Enter | PermissionFlag.Speak;
      
      // 子权限应该继承父权限
      const effectivePerms = parentPerms | childPerms;
      
      expect(effectivePerms & PermissionFlag.Write).toBeTruthy();
      expect(effectivePerms & PermissionFlag.Traverse).toBeTruthy();
      expect(effectivePerms & PermissionFlag.Enter).toBeTruthy();
      expect(effectivePerms & PermissionFlag.Speak).toBeTruthy();
    });

    it('should deny permissions correctly', () => {
      // 测试权限拒绝
      const allowPerms = PermissionFlag.Write | PermissionFlag.Traverse | PermissionFlag.Enter;
      const denyPerms = PermissionFlag.Write; // 拒绝写权限
      
      const effectivePerms = allowPerms & ~denyPerms;
      
      expect(effectivePerms & PermissionFlag.Write).toBe(0);
      expect(effectivePerms & PermissionFlag.Traverse).toBeTruthy();
      expect(effectivePerms & PermissionFlag.Enter).toBeTruthy();
    });
  });

  describe('User Actual Operations Tests', () => {
    it('should allow second user to enter, speak and listen in permitted channel', async () => {
      const adminClient = new MumbleClient();
      const userClient = new MumbleClient();   // acl_op_user - 第二个用户
      const observerClient = new MumbleClient(); // acl_op_observer - 用于接收语音

      try {
        await adminClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin123',
          rejectUnauthorized: false,
          forceTcpVoice: true,
        });

        await userClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'acl_op_user',
          password: 'acl_op_pass',
          rejectUnauthorized: false,
          forceTcpVoice: true,
        });

        await observerClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'acl_op_observer',
          password: 'acl_op_obs_pass',
          rejectUnauthorized: false,
          forceTcpVoice: true,
        });

        await sleep(500);

        // 创建允许频道，对所有人开放 Enter + Traverse + Speak + Listen + Whisper
        const allowedName = 'ACLAllowed_' + Date.now();
        const allowedId = await adminClient.createChannel(allowedName, 0);
        await sleep(300);

        await adminClient.addACLEntry(allowedId, {
          apply_here: true,
          apply_subs: false,
          group: 'acl_testers',
          allow: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Speak
            | PermissionFlag.Listen | PermissionFlag.Whisper | PermissionFlag.TextMessage,
          deny: 0,
        });
        await sleep(500);

        // 同时移动 observer 到 allowed 频道（提前，避免监听到历史事件）
        await observerClient.moveToChannel(allowedId);
        await sleep(300);

        // ---- 测试 1: 第二个用户可以进入被允许的频道 ----
        let enterPermDenied = false;
        const onEnterPermDenied = () => { enterPermDenied = true; };
        userClient.on('permissionDenied', onEnterPermDenied);

        await userClient.moveToChannel(allowedId);
        await sleep(600);

        userClient.off('permissionDenied', onEnterPermDenied);

        const userStateAfterEnter = userClient.getStateManager().getSession();
        expect(enterPermDenied).toBe(false);
        expect(userStateAfterEnter?.channel_id).toBe(allowedId);
        expect(userStateAfterEnter?.suppress).toBe(false); // 有 Speak 权限，不应被 suppress

        // ---- 测试 2: 第二个用户可以在被允许的频道中说话（observer 能收到语音）----
        const userSession = userClient.getStateManager().getSession()?.session ?? 0;
        let voiceReceived = false;
        const onVoice = (data: VoiceData) => {
          if (data.session === userSession) voiceReceived = true;
        };
        observerClient.on('voice', onVoice);

        const voicePacket = createVoicePacket(4, 0, 0);
        await userClient.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(1500);

        observerClient.off('voice', onVoice);
        expect(voiceReceived).toBe(true);

        // ---- 测试 3: 第二个用户可以监听被允许的频道 ----
        // 让第二个用户先移回根频道，然后监听 allowed 频道
        await userClient.moveToChannel(0);
        await sleep(300);

        let listenPermDenied = false;
        const onListenPermDenied = () => { listenPermDenied = true; };
        userClient.on('permissionDenied', onListenPermDenied);

        await userClient.addListeningChannel(allowedId);
        await sleep(600);

        userClient.off('permissionDenied', onListenPermDenied);

        expect(listenPermDenied).toBe(false);
        const sessionAfterListen = userClient.getStateManager().getSession();
        expect(sessionAfterListen?.listeningChannels).toContain(allowedId);

        // 清理
        await userClient.removeListeningChannel(allowedId);
        await adminClient.deleteChannel(allowedId);
        await sleep(200);
      } finally {
        await adminClient.disconnect();
        await userClient.disconnect();
        await observerClient.disconnect();
      }
    }, 30000);

    it('should deny second user from entering restricted channel', async () => {
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
          username: 'acl_op_user',
          password: 'acl_op_pass',
          rejectUnauthorized: false,
        });

        await sleep(500);

        // 创建禁止频道：拒绝所有用户进入
        const deniedName = 'ACLDenied_' + Date.now();
        const deniedId = await adminClient.createChannel(deniedName, 0);
        await sleep(300);

        await adminClient.addACLEntry(deniedId, {
          apply_here: true,
          apply_subs: false,
          group: 'acl_testers',
          allow: 0,
          deny: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Speak
            | PermissionFlag.Listen | PermissionFlag.Whisper | PermissionFlag.TextMessage,
        });
        await sleep(500);

        const channelBeforeAttempt = userClient.getStateManager().getSession()?.channel_id ?? 0;

        // 监听 permissionDenied 事件
        let enterDeniedReceived = false;
        const onPermDenied = () => { enterDeniedReceived = true; };
        userClient.on('permissionDenied', onPermDenied);

        await userClient.moveToChannel(deniedId);
        await sleep(800);

        userClient.off('permissionDenied', onPermDenied);

        // 第二个用户应该收到 permissionDenied，且仍在原频道
        expect(enterDeniedReceived).toBe(true);
        const channelAfterAttempt = userClient.getStateManager().getSession()?.channel_id ?? 0;
        expect(channelAfterAttempt).toBe(channelBeforeAttempt);

        // 清理
        await adminClient.deleteChannel(deniedId);
        await sleep(200);
      } finally {
        await adminClient.disconnect();
        await userClient.disconnect();
      }
    }, 30000);

    it('should suppress second user when speaking in channel without Speak permission', async () => {
      const adminClient = new MumbleClient();
      const userClient = new MumbleClient();
      const observerClient = new MumbleClient();

      try {
        await adminClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin',
          password: 'admin123',
          rejectUnauthorized: false,
          forceTcpVoice: true,
        });

        await userClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'acl_op_user',
          password: 'acl_op_pass',
          rejectUnauthorized: false,
          forceTcpVoice: true,
        });

        await observerClient.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'acl_op_observer',
          password: 'acl_op_obs_pass',
          rejectUnauthorized: false,
          forceTcpVoice: true,
        });

        await sleep(500);

        // 创建允许进入但禁止说话的频道
        const noSpeakName = 'ACLNoSpeak_' + Date.now();
        const noSpeakId = await adminClient.createChannel(noSpeakName, 0);
        await sleep(300);

        await adminClient.addACLEntry(noSpeakId, {
          apply_here: true,
          apply_subs: false,
          group: 'acl_testers',
          allow: PermissionFlag.Enter | PermissionFlag.Traverse,
          deny: PermissionFlag.Speak | PermissionFlag.Whisper,
        });
        await sleep(500);

        // observer 进入该频道
        await observerClient.moveToChannel(noSpeakId);
        await sleep(300);

        // 第二个用户进入无说话权限的频道，应被 suppress
        await userClient.moveToChannel(noSpeakId);
        await sleep(800);

        const userStateAfterMove = userClient.getStateManager().getSession();
        expect(userStateAfterMove?.channel_id).toBe(noSpeakId);
        expect(userStateAfterMove?.suppress).toBe(true); // 没有 Speak 权限，应被自动 suppress

        // 被 suppress 的用户发送语音，observer 不应收到
        const userSession = userClient.getStateManager().getSession()?.session ?? 0;
        let voiceReceivedWhileSuppressed = false;
        const onVoice = (data: VoiceData) => {
          if (data.session === userSession) voiceReceivedWhileSuppressed = true;
        };
        observerClient.on('voice', onVoice);

        const voicePacket = createVoicePacket(4, 0, 0);
        await userClient.getConnectionManager().sendVoicePacket(voicePacket);
        await sleep(1500);

        observerClient.off('voice', onVoice);
        expect(voiceReceivedWhileSuppressed).toBe(false);

        // 清理
        await adminClient.deleteChannel(noSpeakId);
        await sleep(200);
      } finally {
        await adminClient.disconnect();
        await userClient.disconnect();
        await observerClient.disconnect();
      }
    }, 30000);

    it('should deny second user from listening to restricted channel', async () => {
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
          username: 'acl_op_user',
          password: 'acl_op_pass',
          rejectUnauthorized: false,
        });

        await sleep(500);

        // 创建禁止监听的频道（禁止 Listen 权限）
        const noListenName = 'ACLNoListen_' + Date.now();
        const noListenId = await adminClient.createChannel(noListenName, 0);
        await sleep(300);

        await adminClient.addACLEntry(noListenId, {
          apply_here: true,
          apply_subs: false,
          group: 'acl_testers',
          allow: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Speak,
          deny: PermissionFlag.Listen,
        });
        await sleep(500);

        // 第二个用户尝试监听被限制的频道
        let listenDeniedReceived = false;
        const onPermDenied = () => { listenDeniedReceived = true; };
        userClient.on('permissionDenied', onPermDenied);

        await userClient.addListeningChannel(noListenId);
        await sleep(800);

        userClient.off('permissionDenied', onPermDenied);

        // 应收到 permissionDenied，且监听列表中不包含该频道
        expect(listenDeniedReceived).toBe(true);
        const sessionAfterAttempt = userClient.getStateManager().getSession();
        expect(sessionAfterAttempt?.listeningChannels).not.toContain(noListenId);

        // 清理
        await adminClient.deleteChannel(noListenId);
        await sleep(200);
      } finally {
        await adminClient.disconnect();
        await userClient.disconnect();
      }
    }, 30000);
  });
});
