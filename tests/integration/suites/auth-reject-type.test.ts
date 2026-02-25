/**
 * 认证失败 Reject 类型集成测试
 *
 * 根据 Mumble 协议（参考 murmur Messages.cpp），当密码验证失败时，服务器必须发送
 * WrongUserPW (3) 类型的 Reject 消息，Mumble 客户端收到后才会弹出"重新输入密码"
 * 对话框，而不是直接断开连接。
 *
 * 若服务器发送 None (0)，客户端会静默断开，不提示用户重试。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, USE_RUST } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';
import type { AuthenticationFailedInfo } from '../../../packages/client/src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 使用 MumbleClient 尝试认证，捕获 authenticationFailed 事件信息。
 * 当密码错误时 connect() 会 throw，同时 authenticationFailed 事件携带 Reject 详情。
 */
async function getRejectInfo(
  port: number,
  username: string,
  password: string,
): Promise<AuthenticationFailedInfo> {
  const client = new MumbleClient();

  let captured: AuthenticationFailedInfo | null = null;
  client.on('authenticationFailed', (info) => {
    captured = info;
  });

  try {
    await client.connect({
      host: '127.0.0.1',
      port,
      username,
      password,
      rejectUnauthorized: false,
    });
    // 若意外成功则断开
    await client.disconnect();
    throw new Error(`Expected authentication to fail for user "${username}" but it succeeded`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Expected authentication')) {
      throw err;
    }
    // 认证失败是预期行为
  }

  if (!captured) {
    throw new Error('authenticationFailed event was not emitted');
  }
  return captured;
}

describe('Auth Reject Type Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8098);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should emit WrongUserPW (3) when registered user provides wrong password', async () => {
    const info = await getRejectInfo(testEnv.edgePort, 'admin', 'wrongpassword');

    expect(info.reason).toBeTruthy();

    if (USE_RUST) {
      expect(info.type, `Expected WrongUserPW(3), got type=${info.type} reason="${info.reason}"`).toBe(3);
    } else {
      expect(info.type, `Expected non-None reject type, got type=${info.type} reason="${info.reason}"`).not.toBe(0);
    }
  });

  it('should emit non-None reject when non-existent user tries to authenticate', async () => {
    const info = await getRejectInfo(testEnv.edgePort, 'nonexistent_user_xyz', 'anypassword');

    if (USE_RUST) {
      // 不存在的用户 → HTTP 401 → Hub 映射为 WrongUserPW (3)
      expect(info.type, `Expected WrongUserPW(3) for unknown user, got type=${info.type} reason="${info.reason}"`).toBe(3);
    } else {
      expect(info.type, `Expected non-None reject type, got type=${info.type}`).not.toBe(0);
    }
  });

  it('should emit WrongUserPW for multiple test users with wrong password', async () => {
    const testUsers = [
      { username: 'user1', wrongPassword: 'notpassword1' },
      { username: 'user2', wrongPassword: 'notpassword2' },
      { username: 'guest',  wrongPassword: 'notguest123' },
    ];

    for (const user of testUsers) {
      const info = await getRejectInfo(testEnv.edgePort, user.username, user.wrongPassword);

      if (USE_RUST) {
        expect(
          info.type,
          `User ${user.username}: Rust should return WrongUserPW(3), got type=${info.type} reason="${info.reason}"`,
        ).toBe(3);
      } else {
        expect(
          info.type,
          `User ${user.username}: should not return None(0), got type=${info.type}`,
        ).not.toBe(0);
      }

      await sleep(100);
    }
  });

  it('should authenticate successfully with correct credentials', async () => {
    const client = new MumbleClient();

    await client.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'admin',
      password: 'admin123',
      rejectUnauthorized: false,
    });

    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });
});
