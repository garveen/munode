/**
 * ApiContext - API 执行上下文
 * 
 * 提供给业务处理器的上下文信息
 */

import type { MumbleClient } from '../core/mumble-client.js';

export interface ApiContext {
  /** 客户端实例 */
  client: MumbleClient;
  
  /** 请求来源 */
  source: 'http' | 'websocket' | 'node';
  
  /** 认证信息 (可选) */
  auth?: {
    token?: string;
    userId?: string;
  };
  
  /** 请求 ID (用于追踪) */
  requestId?: string;
  
  /** 额外的元数据 */
  metadata?: Record<string, any>;
}
