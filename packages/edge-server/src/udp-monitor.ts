import { EventEmitter } from 'events';
// import { logger } from '@munode/common';
import type { Logger } from 'winston';
import { EdgeConfig, UDPStats } from './types.js';

/**
 * UDP 监控器 - 监控UDP连接质量和不稳定性
 */
export class UDPMonitor extends EventEmitter {
  // private _config: EdgeConfig;
  private logger: Logger;
  private pingHistory: Map<number, number[]> = new Map(); // sessionId -> ping times
  private packetStats: Map<number, any> = new Map(); // sessionId -> stats
  private unstableSessions: Set<number> = new Set();

  constructor(_config: EdgeConfig, logger: Logger) {
    super();
    // this._config = _config;
    this.logger = logger;
  }

  /**
   * 记录Ping时间
   */
  recordPing(sessionId: number, pingTime: number): void {
    let history = this.pingHistory.get(sessionId);
    if (!history) {
      history = [];
      this.pingHistory.set(sessionId, history);
    }

    // 保持最近的10个ping值
    history.push(pingTime);
    if (history.length > 10) {
      history.shift();
    }

    // 更新统计
    this.updateStats(sessionId);
  }

  /**
   * 记录数据包统计
   */
  recordPacket(sessionId: number, packetSize: number, isLost: boolean = false): void {
    let stats = this.packetStats.get(sessionId);
    if (!stats) {
      stats = {
        totalPackets: 0,
        lostPackets: 0,
        totalBytes: 0,
        lastSequence: 0,
        expectedSequence: 0,
      };
      this.packetStats.set(sessionId, stats);
    }

    stats.totalPackets++;
    stats.totalBytes += packetSize;

    if (isLost) {
      stats.lostPackets++;
    }

    // 更新统计
    this.updateStats(sessionId);
  }

  /**
   * 更新会话统计
   */
  private updateStats(sessionId: number): void {
    const pingHistory = this.pingHistory.get(sessionId) || [];
    const packetStats = this.packetStats.get(sessionId);

    if (pingHistory.length === 0 && !packetStats) {
      return;
    }

    // 计算ping统计
    const pingAvg =
      pingHistory.length > 0
        ? pingHistory.reduce((sum, ping) => sum + ping, 0) / pingHistory.length
        : 0;

    const pingVar =
      pingHistory.length > 1
        ? pingHistory.reduce((sum, ping) => sum + Math.pow(ping - pingAvg, 2), 0) /
          (pingHistory.length - 1)
        : 0;

    // 计算丢包率
    const totalPackets = packetStats?.totalPackets || 0;
    const lostPackets = packetStats?.lostPackets || 0;
    const packetLoss = totalPackets > 0 ? lostPackets / totalPackets : 0;

    const stats: UDPStats = {
      pingAvg,
      pingVar,
      packets: totalPackets,
      totalPackets,
      volume: packetStats?.totalBytes || 0,
      unstable: this.isUnstable(pingAvg, pingVar, packetLoss),
    };

    // 检查不稳定性
    const wasUnstable = this.unstableSessions.has(sessionId);
    if (stats.unstable && !wasUnstable) {
      this.unstableSessions.add(sessionId);
      this.logger.warn(`UDP connection became unstable for session ${sessionId}`);
      this.emit('connectionUnstable', sessionId, stats);
    } else if (!stats.unstable && wasUnstable) {
      this.unstableSessions.delete(sessionId);
      this.logger.info(`UDP connection stabilized for session ${sessionId}`);
      this.emit('connectionStabilized', sessionId, stats);
    }

    this.emit('statsUpdated', sessionId, stats);
  }

  /**
   * 判断连接是否不稳定
   */
  private isUnstable(pingAvg: number, pingVar: number, packetLoss: number): boolean {
    // 不稳定条件：
    // - 平均ping > 200ms
    // - ping方差 > 100ms²
    // - 丢包率 > 5%
    return pingAvg > 200 || pingVar > 10000 || packetLoss > 0.05;
  }

  /**
   * 获取会话统计
   */
  getSessionStats(sessionId: number): UDPStats | null {
    const pingHistory = this.pingHistory.get(sessionId) || [];
    const packetStats = this.packetStats.get(sessionId);

    if (pingHistory.length === 0 && !packetStats) {
      return null;
    }

    const pingAvg =
      pingHistory.length > 0
        ? pingHistory.reduce((sum, ping) => sum + ping, 0) / pingHistory.length
        : 0;

    const pingVar =
      pingHistory.length > 1
        ? pingHistory.reduce((sum, ping) => sum + Math.pow(ping - pingAvg, 2), 0) /
          (pingHistory.length - 1)
        : 0;

    const totalPackets = packetStats?.totalPackets || 0;
    const lostPackets = packetStats?.lostPackets || 0;

    return {
      pingAvg,
      pingVar,
      packets: totalPackets,
      totalPackets,
      volume: packetStats?.totalBytes || 0,
      unstable: this.isUnstable(
        pingAvg,
        pingVar,
        totalPackets > 0 ? lostPackets / totalPackets : 0
      ),
    };
  }

  /**
   * 获取所有会话统计
   */
  getAllStats(): Map<number, UDPStats> {
    const allStats = new Map<number, UDPStats>();

    // 获取所有会话ID
    const sessionIds = new Set([...this.pingHistory.keys(), ...this.packetStats.keys()]);

    for (const sessionId of sessionIds) {
      const stats = this.getSessionStats(sessionId);
      if (stats) {
        allStats.set(sessionId, stats);
      }
    }

    return allStats;
  }

  /**
   * 获取不稳定连接列表
   */
  getUnstableSessions(): number[] {
    return Array.from(this.unstableSessions);
  }

  /**
   * 清理会话数据
   */
  cleanupSession(sessionId: number): void {
    this.pingHistory.delete(sessionId);
    this.packetStats.delete(sessionId);
    this.unstableSessions.delete(sessionId);
  }

  /**
   * 获取全局统计
   */
  getGlobalStats(): any {
    const allStats = this.getAllStats();
    const unstableCount = this.unstableSessions.size;

    let totalPingAvg = 0;
    let totalPackets = 0;
    let totalVolume = 0;

    for (const stats of allStats.values()) {
      totalPingAvg += stats.pingAvg;
      totalPackets += stats.packets;
      totalVolume += stats.volume;
    }

    return {
      totalSessions: allStats.size,
      unstableSessions: unstableCount,
      averagePing: allStats.size > 0 ? totalPingAvg / allStats.size : 0,
      totalPackets,
      totalVolume,
      stabilityRate: allStats.size > 0 ? (allStats.size - unstableCount) / allStats.size : 1,
    };
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.pingHistory.clear();
    this.packetStats.clear();
    this.unstableSessions.clear();
    this.logger.info('UDP monitor stats reset');
  }
}
