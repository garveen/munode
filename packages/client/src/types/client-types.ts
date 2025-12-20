/**
 * Client Types - 客户端相关类型定义
 */

/**
 * 连接选项
 */
export interface ConnectOptions {
  /** 服务器地址 */
  host: string;
  
  /** 服务器 TCP/TLS 端口 */
  port?: number;
  
  /** UDP 端口（如果未指定，默认使用 TCP 端口；某些实现使用 TCP+1） */
  udpPort?: number;
  
  /** 用户名 */
  username: string;
  
  /** 密码 */
  password?: string;
  
  /** 访问令牌 */
  tokens?: string[];
  
  /** 客户端证书 */
  clientCert?: Buffer;
  
  /** 客户端私钥 */
  clientKey?: Buffer;
  
  /** 是否验证服务器证书 */
  rejectUnauthorized?: boolean;
  
  /** 连接超时 (毫秒) */
  connectTimeout?: number;
  
  /** 强制使用TCP传输语音（而非UDP） */
  forceTcpVoice?: boolean;
  
  /** PreConnect 状态 - 在认证前设置的用户状态（如 self_deaf, self_mute） */
  preConnectState?: {
    self_mute?: boolean;
    self_deaf?: boolean;
  };
}

/**
 * 客户端配置
 */
export interface ClientConfig {
  /** 连接配置 */
  connection: {
    host: string;
    port: number;
    autoReconnect: boolean;
    reconnectDelay: number;
    reconnectMaxDelay: number;
    connectTimeout: number;
  };
  
  /** 认证配置 */
  auth: {
    username: string;
    password?: string;
    tokens?: string[];
    certificate?: string;
    key?: string;
  };
  
  /** 音频配置 */
  audio: {
    encoder: {
      codec: 'opus';
      bitrate: number;
      frameSize: number;
      vbr: boolean;
    };
    decoder: {
      codecs: string[];
      autoDetect: boolean;
    };
    inputSampleRate: number;
    outputSampleRate: number;
  };
  
  /** API 配置 */
  api: {
    http: {
      enabled: boolean;
      host: string;
      port: number;
      cors: boolean;
    };
    websocket: {
      enabled: boolean;
      path: string;
    };
  };
  
  /** Webhook 配置 */
  webhooks: WebhookConfig[];
  
  /** 日志配置 */
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    file?: string;
  };
}

/**
 * Webhook 配置
 */
export interface WebhookConfig {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  method?: 'POST' | 'PUT';
  headers?: {
    [key: string]: string;
  };
  retry?: number;
  batch?: boolean;
  batchInterval?: number;
}

/**
 * 频道信息
 */
export interface Channel {
  channel_id: number;
  parent: number;
  name: string;
  description?: string;
  temporary: boolean;
  position: number;
  links: number[];
  max_users: number;
  children: number[];
}

/**
 * 用户状态更新参数
 */
export interface UserStateUpdate {
  session?: number;
  channel_id?: number;
  mute?: boolean;
  deaf?: boolean;
  suppress?: boolean;
  self_mute?: boolean;
  self_deaf?: boolean;
  priority_speaker?: boolean;
  recording?: boolean;
}

/**
 * 频道状态更新参数
 */
export interface ChannelStateUpdate {
  channel_id?: number;
  parent?: number;
  name?: string;
  description?: string;
  position?: number;
  temporary?: boolean;
  max_users?: number;
  links?: number[];
  links_add?: number[];
  links_remove?: number[];
}

/**
 * ACL 条目更新参数
 */
export interface ACLEntryUpdate {
  apply_here?: boolean;
  apply_subs?: boolean;
  inherited?: boolean;
  user_id?: number;
  group?: string;
  grant?: number;
  deny?: number;
}

/**
 * 客户端配置更新参数
 */
export interface ClientConfigUpdate {
  connection?: {
    host?: string;
    port?: number;
    autoReconnect?: boolean;
    reconnectDelay?: number;
    reconnectMaxDelay?: number;
    connectTimeout?: number;
  };
  
  auth?: {
    username?: string;
    password?: string;
    tokens?: string[];
    certificate?: string;
    key?: string;
  };
  
  audio?: {
    encoder?: {
      codec?: 'opus';
      bitrate?: number;
      frameSize?: number;
      vbr?: boolean;
    };
    decoder?: {
      codecs?: string[];
      autoDetect?: boolean;
    };
    inputSampleRate?: number;
    outputSampleRate?: number;
  };
  
  api?: {
    http?: {
      enabled?: boolean;
      host?: string;
      port?: number;
      cors?: boolean;
    };
    websocket?: {
      enabled?: boolean;
      path?: string;
    };
  };
  
  webhooks?: WebhookConfig[];
  
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    file?: string;
  };
}

/**
 * 用户信息
 */
export interface User {
  session: number;
  user_id?: number;
  name: string;
  channel_id: number;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
  self_mute: boolean;
  self_deaf: boolean;
  recording: boolean;
  priority_speaker: boolean;
  hash?: string;
  comment?: string;
  texture?: Buffer;
}

/**
 * 服务器信息
 */
export interface ServerInfo {
  version: number;
  release: string;
  os: string;
  maxBandwidth: number;
  maxUsers: number;
  welcomeText: string;
  allowHtml: boolean;
  messageLength: number;
}

/**
 * 会话状态
 */
export interface SessionState {
  session: number;
  channel_id: number;
  mute: boolean;
  deaf: boolean;
  self_mute: boolean;
  self_deaf: boolean;
  suppress: boolean;
  recording: boolean;
  priority_speaker: boolean;
  listeningChannels: number[];
}

/**
 * 消息目标
 */
export interface MessageTarget {
  /** 频道 ID */
  channelId?: number;
  
  /** 用户 session */
  userId?: number;
  
  /** 是否发送到频道树 */
  tree?: boolean;
}

/**
 * 客户端事件数据
 */
export interface ClientEventData {
  [key: string]: string | number | boolean | object | null | undefined;
}

/**
 * 客户端事件
 */
export interface ClientEvent {
  type: string;
  timestamp: number;
  data: ClientEventData;
}

/**
 * 事件过滤器
 */
export type EventFilter = (event: ClientEvent) => boolean;
