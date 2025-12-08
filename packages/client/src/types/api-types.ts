/**
 * API Types - API 相关类型定义
 */

import type { MumbleClient } from '../core/mumble-client.js';

/**
 * API 请求参数类型
 */
export interface ConnectParams {
  host: string;
  username: string;
  port?: number;
  password?: string;
  tokens?: string[];
}

export interface JoinChannelParams {
  channelId: number;
}

export interface SendMessageParams {
  message: string;
  target: string | number;
}

export interface AddListeningChannelParams {
  id: number;
}

export interface QueryACLParams {
  channelId: number;
}

export interface SaveACLParams {
  channelId: number;
  acl: object; // 更精确的类型待定义
}

export interface CheckPermissionParams {
  channelId: number;
  permission: number;
  userSession?: number;
}

export interface GetUserPermissionsParams {
  channelId: number;
  userSession?: number;
}

export interface AddACLEntryParams {
  channelId: number;
  entry: object; // 更精确的类型待定义
}

export interface RemoveACLEntryParams {
  channelId: number;
  index: number;
}

export interface UpdateACLEntryParams {
  channelId: number;
  index: number;
  updates: object; // 更精确的类型待定义
}

export interface CreateChannelGroupParams {
  channelId: number;
  groupName: string;
}

export interface DeleteChannelGroupParams {
  channelId: number;
  groupName: string;
}

/**
 * API 请求
 */
export interface ApiRequest<TParams = object> {
  /** 操作名称 */
  action: string;
  
  /** 请求参数 */
  params: TParams;
  
  /** 请求 ID (可选) */
  id?: string;
}

/**
 * 空参数类型（保留用于向后兼容）
 */
export interface EmptyParams {
  [key: string]: never;
}

/**
 * API 响应数据类型
 */
export interface ResponseData {
  [key: string]: string | number | boolean | object | null | undefined;
}

/**
 * API 响应
 */
export interface ApiResponse {
  /** 是否成功 */
  success: boolean;
  
  /** 响应数据 */
  data?: ResponseData;
  
  /** 错误信息 */
  error?: {
    code: string;
    message: string;
  };
  
  /** 请求 ID */
  id?: string;
}

/**
 * API 元数据类型
 */
export interface ApiMetadata {
  [key: string]: string | number | boolean;
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
  metadata?: ApiMetadata;
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
 * WebSocket 消息数据
 */
export interface WebSocketMessageData {
  [key: string]: string | number | boolean | object | null | undefined;
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
  data?: WebSocketMessageData;
  
  /** 是否成功 (response 类型) */
  success?: boolean;
  
  /** 错误信息 (response 类型) */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Webhook HTTP 请求头
 */
export interface WebhookHeaders {
  [key: string]: string;
}

/**
 * Webhook 事件数据
 */
export interface WebhookEventData {
  [key: string]: string | number | boolean | object | null;
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
  data: WebhookEventData;
}

/**
 * 业务处理器接口
 */
export interface BusinessHandler<TParams = object, TResult = object | void> {
  /** 执行业务逻辑 */
  execute(params: TParams, context: ApiContext): Promise<TResult>;
}
