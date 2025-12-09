/**
 * UDP 网络质量模拟器
 * 
 * 用于在集成测试中模拟网络劣化：
 * - 丢包（Packet Loss）
 * - 延迟（Latency/Delay）
 * - 抖动（Jitter）
 * - 带宽限制
 */

import { Socket as UDPSocket } from 'dgram';

export interface NetworkQualityConfig {
  packetLoss?: number;      // 丢包率 (0-1)
  latency?: number;          // 延迟 (ms)
  jitter?: number;           // 抖动 (ms)
  bandwidth?: number;        // 带宽限制 (bytes/sec)
}

interface QueuedPacket {
  buffer: Buffer;
  offset: number;
  length: number;
  port: number;
  address: string;
  callback?: (error: Error | null, bytes: number) => void;
  sendTime: number;
}

/**
 * UDP 质量模拟器
 * 拦截 UDP socket 的 send 方法，应用网络质量参数
 */
export class UDPQualitySimulator {
  private originalSend: Function;
  private socket: UDPSocket;
  private config: NetworkQualityConfig;
  private packetQueue: QueuedPacket[] = [];
  private bandwidthUsed: number = 0;
  private lastResetTime: number = Date.now();
  private isProcessing: boolean = false;

  constructor(socket: UDPSocket, config: NetworkQualityConfig = {}) {
    this.socket = socket;
    this.config = config;
    this.originalSend = socket.send.bind(socket);
    
    // 替换 socket.send 方法
    this.patchSend();
    
    // 启动包处理循环
    this.startProcessing();
  }

  /**
   * 更新网络质量配置
   */
  updateConfig(config: Partial<NetworkQualityConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): NetworkQualityConfig {
    return { ...this.config };
  }

  /**
   * 重置模拟器
   */
  reset(): void {
    this.config = {};
    this.packetQueue = [];
    this.bandwidthUsed = 0;
    this.lastResetTime = Date.now();
  }

  /**
   * 停止模拟器并恢复原始 send 方法
   */
  stop(): void {
    this.isProcessing = false;
    (this.socket as any).send = this.originalSend;
  }

  /**
   * 修补 socket.send 方法
   */
  private patchSend(): void {
    const self = this;
    (this.socket as any).send = function(
      msg: Buffer | string | Uint8Array | any[],
      offset?: number,
      length?: number,
      port?: number,
      address?: string,
      callback?: (error: Error | null, bytes: number) => void
    ): void {
      // 处理不同的 send 调用签名
      let buffer: Buffer;
      let actualOffset = 0;
      let actualLength = 0;
      let actualPort = port;
      let actualAddress = address;
      let actualCallback = callback;

      if (Buffer.isBuffer(msg)) {
        buffer = msg;
        if (typeof offset === 'number' && typeof length === 'number') {
          actualOffset = offset;
          actualLength = length;
        } else {
          actualOffset = 0;
          actualLength = msg.length;
          // 调整参数位置
          if (typeof offset === 'number') {
            actualPort = offset;
            actualAddress = length as any;
            actualCallback = port as any;
          }
        }
      } else {
        buffer = Buffer.from(msg as any);
        actualOffset = 0;
        actualLength = buffer.length;
        if (typeof offset === 'number') {
          actualPort = offset;
          actualAddress = length as any;
          actualCallback = port as any;
        }
      }

      // 应用丢包
      if (self.config.packetLoss && Math.random() < self.config.packetLoss) {
        // 丢包 - 直接调用 callback 表示发送失败（或成功但实际没发）
        if (actualCallback) {
          setImmediate(() => actualCallback(null, actualLength));
        }
        return;
      }

      // 计算延迟（包含抖动）
      let delay = self.config.latency || 0;
      if (self.config.jitter) {
        delay += (Math.random() - 0.5) * 2 * self.config.jitter;
        delay = Math.max(0, delay);
      }

      // 加入队列
      const packet: QueuedPacket = {
        buffer,
        offset: actualOffset,
        length: actualLength,
        port: actualPort!,
        address: actualAddress!,
        callback: actualCallback,
        sendTime: Date.now() + delay,
      };

      self.packetQueue.push(packet);
    };
  }

  /**
   * 处理包队列
   */
  private async startProcessing(): Promise<void> {
    this.isProcessing = true;

    const processLoop = () => {
      if (!this.isProcessing) return;

      const now = Date.now();

      // 重置带宽计数器（每秒）
      if (now - this.lastResetTime >= 1000) {
        this.bandwidthUsed = 0;
        this.lastResetTime = now;
      }

      // 处理到期的包
      let i = 0;
      while (i < this.packetQueue.length) {
        const packet = this.packetQueue[i];

        // 检查是否到发送时间
        if (packet.sendTime > now) {
          i++;
          continue;
        }

        // 检查带宽限制
        if (this.config.bandwidth) {
          if (this.bandwidthUsed + packet.length > this.config.bandwidth) {
            // 超过带宽限制，延迟到下一秒
            packet.sendTime = this.lastResetTime + 1000;
            i++;
            continue;
          }
          this.bandwidthUsed += packet.length;
        }

        // 发送包
        this.packetQueue.splice(i, 1);
        this.originalSend(
          packet.buffer,
          packet.offset,
          packet.length,
          packet.port,
          packet.address,
          packet.callback
        );
      }

      // 继续处理
      setTimeout(processLoop, 10); // 每 10ms 处理一次
    };

    processLoop();
  }

  /**
   * 获取当前队列统计
   */
  getStats() {
    return {
      queueLength: this.packetQueue.length,
      bandwidthUsed: this.bandwidthUsed,
      bandwidthLimit: this.config.bandwidth || 0,
    };
  }
}

/**
 * 为 UDP socket 应用网络质量模拟
 */
export function applyNetworkQuality(
  socket: UDPSocket | undefined,
  config: NetworkQualityConfig
): UDPQualitySimulator {
  if (!socket) {
    throw new Error('UDP socket is undefined');
  }

  return new UDPQualitySimulator(socket, config);
}
