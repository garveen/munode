// 基础配置类型
export interface BaseServerConfig {
  serverId: number;
  name: string;
  host: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// TLS 配置
export interface TLSConfig {
  cert: string;
  key: string;
  ca?: string;
  requireClientCert: boolean;
  rejectUnauthorized: boolean;
}

// 服务器连接类型
export type ConnectionType = 'smux' | 'websocket';

// SMUX 选项
export interface SmuxOptions {
  maxStreamWindowSize?: number;
  maxSessionWindowSize?: number;
  keepaliveInterval?: number;
  streamOpenTimeout?: number;
}

// 连接配置
export interface ConnectionConfig {
  type: ConnectionType;
  host: string;
  port: number;
  tls?: TLSConfig;
  options?: SmuxOptions;
}
