/**
 * Node.js API
 * 
 * 主要职责:
 * - 导出 MumbleClient 类供 Node.js 直接使用
 * - 提供便捷的 API 函数
 * - 类型定义导出
 */

import { MumbleClient } from '../core/mumble-client.js';
import type { ClientConfig, ConnectOptions } from '../types/client-types.js';

export { MumbleClient };
export { ConnectionManager, ConnectionState } from '../core/connection.js';
export { AuthManager } from '../core/auth.js';
export { StateManager } from '../core/state.js';
export { CryptoManager } from '../core/crypto.js';

// 音频相关
export { OpusEncoder } from '../audio/encoder.js';
export { OpusDecoder, AudioDecoderFactory } from '../audio/decoder.js';
export { AudioStreamManager, AudioInputStream, AudioMixer } from '../audio/stream.js';
export { AudioFormatConverter } from '../audio/format.js';

// API 相关
export { startHttpServer, HttpServer } from './http-server.js';
export { startWebSocketServer, MumbleWebSocketServer } from './websocket.js';

// 类型定义
export type * from '../types/client-types.js';
export type * from '../types/audio-types.js';
export type * from '../types/api-types.js';

/**
 * 创建客户端的便捷函数
 */
export function createClient(config?: Partial<ClientConfig>): MumbleClient {
  return new MumbleClient(config);
}

/**
 * 快速连接到服务器的便捷函数
 */
export async function quickConnect(options: ConnectOptions): Promise<MumbleClient> {
  const client = createClient();
  await client.connect(options);
  return client;
}
