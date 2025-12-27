/**
 * 客户端统计数据收集器
 * 
 * 基于 C++ Mumble 服务器实现，收集详细的客户端运行统计
 * 用于 UserStats 消息和服务器监控
 */

/**
 * 加密统计数据
 * 追踪加密包的质量指标
 */
export interface ClientCryptStats {
  /** 正常解密的包数 */
  good: number;
  /** 延迟到达的包数（可能导致重放攻击检测） */
  late: number;
  /** 丢失的包数 */
  lost: number;
  /** 需要重新同步的次数 */
  resync: number;
}

/**
 * 网络包统计
 */
export interface PacketStats {
  /** 发送的包数 */
  sent: number;
  /** 接收的包数 */
  received: number;
  /** 发送的字节数 */
  sentBytes: number;
  /** 接收的字节数 */
  receivedBytes: number;
}

/**
 * Ping 统计
 */
export interface PingStats {
  /** 平均 ping (ms) */
  average: number;
  /** ping 方差 */
  variance: number;
  /** 最后一次 ping 时间戳 */
  lastPing: number;
  /** ping 样本数 */
  count: number;
}

/**
 * 带宽统计
 */
export interface BandwidthStats {
  /** 当前上行带宽 (bytes/s) */
  upstream: number;
  /** 当前下行带宽 (bytes/s) */
  downstream: number;
  /** 峰值上行带宽 (bytes/s) */
  peakUpstream: number;
  /** 峰值下行带宽 (bytes/s) */
  peakDownstream: number;
}

/**
 * 语音统计
 */
export interface VoiceStats {
  /** 发送的语音包数 */
  packetsSent: number;
  /** 接收的语音包数 */
  packetsReceived: number;
  /** 语音活动时间 (秒) */
  talkTime: number;
  /** 最后说话时间戳 */
  lastTalk: number;
}

/**
 * 完整的客户端统计数据
 */
export interface ClientStatistics {
  /** UDP 加密统计（从客户端接收） */
  udpCryptFromClient: ClientCryptStats;
  /** UDP 加密统计（发送到客户端） */
  udpCryptFromServer: ClientCryptStats;
  /** TCP 加密统计（从客户端接收） */
  tcpCryptFromClient: ClientCryptStats;
  /** TCP 加密统计（发送到客户端） */
  tcpCryptFromServer: ClientCryptStats;
  
  /** UDP 包统计 */
  udpPackets: PacketStats;
  /** TCP 包统计 */
  tcpPackets: PacketStats;
  
  /** UDP Ping 统计 */
  udpPing: PingStats;
  /** TCP Ping 统计 */
  tcpPing: PingStats;
  
  /** 带宽统计 */
  bandwidth: BandwidthStats;
  
  /** 语音统计 */
  voice: VoiceStats;
  
  /** 连接时长 (秒) */
  connectionTime: number;
  /** 空闲时长 (秒) */
  idleTime: number;
  /** 最后活动时间戳 */
  lastActivity: number;
}

/**
 * 客户端统计收集器
 * 
 * 为每个客户端维护详细的统计数据
 * 使用滑动窗口算法计算 ping 平均值和方差
 */
export class ClientStatisticsCollector {
  private stats: ClientStatistics;
  private readonly startTime: number;
  
  // Ping 计算用的历史数据
  private udpPingHistory: number[] = [];
  private tcpPingHistory: number[] = [];
  private readonly maxPingHistory = 20; // 保留最近 20 个样本
  
  // 带宽计算用的时间窗口
  private bandwidthWindow = 1000; // 1秒窗口
  private lastBandwidthUpdate = 0;
  private windowUploadBytes = 0;
  private windowDownloadBytes = 0;

  constructor() {
    const now = Date.now();
    this.startTime = now;
    this.lastBandwidthUpdate = now; // 初始化带宽更新时间
    this.stats = {
      udpCryptFromClient: { good: 0, late: 0, lost: 0, resync: 0 },
      udpCryptFromServer: { good: 0, late: 0, lost: 0, resync: 0 },
      tcpCryptFromClient: { good: 0, late: 0, lost: 0, resync: 0 },
      tcpCryptFromServer: { good: 0, late: 0, lost: 0, resync: 0 },
      udpPackets: { sent: 0, received: 0, sentBytes: 0, receivedBytes: 0 },
      tcpPackets: { sent: 0, received: 0, sentBytes: 0, receivedBytes: 0 },
      udpPing: { average: 0, variance: 0, lastPing: 0, count: 0 },
      tcpPing: { average: 0, variance: 0, lastPing: 0, count: 0 },
      bandwidth: { upstream: 0, downstream: 0, peakUpstream: 0, peakDownstream: 0 },
      voice: { packetsSent: 0, packetsReceived: 0, talkTime: 0, lastTalk: 0 },
      connectionTime: 0,
      idleTime: 0,
      lastActivity: Date.now(),
    };
  }

  /**
   * 记录 UDP 接收的包
   */
  recordUDPReceived(bytes: number, cryptStatus: 'good' | 'late' | 'lost' | 'resync' = 'good'): void {
    this.stats.udpPackets.received++;
    this.stats.udpPackets.receivedBytes += bytes;
    this.stats.udpCryptFromClient[cryptStatus]++;
    this.updateActivity();
    this.updateBandwidth(0, bytes);
  }

  /**
   * 记录 UDP 发送的包
   */
  recordUDPSent(bytes: number): void {
    this.stats.udpPackets.sent++;
    this.stats.udpPackets.sentBytes += bytes;
    this.updateBandwidth(bytes, 0);
  }

  /**
   * 记录 TCP 接收的包
   */
  recordTCPReceived(bytes: number, cryptStatus: 'good' | 'late' | 'lost' | 'resync' = 'good'): void {
    this.stats.tcpPackets.received++;
    this.stats.tcpPackets.receivedBytes += bytes;
    this.stats.tcpCryptFromClient[cryptStatus]++;
    this.updateActivity();
    this.updateBandwidth(0, bytes);
  }

  /**
   * 记录 TCP 发送的包
   */
  recordTCPSent(bytes: number): void {
    this.stats.tcpPackets.sent++;
    this.stats.tcpPackets.sentBytes += bytes;
    this.updateBandwidth(bytes, 0);
  }

  /**
   * 记录 UDP Ping
   */
  recordUDPPing(pingMs: number): void {
    this.udpPingHistory.push(pingMs);
    if (this.udpPingHistory.length > this.maxPingHistory) {
      this.udpPingHistory.shift();
    }
    
    const { average, variance } = this.calculatePingStats(this.udpPingHistory);
    this.stats.udpPing = {
      average,
      variance,
      lastPing: Date.now(),
      count: this.stats.udpPing.count + 1,
    };
  }

  /**
   * 记录 TCP Ping
   */
  recordTCPPing(pingMs: number): void {
    this.tcpPingHistory.push(pingMs);
    if (this.tcpPingHistory.length > this.maxPingHistory) {
      this.tcpPingHistory.shift();
    }
    
    const { average, variance } = this.calculatePingStats(this.tcpPingHistory);
    this.stats.tcpPing = {
      average,
      variance,
      lastPing: Date.now(),
      count: this.stats.tcpPing.count + 1,
    };
  }

  /**
   * 记录语音包发送
   */
  recordVoiceSent(): void {
    this.stats.voice.packetsSent++;
    this.stats.voice.lastTalk = Date.now();
  }

  /**
   * 记录语音包接收
   */
  recordVoiceReceived(): void {
    this.stats.voice.packetsReceived++;
    this.stats.voice.lastTalk = Date.now();
  }

  /**
   * 更新语音活动时间
   */
  updateTalkTime(seconds: number): void {
    this.stats.voice.talkTime += seconds;
  }

  /**
   * 获取统计数据快照
   */
  getStatistics(): Readonly<ClientStatistics> {
    // 更新连接时长和空闲时长
    const now = Date.now();
    this.stats.connectionTime = Math.floor((now - this.startTime) / 1000);
    this.stats.idleTime = Math.floor((now - this.stats.lastActivity) / 1000);
    
    return { ...this.stats };
  }

  /**
   * 重置统计数据
   */
  reset(): void {
    const now = Date.now();
    this.stats = {
      udpCryptFromClient: { good: 0, late: 0, lost: 0, resync: 0 },
      udpCryptFromServer: { good: 0, late: 0, lost: 0, resync: 0 },
      tcpCryptFromClient: { good: 0, late: 0, lost: 0, resync: 0 },
      tcpCryptFromServer: { good: 0, late: 0, lost: 0, resync: 0 },
      udpPackets: { sent: 0, received: 0, sentBytes: 0, receivedBytes: 0 },
      tcpPackets: { sent: 0, received: 0, sentBytes: 0, receivedBytes: 0 },
      udpPing: { average: 0, variance: 0, lastPing: 0, count: 0 },
      tcpPing: { average: 0, variance: 0, lastPing: 0, count: 0 },
      bandwidth: { upstream: 0, downstream: 0, peakUpstream: 0, peakDownstream: 0 },
      voice: { packetsSent: 0, packetsReceived: 0, talkTime: 0, lastTalk: 0 },
      connectionTime: 0,
      idleTime: 0,
      lastActivity: now,
    };
    this.udpPingHistory = [];
    this.tcpPingHistory = [];
  }

  /**
   * 更新最后活动时间
   */
  private updateActivity(): void {
    this.stats.lastActivity = Date.now();
  }

  /**
   * 计算 ping 平均值和方差
   * 使用标准的统计学公式
   */
  private calculatePingStats(history: number[]): { average: number; variance: number } {
    if (history.length === 0) {
      return { average: 0, variance: 0 };
    }

    // 计算平均值
    const sum = history.reduce((a, b) => a + b, 0);
    const average = sum / history.length;

    // 计算方差
    const squaredDiffs = history.map(ping => Math.pow(ping - average, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / history.length;

    return { average, variance };
  }

  /**
   * 更新带宽统计
   * 使用滑动窗口计算当前带宽
   */
  private updateBandwidth(uploadBytes: number, downloadBytes: number): void {
    const now = Date.now();
    
    // 累加到当前窗口
    this.windowUploadBytes += uploadBytes;
    this.windowDownloadBytes += downloadBytes;
    
    // 检查是否需要更新窗口
    if (now - this.lastBandwidthUpdate >= this.bandwidthWindow) {
      const elapsed = (now - this.lastBandwidthUpdate) / 1000; // 转换为秒
      
      // 计算当前带宽 (bytes/s)
      this.stats.bandwidth.upstream = Math.floor(this.windowUploadBytes / elapsed);
      this.stats.bandwidth.downstream = Math.floor(this.windowDownloadBytes / elapsed);
      
      // 更新峰值
      if (this.stats.bandwidth.upstream > this.stats.bandwidth.peakUpstream) {
        this.stats.bandwidth.peakUpstream = this.stats.bandwidth.upstream;
      }
      if (this.stats.bandwidth.downstream > this.stats.bandwidth.peakDownstream) {
        this.stats.bandwidth.peakDownstream = this.stats.bandwidth.downstream;
      }
      
      // 重置窗口
      this.windowUploadBytes = 0;
      this.windowDownloadBytes = 0;
      this.lastBandwidthUpdate = now;
    }
  }
}
