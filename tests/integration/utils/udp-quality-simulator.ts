/**
 * UDP 网络质量模拟工具
 * 
 * 提供用于测试的 UDP 质量模拟功能
 */

import type { Socket } from 'dgram';

/**
 * 网络质量配置
 */
export interface NetworkQualityConfig {
  /**
   * 丢包率 (0-1)
   */
  packetLoss?: number;

  /**
   * 额外延迟 (ms)
   */
  latency?: number;

  /**
   * 抖动 (ms)
   */
  jitter?: number;

  /**
   * 是否完全阻断
   */
  blocked?: boolean;
}

/**
 * UDP 质量模拟器
 */
export class UDPQualitySimulator {
  private originalSend?: any;
  private socket?: Socket;
  private config: Required<NetworkQualityConfig>;

  constructor(config: NetworkQualityConfig = {}) {
    this.config = {
      packetLoss: config.packetLoss ?? 0,
      latency: config.latency ?? 0,
      jitter: config.jitter ?? 0,
      blocked: config.blocked ?? false,
    };
  }

  /**
   * 开始模拟质量问题
   */
  start(socket: Socket): void {
    this.socket = socket;
    this.originalSend = socket.send.bind(socket);

    // 替换 socket.send 方法来模拟网络质量问题
    const self = this;
    socket.send = function(msg: any, offset: any, length: any, port: any, address: any, callback?: any) {
      // 如果完全阻断，直接返回错误
      if (self.config.blocked) {
        if (callback) {
          setImmediate(() => callback(new Error('Network blocked')));
        }
        return;
      }

      // 模拟丢包
      if (Math.random() < self.config.packetLoss) {
        if (callback) {
          // 丢包时调用成功回调，让发送方认为包已发送
          // 但实际上不调用 originalSend，所以包不会真的发送出去
          setImmediate(() => callback(null));
        }
        return;
      }

      // 计算延迟（包含抖动）
      const actualLatency = self.config.latency + 
        (Math.random() * self.config.jitter * 2 - self.config.jitter);

      // 立即发送数据包（避免缓冲区溢出），但延迟回调来模拟延迟
      // 这样可以避免在高延迟下大量数据包堆积导致丢包
      self.originalSend!(msg, offset, length, port, address, (err: any) => {
        if (actualLatency > 0 && callback) {
          setTimeout(() => callback(err), actualLatency);
        } else if (callback) {
          callback(err);
        }
      });
    } as any;
  }

  /**
   * 停止模拟
   */
  stop(): void {
    if (this.socket && this.originalSend) {
      this.socket.send = this.originalSend;
      this.socket = undefined;
      this.originalSend = undefined;
    }
  }

  /**
   * 更新质量配置
   */
  updateConfig(config: Partial<NetworkQualityConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * 获取当前配置
   */
  getConfig(): NetworkQualityConfig {
    return { ...this.config };
  }
}

/**
 * 为 VoiceUDPTransport 创建质量模拟器
 */
export function createVoiceTransportSimulator(
  transport: any,
  config: NetworkQualityConfig
): UDPQualitySimulator {
  const simulator = new UDPQualitySimulator(config);
  
  // 获取底层 UDP socket
  const socket = transport.socket || transport._socket;
  if (socket) {
    simulator.start(socket);
  }

  return simulator;
}

/**
 * 模拟网络质量差的场景
 */
export const NetworkScenarios = {
  /**
   * 良好网络
   */
  GOOD: {
    packetLoss: 0,
    latency: 0,
    jitter: 0,
  },

  /**
   * 轻微丢包
   */
  LIGHT_LOSS: {
    packetLoss: 0.02, // 2% 丢包
    latency: 10,
    jitter: 5,
  },

  /**
   * 高延迟
   */
  HIGH_LATENCY: {
    packetLoss: 0.05, // 5% 丢包
    latency: 200,
    jitter: 50,
  },

  /**
   * 严重质量问题
   */
  POOR: {
    packetLoss: 0.15, // 15% 丢包
    latency: 300,
    jitter: 100,
  },

  /**
   * 极差质量
   */
  VERY_POOR: {
    packetLoss: 0.30, // 30% 丢包
    latency: 500,
    jitter: 200,
  },

  /**
   * 完全阻断
   */
  BLOCKED: {
    blocked: true,
  },
};

/**
 * 为测试创建网络质量模拟辅助函数
 */
export function mockUDPQuality(
  socket: Socket,
  scenario: keyof typeof NetworkScenarios
): () => void {
  const config = NetworkScenarios[scenario];
  const simulator = new UDPQualitySimulator(config);
  simulator.start(socket);

  // 返回清理函数
  return () => simulator.stop();
}
