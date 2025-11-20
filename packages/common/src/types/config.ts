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
export type ConnectionType = 'smux' | 'grpc' | 'kcp';

// SMUX 选项
export interface SmuxOptions {
  maxStreamWindowSize?: number;
  maxSessionWindowSize?: number;
  keepaliveInterval?: number;
  streamOpenTimeout?: number;
}

// gRPC 选项
export interface GrpcOptions {
  maxConcurrentStreams?: number;
  keepaliveTimeMs?: number;
  maxReceiveMessageLength?: number;
  maxSendMessageLength?: number;
}

// KCP 选项
export interface KcpOptions {
  nodelay?: number;
  interval?: number;
  resend?: number;
  nc?: number;
  sndwnd?: number;
  rcvwnd?: number;
  mtu?: number;
  fec?: {
    dataShards: number;
    parityShards: number;
  };
}

// 连接配置
export interface ConnectionConfig {
  type: ConnectionType;
  host: string;
  port: number;
  tls?: TLSConfig;
  options: SmuxOptions | GrpcOptions | KcpOptions;
}
