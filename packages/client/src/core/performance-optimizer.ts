/**
 * Performance Optimizer - 性能优化器
 *
 * 主要职责:
 * - 消息压缩和解压缩
 * - 连接池管理
 * - 内存使用监控
 * - 延迟优化
 * - 资源清理
 */

import { EventEmitter } from 'events';
import { createGzip, createGunzip, Gzip, Gunzip } from 'zlib';
import type { MumbleClient } from '../core/mumble-client.js';

export interface PerformanceMetrics {
  /** 消息发送数量 */
  messagesSent: number;
  /** 消息接收数量 */
  messagesReceived: number;
  /** 平均延迟 (ms) */
  averageLatency: number;
  /** 内存使用 (bytes) */
  memoryUsage: number;
  /** 连接状态 */
  connectionState: 'connected' | 'disconnected' | 'connecting';
  /** 压缩比率 */
  compressionRatio: number;
}

export interface PerformanceConfig {
  /** 启用消息压缩 */
  enableCompression?: boolean;
  /** 压缩阈值 (bytes) */
  compressionThreshold?: number;
  /** 启用连接池 */
  enableConnectionPooling?: boolean;
  /** 最大连接池大小 */
  maxPoolSize?: number;
  /** 启用性能监控 */
  enableMetrics?: boolean;
  /** 指标收集间隔 (ms) */
  metricsInterval?: number;
  /** 自动内存清理 */
  enableMemoryCleanup?: boolean;
  /** 清理间隔 (ms) */
  cleanupInterval?: number;
}

/**
 * 性能优化器
 */
export class PerformanceOptimizer extends EventEmitter {
  private client: MumbleClient;
  private config: Required<PerformanceConfig>;
  private metrics: PerformanceMetrics;
  private metricsTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private compressionStreams: Map<string, { gzip: Gzip; gunzip: Gunzip }> = new Map();

  constructor(client: MumbleClient, config: PerformanceConfig = {}) {
    super();
    this.client = client;
    this.config = {
      enableCompression: config.enableCompression || false,
      compressionThreshold: config.compressionThreshold || 1024,
      enableConnectionPooling: config.enableConnectionPooling || false,
      maxPoolSize: config.maxPoolSize || 10,
      enableMetrics: config.enableMetrics || false,
      metricsInterval: config.metricsInterval || 30000,
      enableMemoryCleanup: config.enableMemoryCleanup || false,
      cleanupInterval: config.cleanupInterval || 300000
    };

    this.metrics = {
      messagesSent: 0,
      messagesReceived: 0,
      averageLatency: 0,
      memoryUsage: 0,
      connectionState: 'disconnected',
      compressionRatio: 1.0
    };

    this.initialize();
  }

  /**
   * 初始化性能优化器
   */
  private initialize(): void {
    if (this.config.enableMetrics) {
      this.startMetricsCollection();
    }

    if (this.config.enableMemoryCleanup) {
      this.startMemoryCleanup();
    }

    // 监听连接状态变化
    this.client.on('connected', () => {
      this.metrics.connectionState = 'connected';
    });

    this.client.on('disconnected', () => {
      this.metrics.connectionState = 'disconnected';
    });
  }

  /**
   * 压缩消息数据
   */
  async compressMessage(data: Buffer): Promise<Buffer> {
    if (!this.config.enableCompression || data.length < this.config.compressionThreshold) {
      return data;
    }

    return new Promise((resolve, reject) => {
      const gzip = createGzip();
      const chunks: Buffer[] = [];

      gzip.on('data', (chunk) => chunks.push(chunk));
      gzip.on('end', () => {
        const compressed = Buffer.concat(chunks);
        this.metrics.compressionRatio = data.length / compressed.length;
        resolve(compressed);
      });
      gzip.on('error', reject);

      gzip.write(data);
      gzip.end();
    });
  }

  /**
   * 解压缩消息数据
   */
  async decompressMessage(data: Buffer): Promise<Buffer> {
    if (!this.config.enableCompression) {
      return data;
    }

    return new Promise((resolve, reject) => {
      const gunzip = createGunzip();
      const chunks: Buffer[] = [];

      gunzip.on('data', (chunk) => chunks.push(chunk));
      gunzip.on('end', () => resolve(Buffer.concat(chunks)));
      gunzip.on('error', reject);

      gunzip.write(data);
      gunzip.end();
    });
  }

  /**
   * 获取性能指标
   */
  getMetrics(): PerformanceMetrics {
    // 更新内存使用
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsage = memUsage.heapUsed;

    return { ...this.metrics };
  }

  /**
   * 记录消息发送
   */
  recordMessageSent(_size: number): void {
    this.metrics.messagesSent++;
  }

  /**
   * 记录消息接收
   */
  recordMessageReceived(_size: number): void {
    this.metrics.messagesReceived++;
  }

  /**
   * 记录延迟
   */
  recordLatency(latency: number): void {
    // 简单的移动平均
    this.metrics.averageLatency = (this.metrics.averageLatency + latency) / 2;
  }

  /**
   * 优化内存使用
   */
  optimizeMemory(): void {
    // 强制垃圾回收 (如果可用)
    if (global.gc) {
      global.gc();
    }

    // 清理缓存
    this.client.getACLManager().clearCache();

    // 清理压缩流
    this.compressionStreams.clear();

    this.emit('memoryOptimized');
  }

  /**
   * 获取连接池状态
   */
  getConnectionPoolStatus(): { active: number; idle: number; waiting: number } {
    // 对于客户端，通常只有一个连接
    const isConnected = this.client.isConnected();
    return {
      active: isConnected ? 1 : 0,
      idle: 0, // 客户端没有空闲连接池
      waiting: 0 // 客户端没有等待队列
    };
  }

  /**
   * 开始指标收集
   */
  private startMetricsCollection(): void {
    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      this.emit('metrics', metrics);
    }, this.config.metricsInterval);
  }

  /**
   * 停止指标收集
   */
  private stopMetricsCollection(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  /**
   * 开始内存清理
   */
  private startMemoryCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.optimizeMemory();
    }, this.config.cleanupInterval);
  }

  /**
   * 停止内存清理
   */
  private stopMemoryCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 销毁优化器
   */
  destroy(): void {
    this.stopMetricsCollection();
    this.stopMemoryCleanup();
    this.compressionStreams.clear();
    this.removeAllListeners();
  }
}

/**
 * 创建性能优化器
 */
export function createPerformanceOptimizer(
  client: MumbleClient,
  config?: PerformanceConfig
): PerformanceOptimizer {
  return new PerformanceOptimizer(client, config);
}