/**
 * 集成测试辅助函数
 */

import * as tls from 'tls';
import * as fs from 'fs';
import { join } from 'path';

export interface MumbleConnection {
  socket: tls.TLSSocket;
  send: (messageType: number, data: Buffer) => void;
  receive: () => Promise<{ type: number; data: Buffer }>;
  close: () => void;
}

/**
 * 创建到 Mumble 服务器的 TLS 连接
 */
export async function createMumbleConnection(
  host: string,
  port: number
): Promise<MumbleConnection> {
  const socket = tls.connect({
    host,
    port,
    rejectUnauthorized: false, // 测试环境允许自签名证书
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve());
    socket.once('error', reject);
  });

  const send = (messageType: number, data: Buffer) => {
    const header = Buffer.alloc(6);
    header.writeUInt16BE(messageType, 0);
    header.writeUInt32BE(data.length, 2);
    socket.write(Buffer.concat([header, data]));
  };

  const receive = (): Promise<{ type: number; data: Buffer }> => {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        if (chunk.length < 6) {
          socket.once('data', (nextChunk: Buffer) => {
            onData(Buffer.concat([chunk, nextChunk]));
          });
          return;
        }

        const type = chunk.readUInt16BE(0);
        const length = chunk.readUInt32BE(2);
        const data = chunk.slice(6, 6 + length);

        socket.off('data', onData);
        socket.off('error', reject);
        resolve({ type, data });
      };

      socket.once('data', onData);
      socket.once('error', reject);
    });
  };

  const close = () => {
    socket.end();
  };

  return { socket, send, receive, close };
}

/**
 * 读取测试用的证书文件
 */
export function loadTestCerts(): { cert: Buffer; key: Buffer; ca?: Buffer } {
  const certsDir = join(__dirname, '../../certs');
  
  return {
    cert: fs.readFileSync(join(certsDir, 'cert.pem')),
    key: fs.readFileSync(join(certsDir, 'key.pem')),
  };
}

/**
 * 生成随机用户名
 */
export function generateUsername(prefix = 'test_user'): string {
  return `${prefix}_${Math.random().toString(36).substring(7)}`;
}

/**
 * 生成随机频道名
 */
export function generateChannelName(prefix = 'test_channel'): string {
  return `${prefix}_${Math.random().toString(36).substring(7)}`;
}

/**
 * 等待特定条件成立
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error('Timeout waiting for condition');
}

/**
 * 断言数组包含特定元素
 */
export function assertIncludes<T>(
  array: T[],
  element: T,
  message?: string
): void {
  if (!array.includes(element)) {
    throw new Error(message || `Expected array to include ${element}`);
  }
}

/**
 * 断言对象部分匹配
 */
export function assertPartialMatch<T extends object>(
  actual: T,
  expected: Partial<T>,
  message?: string
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key as keyof T] !== value) {
      throw new Error(
        message ||
          `Expected ${key} to be ${value}, but got ${actual[key as keyof T]}`
      );
    }
  }
}
