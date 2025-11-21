/**
 * 集成测试辅助函数
 */

import * as tls from 'tls';
import * as fs from 'fs';
import { join } from 'path';
import { mumbleproto } from '@munode/protocol';
import { MessageType } from './fixtures';
import { MumbleClient } from '../../../packages/client/dist/index.js';

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
  const certsDir = join(__dirname, 'certs');
  
  return {
    cert: fs.readFileSync(join(certsDir, 'server.pem')),
    key: fs.readFileSync(join(certsDir, 'server.key')),
    ca: fs.readFileSync(join(certsDir, 'ca.pem')),
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

/**
 * 使用 MumbleClient 创建连接并认证
 */
export async function createAuthenticatedClient(
  host: string,
  port: number,
  username: string,
  password: string
): Promise<any> {
  // 动态导入以避免构建依赖问题
  const { MumbleClient } = await import('../../../packages/client/dist/index.js');
  
  const client = new MumbleClient();
  
  await client.connect({
    host,
    port,
    username,
    password,
  });
  
  // 等待连接和认证完成
  await new Promise<void>((resolve, reject) => {
    const onConnected = () => {
      client.off('connected', onConnected);
      resolve();
    };
    
    const onError = (error: any) => {
      client.off('error', onError);
      reject(error);
    };
    
    client.on('connected', onConnected);
    client.on('error', onError);
    
    // 超时
    setTimeout(() => {
      client.off('connected', onConnected);
      client.off('error', onError);
      reject(new Error('Connection timeout'));
    }, 10000);
  });
  
  return client;
}

/**
 * 认证 Mumble 连接 (低级 API)
 */
export async function authenticateConnection(
  connection: MumbleConnection,
  username: string,
  password: string
): Promise<number> {
  // 创建认证消息
  const auth = mumbleproto.Authenticate.fromObject({
    username,
    password,
    tokens: [],
    celt_versions: [0x8000000b],
    opus: true,
  });

  // 发送认证消息
  const authData = Buffer.from(auth.serialize());
  connection.send(MessageType.Authenticate, authData);

  // 等待服务器同步消息
  const response = await connection.receive();
  if (response.type !== MessageType.ServerSync) {
    throw new Error(`Expected ServerSync, got message type ${response.type}`);
  }

  const serverSync = mumbleproto.ServerSync.deserialize(response.data);
  return serverSync.session;
}
