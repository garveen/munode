/**
 * 频道监听器音量调节管理器
 * 
 * 管理用户对频道监听器的音量调节设置。
 * 允许用户在监听某个频道时单独调整该频道的音量。
 */

/**
 * 音量调节信息
 */
export interface VolumeAdjustment {
  /** 用户会话ID */
  userSession: number;
  /** 被监听的频道ID */
  channelId: number;
  /** 音量因子 (1.0 = 正常, 0.0 = 静音, >1.0 = 放大) */
  factor: number;
}

/**
 * 频道监听器音量调节管理器
 * 
 * 功能：
 * - 存储和检索每个用户对其监听频道的音量调节
 * - 支持批量获取用户的所有音量调节设置
 * - 自动清理断开连接用户的设置
 */
export class ChannelListenerVolumeManager {
  /**
   * 存储音量调节
   * Map<userSession, Map<channelId, factor>>
   */
  private volumeAdjustments: Map<number, Map<number, number>> = new Map();

  /**
   * 设置用户对某个监听频道的音量调节
   * 
   * @param userSession - 用户会话ID
   * @param channelId - 被监听的频道ID
   * @param factor - 音量因子 (1.0 = 正常, 0.0 = 静音, >1.0 = 放大)
   */
  setVolumeAdjustment(userSession: number, channelId: number, factor: number): void {
    // 验证音量因子范围
    if (factor < 0 || factor > 10.0) {
      throw new Error(`Invalid volume factor: ${factor}. Must be between 0 and 10.0`);
    }

    let userAdjustments = this.volumeAdjustments.get(userSession);
    if (!userAdjustments) {
      userAdjustments = new Map();
      this.volumeAdjustments.set(userSession, userAdjustments);
    }

    // 如果音量因子为1.0（默认值），删除该调节设置
    if (factor === 1.0) {
      userAdjustments.delete(channelId);
      // 如果用户没有任何调节设置了，删除整个用户条目
      if (userAdjustments.size === 0) {
        this.volumeAdjustments.delete(userSession);
      }
    } else {
      userAdjustments.set(channelId, factor);
    }
  }

  /**
   * 获取用户对某个监听频道的音量调节
   * 
   * @param userSession - 用户会话ID
   * @param channelId - 被监听的频道ID
   * @returns 音量因子，如果未设置则返回1.0（默认值）
   */
  getVolumeAdjustment(userSession: number, channelId: number): number {
    const userAdjustments = this.volumeAdjustments.get(userSession);
    if (!userAdjustments) {
      return 1.0;
    }

    return userAdjustments.get(channelId) ?? 1.0;
  }

  /**
   * 获取用户的所有音量调节设置
   * 
   * @param userSession - 用户会话ID
   * @returns 音量调节列表（仅返回非默认值的设置）
   */
  getAllVolumeAdjustments(userSession: number): VolumeAdjustment[] {
    const userAdjustments = this.volumeAdjustments.get(userSession);
    if (!userAdjustments) {
      return [];
    }

    const adjustments: VolumeAdjustment[] = [];
    for (const [channelId, factor] of userAdjustments.entries()) {
      adjustments.push({
        userSession,
        channelId,
        factor
      });
    }

    return adjustments;
  }

  /**
   * 删除用户对某个监听频道的音量调节
   * 
   * @param userSession - 用户会话ID
   * @param channelId - 被监听的频道ID
   */
  removeVolumeAdjustment(userSession: number, channelId: number): void {
    const userAdjustments = this.volumeAdjustments.get(userSession);
    if (userAdjustments) {
      userAdjustments.delete(channelId);
      // 如果用户没有任何调节设置了，删除整个用户条目
      if (userAdjustments.size === 0) {
        this.volumeAdjustments.delete(userSession);
      }
    }
  }

  /**
   * 清理用户的所有音量调节设置
   * 通常在用户断开连接时调用
   * 
   * @param userSession - 用户会话ID
   */
  clearUserAdjustments(userSession: number): void {
    this.volumeAdjustments.delete(userSession);
  }

  /**
   * 获取所有用户的音量调节数量
   * 用于调试和监控
   */
  getTotalAdjustmentCount(): number {
    let count = 0;
    for (const userAdjustments of this.volumeAdjustments.values()) {
      count += userAdjustments.size;
    }
    return count;
  }

  /**
   * 获取有音量调节设置的用户数量
   */
  getUserCount(): number {
    return this.volumeAdjustments.size;
  }

  /**
   * 清空所有音量调节设置
   */
  clear(): void {
    this.volumeAdjustments.clear();
  }
}
