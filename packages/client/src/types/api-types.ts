/**
 * API Types - API 相关类型定义
 */

import type { MumbleClient } from '../core/mumble-client.js';

/**
 * API 请求
 */
export interface ApiRequest {
  /** 操作名称 */
  action: string;
  
  /** 请求参数 */
  params: any;
  
  /** 请求 ID (可选) */
  id?: string;
}

/**
 * API 响应
 */
export interface ApiResponse {
  /** 是否成功 */
  success: boolean;
  
  /** 响应数据 */
  data?: any;
  
  /** 错误信息 */
  error?: {
    code: string;
    message: string;
  };
  
  /** 请求 ID */
  id?: string;
}

/**
 * API 执行上下文
 */
export interface ApiContext {
  /** 客户端实例 */
  client: MumbleClient;
  
  /** 请求来源 */
  source: 'http' | 'websocket' | 'node';
  
  /** 认证信息 */
  auth?: {
    token?: string;
    userId?: string;
  };
  
  /** 请求 ID */
  requestId?: string;
  
  /** 元数据 */
  metadata?: Record<string, any>;
}

/**
 * HTTP 服务器选项
 */
export interface HttpServerOptions {
  /** 监听主机 */
  host: string;
  
  /** 监听端口 */
  port: number;
  
  /** 是否启用 CORS */
  cors?: boolean;
  
  /** 日志选项 */
  logger?: boolean;
  
  /** 认证 Token */
  authToken?: string;
}

/**
 * WebSocket 服务器选项
 */
export interface WebSocketOptions {
  /** 监听端口 */
  port: number;
  
  /** WebSocket 路径 */
  path?: string;
  
  /** 认证 Token */
  authToken?: string;
}

/**
 * WebSocket 消息
 */
export interface WebSocketMessage {
  /** 消息类型 */
  type: 'command' | 'response' | 'event';
  
  /** 消息 ID (用于请求-响应匹配) */
  id?: string;
  
  /** 操作名称 (command 类型) */
  action?: string;
  
  /** 事件名称 (event 类型) */
  event?: string;
  
  /** 消息数据 */
  data?: any;
  
  /** 是否成功 (response 类型) */
  success?: boolean;
  
  /** 错误信息 (response 类型) */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Webhook 配置
 */
export interface WebhookConfig {
  /** Webhook URL */
  url: string;
  
  /** 订阅的事件列表 */
  events: string[];
  
  /** HTTP 方法 */
  method?: 'POST' | 'PUT';
  
  /** 自定义请求头 */
  headers?: Record<string, string>;
  
  /** 重试次数 */
  retry?: number;
  
  /** 是否批量发送 */
  batch?: boolean;
  
  /** 批量发送间隔 (ms) */
  batchInterval?: number;
}

/**
 * Webhook 负载
 */
export interface WebhookPayload {
  /** 事件名称 */
  event: string;
  
  /** 时间戳 */
  timestamp: number;
  
  /** 事件数据 */
  data: any;
}

/**
 * 业务处理器接口
 */
export interface BusinessHandler {
  /** 执行业务逻辑 */
  execute(params: any, context: ApiContext): Promise<any>;
}
