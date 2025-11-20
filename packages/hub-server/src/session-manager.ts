import { createLogger } from '@munode/common';
import { GlobalSession } from '@munode/protocol';

const logger = createLogger({ service: 'hub-session-manager' });

/**
 * 全局会话管理器
 * 跟踪所有 Edge 上的用户会话，支持跨服务器查询
 * 注意：会话仅保存在内存中，不持久化，重启后所有用户需要重新登录
 */
export class GlobalSessionManager {
  private sessions = new Map<number, GlobalSession>();
  private userSessions = new Map<number, Set<number>>();
  private channelSessions = new Map<number, Set<number>>();
  private nextSessionId = 1; // Session ID 分配器

  constructor() {
    // 不再需要 database 依赖
  }

  /**
   * 分配新的 session ID
   */
  allocateSessionId(): number {
    return this.nextSessionId++;
  }

  /**
   * 上报新会话
   */
  reportSession(session: GlobalSession): void {
    this.sessions.set(session.session_id, session);

    // 更新用户会话索引
    if (!this.userSessions.has(session.user_id)) {
      this.userSessions.set(session.user_id, new Set());
    }
    this.userSessions.get(session.user_id).add(session.session_id);

    // 更新频道会话索引
    if (session.channel_id) {
      if (!this.channelSessions.has(session.channel_id)) {
        this.channelSessions.set(session.channel_id, new Set());
      }
      this.channelSessions.get(session.channel_id).add(session.session_id);
    }

    // 注意：会话仅保存在内存中，不持久化
    // 重启后所有用户需要重新登录

    logger.debug(`Session reported: ${session.session_id} (${session.username})`);
  }

  /**
   * 更新会话频道
   */
  updateSessionChannel( session_id: number, newchannel_id: number): void {
    const session = this.sessions.get(session_id);
    if (!session) return;

    // 从旧频道移除
    if (session.channel_id) {
      const oldChannelSessions = this.channelSessions.get(session.channel_id);
      if (oldChannelSessions) {
        oldChannelSessions.delete(session_id);
        if (oldChannelSessions.size === 0) {
          this.channelSessions.delete(session.channel_id);
        }
      }
    }

    // 添加到新频道
    session.channel_id = newchannel_id;
    if (!this.channelSessions.has(newchannel_id)) {
      this.channelSessions.set(newchannel_id, new Set());
    }
    this.channelSessions.get(newchannel_id).add(session_id);

    // 注意：会话仅保存在内存中，不持久化

    logger.debug(`Session ${session_id} moved to channel ${newchannel_id}`);
  }

  /**
   * 更新会话状态（mute, deaf, recording等）
   */
  updateSessionState(session_id: number, updates: {
    mute?: boolean;
    deaf?: boolean;
    suppress?: boolean;
    self_mute?: boolean;
    self_deaf?: boolean;
    priority_speaker?: boolean;
    recording?: boolean;
  }): void {
    const session = this.sessions.get(session_id);
    if (!session) {
      logger.warn(`Cannot update state: session ${session_id} not found`);
      return;
    }

    // 更新会话对象（这里我们扩展GlobalSession类型来包含这些字段）
    // 注意：GlobalSession接口需要扩展以包含这些字段
    Object.assign(session, updates);

    // 更新最后活跃时间
    session.last_active = Math.floor(Date.now() / 1000);

    // TODO: 持久化到数据库（如果需要）
    
    logger.debug(`Updated state for session ${session_id}:`, updates);
  }

  /**
   * 移除会话
   */
  removeSession( session_id: number): GlobalSession | undefined {
    const session = this.sessions.get(session_id);
    if (!session) return undefined;

    this.sessions.delete(session_id);

    // 从用户会话索引移除
    const userSessions = this.userSessions.get(session.user_id);
    if (userSessions) {
      userSessions.delete(session_id);
      if (userSessions.size === 0) {
        this.userSessions.delete(session.user_id);
      }
    }

    // 从频道会话索引移除
    if (session.channel_id) {
      const channelSessions = this.channelSessions.get(session.channel_id);
      if (channelSessions) {
        channelSessions.delete(session_id);
        if (channelSessions.size === 0) {
          this.channelSessions.delete(session.channel_id);
        }
      }
    }

    // 注意：会话仅保存在内存中，不需要从数据库删除

    logger.debug(`Session removed: ${session_id} (${session.username})`);
    
    // 返回被移除的会话信息，供调用者使用（如广播）
    return session;
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): GlobalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 获取频道中的所有会话
   */
  getChannelSessions( channel_id: number): GlobalSession[] {
    const session_ids = this.channelSessions.get(channel_id);
    if (!session_ids) return [];

    return Array.from(session_ids)
      .map((id) => this.sessions.get(id))
      .filter((s) => s !== undefined);
  }

  /**
   * 获取特定会话
   */
  getSession( session_id: number): GlobalSession | undefined {
    return this.sessions.get(session_id);
  }

  /**
   * 获取用户的会话
   */
  getUserSessions( user_id: number): GlobalSession[] {
    const session_ids = this.userSessions.get(user_id);
    if (!session_ids) return [];

    return Array.from(session_ids)
      .map((id) => this.sessions.get(id))
      .filter((s) => s !== undefined);
  }

  /**
   * 获取 Edge 上的所有会话
   */
  getEdgeSessions(edge_id: number): GlobalSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.edge_id === edge_id);
  }

  /**
   * 获取总用户数
   */
  getTotalUserCount(): number {
    return this.userSessions.size;
  }

  /**
   * 获取总会话数
   */
  getTotalSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 清理离线会话
   */
  cleanup(): void {
    // 清理超过1小时未活跃的会话
    const oneHourAgo = Date.now() - 3600000;
    const toRemove: number[] = [];

    for (const [session_id, session] of this.sessions.entries()) {
      if (session.connected_at * 1000 < oneHourAgo) {
        toRemove.push(session_id);
      }
    }

    for (const session_id of toRemove) {
      this.removeSession(session_id);
    }

    if (toRemove.length > 0) {
      logger.info(`Cleaned up ${toRemove.length} stale sessions`);
    }
  }
}
