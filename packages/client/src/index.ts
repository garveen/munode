/**
 * @munode/client - Entry Point
 * 
 * 导出所有公共 API
 */

// 核心客户端
export { MumbleClient } from './core/mumble-client.js';

// 连接和认证
export { ConnectionState } from './core/connection.js';

// 音频处理
export { OpusEncoder } from './audio/encoder.js';
export { OpusDecoder, AudioDecoderFactory } from './audio/decoder.js';
export { AudioFormatConverter } from './audio/format.js';

// 事件
export { ClientEvents } from './events/event-emitter.js';

// API 服务器
export { startHttpServer } from './api/http-server.js';
export { startWebSocketServer } from './api/websocket.js';

// 类型定义
export type * from './types/client-types.js';
export type * from './types/audio-types.js';
export type * from './types/api-types.js';
