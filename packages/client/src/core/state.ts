/**
 * StateManager - 状态管理器
 * 
 * 主要职责:
 * - 维护服务器状态 (频道树、用户列表)
 * - 维护客户端会话状态
 * - 处理状态更新消息
 * - 提供状态查询接口
 */

import type { MumbleClient } from './mumble-client.js';
import type { Channel, User, ServerInfo, SessionState } from '../types/client-types.js';

export class StateManager {
  private client: MumbleClient;
  
  // 服务器状态
  private serverInfo: ServerInfo | null = null;
  private channels: Map<number, Channel> = new Map();
  private users: Map<number, User> = new Map();
  
  // 客户端会话状态
  private session: SessionState | null = null;

  constructor(client: MumbleClient) {
    this.client = client;
  }

  /**
   * 处理 ServerSync 消息
   */
  handleServerSync(message: any): void {
    // 保存会话信息
    this.session = {
      session: message.session,
      channel_id: message.channel_id || 0,
      self_mute: message.self_mute || false,
      self_deaf: message.self_deaf || false,
      suppress: message.suppress || false,
      recording: message.recording || false,
      priority_speaker: message.priority_speaker || false,
      listeningChannels: message.listening_channel_add || []
    };

    // 初始化根频道 (如果不存在)
    if (!this.channels.has(0)) {
      this.channels.set(0, {
        channel_id: 0,
        parent: -1,
        name: 'Root',
        description: '',
        temporary: false,
        position: 0,
        links: [],
        max_users: 0,
        children: []
      });
    }

    // 更新服务器信息 (如果有的话)
    if (message.welcome_text) {
      this.serverInfo = {
        ...this.serverInfo,
        welcomeText: message.welcome_text
      } as ServerInfo;
    }

    // 触发服务器同步事件
    this.client.emit('serverSync', message);
  }

  /**
   * 处理 ServerConfig 消息
   */
  handleServerConfig(message: any): void {
    // 更新服务器配置信息
    this.serverInfo = {
      version: message.version || 0,
      release: message.release || '',
      os: message.os || '',
      maxBandwidth: message.max_bandwidth || 0,
      maxUsers: message.max_users || 0,
      welcomeText: message.welcome_text || '',
      allowHtml: message.allow_html || false,
      messageLength: message.message_length || 0
    };

    // 触发服务器配置更新事件
    this.client.emit('serverConfig', message);
  }

  /**
   * 处理 ChannelState 消息
   */
  handleChannelState(message: any): void {
    const channelId = message.channel_id;
    const existingChannel = this.channels.get(channelId);

    const channel: Channel = {
      channel_id: channelId,
      parent: message.parent || 0,
      name: message.name || '',
      description: message.description || '',
      temporary: message.temporary || false,
      position: message.position || 0,
      links: message.links || [],
      max_users: message.max_users || 0,
      children: existingChannel?.children || []
    };

    // 更新父频道的子频道列表
    if (message.parent !== undefined) {
      const oldParent = existingChannel?.parent;
      if (oldParent !== undefined && oldParent !== message.parent) {
        // 从旧父频道移除
        const oldParentChannel = this.channels.get(oldParent);
        if (oldParentChannel) {
          oldParentChannel.children = oldParentChannel.children.filter(id => id !== channelId);
        }
      }

      // 添加到新父频道
      const newParentChannel = this.channels.get(message.parent);
      if (newParentChannel && !newParentChannel.children.includes(channelId)) {
        newParentChannel.children.push(channelId);
      }
    }

    this.channels.set(channelId, channel);

    // 触发频道状态更新事件
    this.client.emit('channelState', message);
  }

  /**
   * 处理 ChannelRemove 消息
   */
  handleChannelRemove(message: any): void {
    const channelId = message.channel_id;
    const channel = this.channels.get(channelId);

    if (channel) {
      // 从父频道的子频道列表中移除
      const parentChannel = this.channels.get(channel.parent);
      if (parentChannel) {
        parentChannel.children = parentChannel.children.filter(id => id !== channelId);
      }

      // 删除频道
      this.channels.delete(channelId);

      // 触发频道删除事件
      this.client.emit('channelRemove', message);
    }
  }

  /**
   * 处理 UserState 消息
   */
  handleUserState(message: any): void {
    const session = message.session;
    const existingUser = this.users.get(session);

    const user: User = {
      session: session,
      user_id: message.user_id,
      name: message.name || existingUser?.name || '',
      channel_id: message.channel_id !== undefined ? message.channel_id : existingUser?.channel_id || 0,
      mute: message.mute || false,
      deaf: message.deaf || false,
      suppress: message.suppress || false,
      self_mute: message.self_mute || false,
      self_deaf: message.self_deaf || false,
      recording: message.recording || false,
      priority_speaker: message.priority_speaker || false,
      hash: message.hash,
      comment: message.comment,
      texture: message.texture
    };

    // 如果是当前用户，更新会话状态
    if (this.session && this.session.session === session) {
      this.session.channel_id = user.channel_id;
      this.session.self_mute = user.self_mute;
      this.session.self_deaf = user.self_deaf;
      this.session.recording = user.recording;
      this.session.priority_speaker = user.priority_speaker;
      this.session.listeningChannels = message.listening_channel_add || this.session.listeningChannels;
    }

    this.users.set(session, user);

    // 触发用户状态更新事件
    this.client.emit('userState', message);
  }

  /**
   * 处理 UserRemove 消息
   */
  handleUserRemove(message: any): void {
    const session = message.session;
    const user = this.users.get(session);

    if (user) {
      this.users.delete(session);

      // 触发用户离开事件
      this.client.emit('userRemove', message);
    }
  }

  /**
   * 处理 PermissionDenied 消息
   */
  handlePermissionDenied(message: any): void {
    // 解析权限拒绝消息
    const permission = message.permission || 0;
    const type = message.type || 0;
    const reason = message.reason || '';
    const channelId = message.channel_id || 0;
    const session = message.session || 0;

    // 触发权限拒绝事件
    this.client.emit('permissionDenied', {
      permission,
      type,
      reason,
      channelId,
      session
    });
  }

  /**
   * 获取频道信息
   */
  getChannel(channelId: number): Channel | null {
    return this.channels.get(channelId) || null;
  }

  /**
   * 获取所有频道
   */
  getChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /**
   * 获取频道树 (从根频道开始的树形结构)
   */
  getChannelTree(): Channel | null {
    const rootChannel = this.channels.get(0);
    if (!rootChannel) return null;

    // 递归构建频道树
    const buildTree = (channel: Channel): Channel => {
      const children = channel.children
        .map(childId => this.channels.get(childId))
        .filter(child => child !== undefined)
        .map(child => buildTree(child!));

      return {
        ...channel,
        children: children.map(child => child.channel_id)
      };
    };

    return buildTree(rootChannel);
  }

  /**
   * 获取用户信息
   */
  getUser(session: number): User | null {
    return this.users.get(session) || null;
  }

  /**
   * 获取所有用户
   */
  getUsers(): User[] {
    return Array.from(this.users.values());
  }

  /**
   * 获取频道内的用户
   */
  getUsersInChannel(channelId: number): User[] {
    return Array.from(this.users.values()).filter(
      user => user.channel_id === channelId
    );
  }

  /**
   * 获取服务器信息
   */
  getServerInfo(): ServerInfo | null {
    return this.serverInfo;
  }

  /**
   * 获取会话信息
   */
  getSession(): SessionState | null {
    return this.session;
  }

  /**
   * 更新会话状态
   */
  updateSession(updates: Partial<SessionState>): void {
    if (this.session) {
      Object.assign(this.session, updates);
    }
  }

  /**
   * 获取当前所在频道
   */
  getCurrentChannel(): Channel | null {
    if (!this.session) return null;
    return this.getChannel(this.session.channel_id);
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    this.serverInfo = null;
    this.channels.clear();
    this.users.clear();
    this.session = null;
  }
}
