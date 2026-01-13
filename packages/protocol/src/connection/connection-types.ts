/**
 * 连接层类型定义
 * 
 * 定义Edge间连接的基础类型和接口
 */

/**
 * 连接状态
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed',
}

/**
 * 连接类型
 */
export enum ConnectionType {
  UDP = 'udp',
  TCP = 'tcp',
}

/**
 * 连接策略
 */
export enum ConnectionStrategy {
  /** 只使用UDP */
  UDP_ONLY = 'udp_only',
  /** 只使用TCP */
  TCP_ONLY = 'tcp_only',
  /** 优先UDP，失败时降级到TCP */
  AUTO_FALLBACK = 'auto_fallback',
}

/**
 * 连接统计信息
 */
export interface ConnectionStats {
  /** 发送的包数量 */
  packetsSent: number;
  /** 接收的包数量 */
  packetsReceived: number;
  /** 发送的字节数 */
  bytesSent: number;
  /** 接收的字节数 */
  bytesReceived: number;
  /** 错误计数 */
  errors: number;
  /** 最后活跃时间 */
  lastActive: number;
}

/**
 * 连接状态信息
 */
export interface ConnectionStatus {
  /** Edge ID */
  edgeId: number;
  /** 连接状态 */
  state: ConnectionState;
  /** 连接类型 */
  type: ConnectionType;
  /** 是否已连接 */
  isConnected: boolean;
  /** 最后见到的时间戳 */
  lastSeen: number;
  /** 连接建立时间 */
  connectedAt?: number;
  /** 统计信息 */
  stats: ConnectionStats;
  /** 重连尝试次数 */
  reconnectAttempts: number;
}

/**
 * 连接配置
 */
export interface ConnectionConfig {
  /** 本地Edge ID */
  localEdgeId: number;
  /** 远程Edge ID */
  remoteEdgeId: number;
  /** 远程主机地址 */
  host: string;
  /** 远程端口 */
  port: number;
  /** 连接类型 */
  type: ConnectionType;
  /** 共享密钥（用于握手认证） */
  sharedSecret?: Buffer;
  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number;
  /** 连接超时（毫秒） */
  connectionTimeout?: number;
  /** 最大重连次数 */
  maxReconnectAttempts?: number;
  /** 重连延迟（毫秒） */
  reconnectDelay?: number;
}

/**
 * 连接事件数据
 */
export interface ConnectionEventData {
  edgeId: number;
  timestamp: number;
}

/**
 * 连接错误事件数据
 */
export interface ConnectionErrorData extends ConnectionEventData {
  error: Error;
  fatal: boolean;
}

/**
 * 数据接收事件数据
 */
export interface DataReceivedData extends ConnectionEventData {
  data: Buffer;
  sequence?: number;
}

/**
 * 连接质量指标
 * 
 * 由连接层收集和计算，暴露给上层使用
 */
export interface ConnectionQualityMetrics {
  /** Edge ID */
  edgeId: number;
  /** 往返时间（毫秒） */
  rtt: number;
  /** 丢包率（0-1） */
  packetLoss: number;
  /** 抖动（毫秒） */
  jitter: number;
  /** 最后更新时间 */
  lastUpdate: number;
  /** 样本数量 */
  samples: number;
  /** 带宽（bytes/sec） */
  bandwidth: {
    upload: number;
    download: number;
  };
}
