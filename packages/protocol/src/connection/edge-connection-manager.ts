/**
 * Edge连接管理器
 * 
 * 统一管理所有Edge间的连接，支持UDP和TCP
 */

import type { Logger } from '@munode/common';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import type { IEdgeConnection } from './edge-connection-interface.js';
import { UDPEdgeConnection } from './udp-edge-connection.js';
import type { ConnectionConfig, ConnectionStatus } from './connection-types.js';
import { ConnectionType } from './connection-types.js';

/**
 * UDP发送函数类型
 */
type UDPSendFunction = (buffer: Buffer, host: string, port: number) => void;

/**
 * 端点信息
 */
interface EndpointInfo {
  edgeId: number;
  host: string;
  port: number;
  type: ConnectionType;
}

/**
 * EdgeConnectionManager 事件类型
 */
export interface EdgeConnectionManagerEvents extends EventMap {
  'edge-connected': [edgeId: number];
  'edge-disconnected': [edgeId: number, reason?: string];
  'edge-error': [edgeId: number, error: Error];
  'edge-data': [edgeId: number, data: Buffer, timestamp: number];
  'edge-reconnecting': [edgeId: number, attempt: number];
}

/**
 * EdgeConnectionManager 配置
 */
export interface EdgeConnectionManagerConfig {
  /** 本地Edge ID */
  localEdgeId: number;
  /** 共享密钥 */
  sharedSecret?: Buffer;
  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number;
  /** 连接超时（毫秒） */
  connectionTimeout?: number;
  /** 最大重连次数 */
  maxReconnectAttempts?: number;
  /** 重连延迟（毫秒） */
  reconnectDelay?: number;
  /** 连接策略：udp_only, tcp_only, 或 auto_fallback（默认: udp_only） */
  connectionStrategy?: import('./connection-types.js').ConnectionStrategy;
  /** 自动降级的质量阈值（仅在auto_fallback模式下使用） */
  fallbackThresholds?: {
    /** RTT阈值（毫秒），超过此值考虑降级 */
    maxRtt?: number;
    /** 丢包率阈值（0-1），超过此值考虑降级 */
    maxPacketLoss?: number;
    /** 连续失败次数，达到此值触发降级 */
    maxConsecutiveFailures?: number;
  };
}

/**
 * Edge连接管理器
 * 
 * 负责管理所有Edge间的连接，提供统一的接口
 */
export class EdgeConnectionManager extends TypedEventEmitter<EdgeConnectionManagerEvents> {
  private config: EdgeConnectionManagerConfig;
  private logger: Logger;
  private connections = new Map<number, IEdgeConnection>();
  private endpoints = new Map<number, EndpointInfo>();
  private udpSendFunction?: UDPSendFunction;
  private connectionFailures = new Map<number, number>(); // Track connection failures
  private connectionStrategy: import('./connection-types.js').ConnectionStrategy;

  constructor(config: EdgeConnectionManagerConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    
    // Import and set connection strategy
    const { ConnectionStrategy } = require('./connection-types.js');
    this.connectionStrategy = config.connectionStrategy || ConnectionStrategy.UDP_ONLY;
    
    this.logger.info(`EdgeConnectionManager initialized with strategy: ${this.connectionStrategy}`);
  }

  /**
   * 设置UDP发送函数（用于统一UDP入口模式）
   */
  setUDPSendFunction(sendFunc: UDPSendFunction): void {
    this.udpSendFunction = sendFunc;
    this.logger.info('EdgeConnectionManager using external UDP send function');

    // 重新发起所有已注册UDP端点的连接
    for (const [edgeId, endpoint] of this.endpoints) {
      if (endpoint.type === ConnectionType.UDP) {
        const conn = this.connections.get(edgeId);
        if (conn && !conn.isConnected) {
          this.logger.info(`Re-initiating connection to edge ${edgeId} after setUDPSendFunction`);
          void conn.connect();
        }
      }
    }
  }

  /**
   * 注册并连接到远程端点
   * 
   * @param edgeId Edge ID
   * @param host 主机地址
   * @param port 端口
   * @param type 连接类型（可选，将根据策略自动决定）
   */
  async registerEndpoint(
    edgeId: number,
    host: string,
    port: number,
    type?: ConnectionType
  ): Promise<void> {
    // 规范化主机名
    const normalizedHost = host === 'localhost' ? '127.0.0.1' : host;

    // 根据策略决定连接类型
    const effectiveType = type || this.determineConnectionType();
    
    // 保存端点信息
    this.endpoints.set(edgeId, {
      edgeId,
      host: normalizedHost,
      port,
      type: effectiveType,
    });

    this.logger.info(`Registering endpoint for edge ${edgeId}: ${normalizedHost}:${port} (${effectiveType}, strategy: ${this.connectionStrategy})`);

    // 创建连接
    const connection = await this.createConnection(edgeId, normalizedHost, port, effectiveType);
    if (!connection) {
      throw new Error(`Failed to create connection to edge ${edgeId}`);
    }

    this.connections.set(edgeId, connection);
    this.setupConnectionEvents(connection);

    // 发起连接
    await connection.connect();
  }

  /**
   * 根据策略决定初始连接类型
   */
  private determineConnectionType(): ConnectionType {
    const { ConnectionStrategy } = require('./connection-types.js');
    
    switch (this.connectionStrategy) {
      case ConnectionStrategy.TCP_ONLY:
        return ConnectionType.TCP;
      case ConnectionStrategy.UDP_ONLY:
      case ConnectionStrategy.AUTO_FALLBACK:
      default:
        return ConnectionType.UDP; // AUTO_FALLBACK starts with UDP
    }
  }

  /**
   * 移除端点
   */
  unregisterEndpoint(edgeId: number): void {
    const connection = this.connections.get(edgeId);
    if (connection) {
      connection.close();
      connection.removeAllListeners();
      this.connections.delete(edgeId);
    }

    this.endpoints.delete(edgeId);
    this.logger.info(`Unregistered endpoint for edge ${edgeId}`);
  }

  /**
   * 向指定Edge发送数据
   */
  async send(edgeId: number, data: Buffer): Promise<void> {
    const connection = this.connections.get(edgeId);
    if (!connection) {
      throw new Error(`No connection to edge ${edgeId}`);
    }

    if (!connection.isConnected) {
      throw new Error(`Connection to edge ${edgeId} is not established`);
    }

    await connection.send(data);
  }

  /**
   * 广播数据到所有已连接的Edge
   */
  async broadcast(data: Buffer, excludeEdges: Set<number> = new Set()): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [edgeId, connection] of this.connections) {
      if (excludeEdges.has(edgeId)) {
        continue;
      }

      if (connection.isConnected) {
        promises.push(connection.send(data).catch(error => {
          this.logger.error(`Failed to broadcast to edge ${edgeId}:`, error);
        }));
      }
    }

    await Promise.all(promises);
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(edgeId: number): ConnectionStatus | undefined {
    const connection = this.connections.get(edgeId);
    return connection?.getStatus();
  }

  /**
   * 获取所有连接状态
   */
  getAllConnectionStatuses(): Map<number, ConnectionStatus> {
    const statuses = new Map<number, ConnectionStatus>();
    for (const [edgeId, connection] of this.connections) {
      statuses.set(edgeId, connection.getStatus());
    }
    return statuses;
  }

  /**
   * 检查是否已连接到指定Edge
   */
  isConnected(edgeId: number): boolean {
    const connection = this.connections.get(edgeId);
    return connection?.isConnected ?? false;
  }

  /**
   * 获取已连接的Edge数量
   */
  getConnectedCount(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.isConnected) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取连接质量指标
   */
  getQualityMetrics(edgeId: number): import('./connection-types.js').ConnectionQualityMetrics | undefined {
    const connection = this.connections.get(edgeId);
    if (!connection) {
      return undefined;
    }
    
    // Both UDP and TCP connections have quality metrics
    if (connection.type === 'udp') {
      return (connection as unknown as import('./udp-edge-connection.js').UDPEdgeConnection).getQualityMetrics();
    } else if (connection.type === 'tcp') {
      return (connection as unknown as import('./tcp-edge-connection.js').TCPEdgeConnection).getQualityMetrics();
    }
    
    return undefined;
  }

  /**
   * 获取所有连接的质量指标
   */
  getAllQualityMetrics(): Map<number, import('./connection-types.js').ConnectionQualityMetrics> {
    const metrics = new Map<number, import('./connection-types.js').ConnectionQualityMetrics>();
    
    for (const [edgeId, connection] of this.connections) {
      if (connection.type === 'udp') {
        const quality = (connection as unknown as import('./udp-edge-connection.js').UDPEdgeConnection).getQualityMetrics();
        metrics.set(edgeId, quality);
      } else if (connection.type === 'tcp') {
        const quality = (connection as unknown as import('./tcp-edge-connection.js').TCPEdgeConnection).getQualityMetrics();
        metrics.set(edgeId, quality);
      }
    }
    
    return metrics;
  }

  /**
   * 处理接收到的UDP数据包
   * 根据包内容路由到对应的连接
   */
  handleIncomingUDPPacket(data: Buffer, host: string, port: number): void {
    // 找到匹配的连接
    for (const [edgeId, endpoint] of this.endpoints) {
      if (endpoint.type === ConnectionType.UDP &&
          endpoint.host === host &&
          endpoint.port === port) {
        const connection = this.connections.get(edgeId);
        if (connection && connection.type === 'udp') {
          (connection as UDPEdgeConnection).handleIncomingPacket(data);
          return;
        }
      }
    }

    this.logger.debug(`Received UDP packet from unknown endpoint: ${host}:${port}`);
  }

  /**
   * 停止所有连接
   */
  stop(): void {
    this.logger.info('Stopping EdgeConnectionManager, closing all connections');

    for (const connection of this.connections.values()) {
      connection.close();
      connection.removeAllListeners();
    }

    this.connections.clear();
    this.endpoints.clear();
  }

  /**
   * 创建连接实例
   */
  private async createConnection(
    edgeId: number,
    host: string,
    port: number,
    type: ConnectionType
  ): Promise<IEdgeConnection | null> {
    const connectionConfig: ConnectionConfig = {
      localEdgeId: this.config.localEdgeId,
      remoteEdgeId: edgeId,
      host,
      port,
      type,
      sharedSecret: this.config.sharedSecret,
      heartbeatInterval: this.config.heartbeatInterval,
      connectionTimeout: this.config.connectionTimeout,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      reconnectDelay: this.config.reconnectDelay,
    };

    switch (type) {
      case ConnectionType.UDP:
        if (!this.udpSendFunction) {
          this.logger.warn(`UDP send function not set, connection to edge ${edgeId} will be delayed`);
          // 创建连接但不立即connect，等待setUDPSendFunction
          return new UDPEdgeConnection(
            connectionConfig,
            this.udpSendFunction || (() => {}),
            this.logger
          );
        }
        return new UDPEdgeConnection(connectionConfig, this.udpSendFunction, this.logger);

      case ConnectionType.TCP:
        // Import TCPEdgeConnection dynamically
        const { TCPEdgeConnection } = await import('./tcp-edge-connection.js');
        return new TCPEdgeConnection(connectionConfig, this.logger);

      default:
        this.logger.error(`Unknown connection type: ${type}`);
        return null;
    }
  }

  /**
   * 设置连接事件监听
   */
  private setupConnectionEvents(connection: IEdgeConnection): void {
    connection.on('connected', () => {
      this.logger.info(`Edge ${connection.edgeId} connected via ${connection.type.toUpperCase()}`);
      // 重置失败计数
      this.connectionFailures.set(connection.edgeId, 0);
      this.emit('edge-connected', connection.edgeId);
    });

    connection.on('disconnected', (reason) => {
      this.logger.warn(`Edge ${connection.edgeId} disconnected: ${reason || 'unknown'}`);
      this.emit('edge-disconnected', connection.edgeId, reason);
      
      // 处理自动降级
      void this.handleConnectionFailure(connection.edgeId);
    });

    connection.on('error', (error) => {
      this.logger.error(`Edge ${connection.edgeId} error:`, error);
      this.emit('edge-error', connection.edgeId, error);
      
      // 处理自动降级
      void this.handleConnectionFailure(connection.edgeId);
    });

    connection.on('data', (data, timestamp) => {
      this.logger.debug(`Received data from edge ${connection.edgeId}, size: ${data.length}`);
      this.emit('edge-data', connection.edgeId, data, timestamp);
    });

    connection.on('reconnecting', (attempt) => {
      this.logger.info(`Edge ${connection.edgeId} reconnecting (attempt ${attempt})`);
      this.emit('edge-reconnecting', connection.edgeId, attempt);
    });
  }

  /**
   * 处理连接失败，实现自动降级逻辑
   */
  private async handleConnectionFailure(edgeId: number): Promise<void> {
    const { ConnectionStrategy } = require('./connection-types.js');
    
    // 只在AUTO_FALLBACK模式下处理降级
    if (this.connectionStrategy !== ConnectionStrategy.AUTO_FALLBACK) {
      return;
    }
    
    const connection = this.connections.get(edgeId);
    const endpoint = this.endpoints.get(edgeId);
    
    if (!connection || !endpoint) {
      return;
    }
    
    // 增加失败计数
    const failures = (this.connectionFailures.get(edgeId) || 0) + 1;
    this.connectionFailures.set(edgeId, failures);
    
    // 检查是否需要降级
    const thresholds = this.config.fallbackThresholds || {};
    const maxFailures = thresholds.maxConsecutiveFailures || 3;
    
    if (failures >= maxFailures && connection.type === 'udp') {
      this.logger.warn(
        `Edge ${edgeId} UDP connection failed ${failures} times, falling back to TCP`
      );
      
      // 关闭UDP连接
      connection.close();
      connection.removeAllListeners();
      
      // 创建TCP连接
      try {
        const tcpConnection = await this.createConnection(
          edgeId,
          endpoint.host,
          endpoint.port,
          ConnectionType.TCP
        );
        
        if (tcpConnection) {
          this.connections.set(edgeId, tcpConnection);
          this.endpoints.set(edgeId, { ...endpoint, type: ConnectionType.TCP });
          this.setupConnectionEvents(tcpConnection);
          await tcpConnection.connect();
          
          this.logger.info(`Edge ${edgeId} successfully fell back to TCP`);
        }
      } catch (error) {
        this.logger.error(`Failed to fallback to TCP for edge ${edgeId}:`, error);
      }
    }
  }
}
