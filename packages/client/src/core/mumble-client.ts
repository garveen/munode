/**
 * MumbleClient - 核心客户端类
 * 
 * 主要职责:
 * - 管理与 Mumble 服务器的连接
 * - 提供用户操作接口 (加入频道、发送消息等)
 * - 事件发射和管理
 * - 状态管理和同步
 */

import { EventEmitter } from 'events';
import { ConnectionManager } from './connection.js';
import { AuthManager } from './auth.js';
import { StateManager } from './state.js';
import { CryptoManager } from './crypto.js';
import { ACLManager } from './acl-manager.js';
import { PerformanceOptimizer } from './performance-optimizer.js';
import { AudioStreamManager, AudioInputStream } from '../audio/stream.js';
import { WebhookManager } from '../events/webhook.js';
import { mumbleproto, MessageType } from '@munode/protocol';
import type { ConnectOptions, ClientConfig, MessageTarget, User, Channel, UserStateUpdate, ChannelStateUpdate, ACLEntryUpdate, ClientConfigUpdate, WebhookConfig } from '../types/client-types.js';
import type { AudioInput } from '../types/audio-types.js';
import { Readable } from 'stream';

export class MumbleClient extends EventEmitter {
  private connection: ConnectionManager;
  private auth: AuthManager;
  private state: StateManager;
  private crypto: CryptoManager;
  private aclManager: ACLManager;
  private webhookManager: WebhookManager;
  private performanceOptimizer: PerformanceOptimizer;
  private audioManager: AudioStreamManager;
  private config: ClientConfig;

  constructor(config?: ClientConfigUpdate) {
    super();
    
    // 初始化各个管理器
    this.config = this.loadConfig(config);
    
    // 初始化各个管理器
    this.connection = new ConnectionManager(this);
    this.auth = new AuthManager(this);
    this.state = new StateManager(this);
    this.crypto = new CryptoManager(this);
    this.aclManager = new ACLManager(this);
    this.webhookManager = new WebhookManager(this);
    this.performanceOptimizer = new PerformanceOptimizer(this);
    this.audioManager = new AudioStreamManager(this);
  }

  /**
   * 等待 UDP 连接就绪
   * @param timeout 超时时间（毫秒），默认 5000ms
   */
  waitForUDP(timeout: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      // 如果已经使用 TCP 语音，直接 resolve
      if (this.connection.isUsingTcpVoice()) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        this.removeListener('udpReady', onReady);
        reject(new Error('UDP connection timeout'));
      }, timeout);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.once('udpReady', onReady);
    });
  }

  /**
   * 连接到 Mumble 服务器
   */
  async connect(options: ConnectOptions): Promise<void> {
    try {
      // 初始化认证信息
      this.auth.initialize(options);
      
      // 设置TCP语音模式（如果指定）
      if (options.forceTcpVoice) {
        this.connection.setForceTcpVoice(true);
      }
      
      // 建立 TCP 连接
      await this.connection.connectTCP(options);
      
      // 发送 Version 消息
      await this.sendVersion();
      
      // 短暂延迟以确保服务器处理了 Version 消息
      // PreConnect UserState 可以在收到 ServerSync 之前发送，但应该在 Version 之后
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 执行认证
      await this.auth.authenticate();
      
      this.emit('connected');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    await this.connection.disconnect();
    this.emit('disconnected');
    // 移除所有事件监听器防止内存泄漏
    this.removeAllListeners();
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connection.isConnected();
  }

  /**
   * 加入频道
   */
  async joinChannel(channelId: number): Promise<void> {
    // 发送 UserState 消息设置频道
    const userStateMessage = mumbleproto.UserState.fromObject({
      channel_id: channelId,
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 发送原始 UserState 消息
   * 用于移动到频道、静音/禁音等的低级API
   */
  async sendUserState(userState: UserStateUpdate): Promise<void> {
    // Provide default values for required fields
    const fullUserState = {
      ...userState,
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: [],
    };
    const userStateMessage = mumbleproto.UserState.fromObject(fullUserState);
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 创建频道
   */
  async createChannel(name: string, parent?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Channel creation timeout'));
      }, 5000); // 5秒超时

      // 监听频道状态变化
      const onChannelState = (message: mumbleproto.ChannelState) => {
        // 检查是否是我们刚创建的频道 (通过名称匹配)
        // 使用 has_xxx 检查 protobuf optional 字段是否真的设置了值
        // 新创建的频道channel_id必须大于0（Root频道ID为0，不是新创建的）
        if (message.has_channel_id && message.channel_id > 0 && 
            message.has_name && message.name === name && 
            message.has_parent && message.parent === (parent || 0)) {
          clearTimeout(timeout);
          this.removeListener('channelState', onChannelState);
          resolve(message.channel_id);
        }
      };

      this.on('channelState', onChannelState);

      // 发送创建频道消息
      const channelStateMessage = mumbleproto.ChannelState.fromObject({
        name: name,
        parent: parent || 0,
        links: [],
        links_add: [],
        links_remove: []
      });

      const serialized = channelStateMessage.serialize();
      const wrappedMessage = this.connection.wrapMessage(MessageType.ChannelState, serialized);
      this.connection.sendTCP(wrappedMessage).catch((error) => {
        clearTimeout(timeout);
        this.removeListener('channelState', onChannelState);
        reject(error);
      });
    });
  }

  /**
   * 发送原始 ChannelState 消息
   * 用于创建或修改频道的低级API
   */
  async sendChannelState(channelState: ChannelStateUpdate): Promise<void> {
    // Provide default values for required fields
    const fullChannelState = {
      ...channelState,
      links: channelState.links || [],
      links_add: channelState.links_add || [],
      links_remove: channelState.links_remove || [],
    };
    const channelStateMessage = mumbleproto.ChannelState.fromObject(fullChannelState);
    const serialized = channelStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.ChannelState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 删除频道
   */
  async deleteChannel(channelId: number): Promise<void> {
    // 发送 ChannelRemove 消息删除频道
    const channelRemoveMessage = mumbleproto.ChannelRemove.fromObject({
      channel_id: channelId
    });
    
    const serialized = channelRemoveMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.ChannelRemove, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 发送文本消息
   */
  async sendMessage(target: MessageTarget, message: string): Promise<void> {
    const textMessage = mumbleproto.TextMessage.fromObject({
      channel_id: target.channelId ? [target.channelId] : [],
      session: target.userId ? [target.userId] : [],
      message: message,
      tree_id: target.tree ? [target.channelId || 0] : []
    });
    
    const serialized = textMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.TextMessage, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 发送音频
   */
  async sendAudio(audio: AudioInput): Promise<void> {
    // 使用音频流管理器处理音频输入
    await this.audioManager.startInputStream(audio);
    // 音频流会自动处理编码和发送
  }

  /**
   * 开始音频流
   */
  async startAudioStream(stream: Readable): Promise<AudioInputStream> {
    const audioInput: AudioInput = {
      data: stream,
      format: 'raw',
      codec: 'opus'
    };
    return this.audioManager.startInputStream(audioInput);
  }

  /**
   * 停止音频流
   */
  async stopAudioStream(): Promise<void> {
    await this.audioManager.stopInputStream();
  }

  /**
   * 设置自我静音
   */
  async setSelfMute(mute: boolean): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      self_mute: mute,
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 设置自我禁听
   */
  async setSelfDeaf(deaf: boolean): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      self_deaf: deaf,
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 设置录音状态
   */
  async setRecording(recording: boolean): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      recording: recording,
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 添加监听频道
   */
  async addListeningChannel(channelId: number): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      temporary_access_tokens: [],
      listening_channel_add: [channelId],
      listening_channel_remove: []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 移除监听频道
   */
  async removeListeningChannel(channelId: number): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: [channelId]
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 清空所有监听频道
   */
  async clearListeningChannels(): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: this.state.getSession()?.listeningChannels || []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 设置语音目标
   */
  async setVoiceTarget(id: number, targets: mumbleproto.VoiceTarget.Target[]): Promise<void> {
    const voiceTargetMessage = mumbleproto.VoiceTarget.fromObject({
      id: id,
      targets: targets
    });
    
    const serialized = voiceTargetMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.VoiceTarget, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 移除语音目标
   */
  async removeVoiceTarget(id: number): Promise<void> {
    const voiceTargetMessage = mumbleproto.VoiceTarget.fromObject({
      id: id,
      targets: []
    });
    
    const serialized = voiceTargetMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.VoiceTarget, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 发送插件数据
   */
  async sendPluginData(pluginId: string, pluginData: Buffer, receivers?: number[]): Promise<void> {
    const pluginDataMessage = mumbleproto.PluginDataTransmission.fromObject({
      senderSession: this.state.getSession()?.session || 0,
      receiverSessions: receivers || [],
      data: pluginData,
      dataID: pluginId
    });
    
    const serialized = pluginDataMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.PluginDataTransmission, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 注册上下文操作
   */
  async registerContextAction(action: string, text: string, contexts?: number[]): Promise<void> {
    const contextActionMessage = mumbleproto.ContextActionModify.fromObject({
      action: action,
      text: text,
      context: contexts ? contexts.reduce((acc, ctx) => acc | ctx, 0) : 1 // 默认Server上下文
    });
    
    const serialized = contextActionMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.ContextActionModify, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 执行上下文操作
   */
  async executeContextAction(action: string, session?: number, channel?: number): Promise<void> {
    const contextActionMessage = mumbleproto.ContextAction.fromObject({
      action: action,
      session: session,
      channel_id: channel
    });
    
    const serialized = contextActionMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.ContextAction, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 添加 Webhook 订阅
   */
  addWebhook(id: string, config: WebhookConfig): void {
    this.webhookManager.addWebhook(id, config);
  }

  /**
   * 移除 Webhook 订阅
   */
  removeWebhook(id: string): void {
    this.webhookManager.removeWebhook(id);
  }

  /**
   * 获取所有 Webhook 配置
   */
  getWebhooks(): Map<string, { url: string; events: string[] }> {
    return this.webhookManager.getWebhooks();
  }

  /**
   * 获取 ACL 管理器
   */
  getACLManager(): ACLManager {
    return this.aclManager;
  }

  /**
   * 获取性能优化器
   */
  getPerformanceOptimizer(): PerformanceOptimizer {
    return this.performanceOptimizer;
  }

  /**
   * 查询频道的 ACL
   */
  async queryACL(channelId: number) {
    return this.aclManager.queryACL(channelId);
  }

  /**
   * 检查用户权限
   */
  async checkPermission(channelId: number, permission: number, userSession?: number) {
    return this.aclManager.checkPermission(channelId, permission, userSession);
  }

  /**
   * 获取用户在频道中的所有权限
   */
  async getUserPermissions(channelId: number, userSession?: number) {
    return this.aclManager.getUserPermissions(channelId, userSession);
  }

  /**
   * 保存 ACL
   */
  async saveACL(channelId: number, acls: Array<{
    apply_here: boolean;
    apply_subs: boolean;
    inherited?: boolean;
    user_id?: number;
    group?: string;
    allow: number;
    deny: number;
  }>, groups?: Map<string, {
    name: string;
    inherited: boolean;
    inherit: boolean;
    inheritable: boolean;
    add: number[];
    remove: number[];
    inherited_members: number[];
  }>) {
    return this.aclManager.saveACL(channelId, acls, groups);
  }

  /**
   * 添加 ACL 条目
   */
  async addACLEntry(channelId: number, entry: {
    apply_here: boolean;
    apply_subs: boolean;
    user_id?: number;
    group?: string;
    allow: number;
    deny: number;
  }) {
    return this.aclManager.addACLEntry(channelId, entry);
  }

  /**
   * 移除 ACL 条目
   */
  async removeACLEntry(channelId: number, entryIndex: number) {
    return this.aclManager.removeACLEntry(channelId, entryIndex);
  }

  /**
   * 更新 ACL 条目
   */
  async updateACLEntry(channelId: number, entryIndex: number, updates: ACLEntryUpdate) {
    return this.aclManager.updateACLEntry(channelId, entryIndex, updates);
  }

  /**
   * 创建频道组
   */
  async createChannelGroup(channelId: number, groupName: string, inherited?: boolean, inheritable?: boolean) {
    return this.aclManager.createChannelGroup(channelId, groupName, inherited, inheritable);
  }

  /**
   * 删除频道组
   */
  async deleteChannelGroup(channelId: number, groupName: string) {
    return this.aclManager.deleteChannelGroup(channelId, groupName);
  }

  /**
   * 添加用户到频道组
   */
  async addUserToGroup(channelId: number, groupName: string, userId: number) {
    return this.aclManager.addUserToGroup(channelId, groupName, userId);
  }

  /**
   * 从频道组移除用户
   */
  async removeUserFromGroup(channelId: number, groupName: string, userId: number) {
    return this.aclManager.removeUserFromGroup(channelId, groupName, userId);
  }

  /**
   * 获取用户列表
   */
  getUsers(): User[] {
    return this.state.getUsers();
  }

  /**
   * 获取频道列表
   */
  getChannels(): Channel[] {
    return this.state.getChannels();
  }

  /**
   * 踢出用户
   */
  async kickUser(session: number, reason?: string): Promise<void> {
    const userRemoveMessage = mumbleproto.UserRemove.fromObject({
      session: session,
      reason: reason,
      ban: false
    });
    
    const serialized = userRemoveMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserRemove, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 封禁用户
   */
  async banUser(_session: number, reason?: string, duration?: number): Promise<void> {
    const banListMessage = mumbleproto.BanList.fromObject({
      bans: [{
        address: new Uint8Array(), // 需要从 session 获取用户的 IP
        mask: 32,
        reason: reason,
        duration: duration
      }]
    });
    
    const serialized = banListMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.BanList, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 查询封禁列表
   */
  async queryBanList(): Promise<void> {
    const banListMessage = mumbleproto.BanList.fromObject({
      query: true,
      bans: []
    });
    
    const serialized = banListMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.BanList, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 更新封禁列表
   */
  async updateBanList(bans: mumbleproto.BanList.BanEntry[]): Promise<void> {
    const banListMessage = mumbleproto.BanList.fromObject({
      query: false,
      bans: bans
    });
    
    const serialized = banListMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.BanList, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 请求用户统计信息
   */
  async requestUserStats(session: number, statsOnly: boolean = false): Promise<void> {
    const userStatsMessage = mumbleproto.UserStats.fromObject({
      session: session,
      stats_only: statsOnly,
      certificates: [],
      celt_versions: []
    });
    
    const serialized = userStatsMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserStats, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 查询注册用户
   */
  async queryUsers(query: { ids?: number[]; names?: string[] }): Promise<void> {
    const queryUsersMessage = mumbleproto.QueryUsers.fromObject({
      ids: query.ids || [],
      names: query.names || []
    });
    
    const serialized = queryUsersMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.QueryUsers, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 请求大型资源（头像、评论、频道描述）
   */
  async requestBlob(request: {
    sessionTexture?: number[];
    sessionComment?: number[];
    channelDescription?: number[];
  }): Promise<void> {
    const requestBlobMessage = mumbleproto.RequestBlob.fromObject({
      session_texture: request.sessionTexture || [],
      session_comment: request.sessionComment || [],
      channel_description: request.channelDescription || []
    });
    
    const serialized = requestBlobMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.RequestBlob, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 设置用户头像
   */
  async setTexture(texture: Buffer): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      texture: texture,
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 设置用户评论
   */
  async setComment(comment: string): Promise<void> {
    const userStateMessage = mumbleproto.UserState.fromObject({
      comment: comment,
      temporary_access_tokens: [],
      listening_channel_add: [],
      listening_channel_remove: []
    });
    
    const serialized = userStateMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.UserState, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 移动到指定频道
   */
  async moveToChannel(channelId: number): Promise<void> {
    // moveToChannel 和 joinChannel 功能相同
    return this.joinChannel(channelId);
  }

  /**
   * 发送语音包
   */
  async sendVoice(voicePacket: Buffer): Promise<void> {
    // 通过 UDPTunnel 发送语音包
    // 注意：根据 Mumble 协议，UDPTunnel 消息直接发送语音包数据
    // 不需要 protobuf 包装，这是一个性能优化
    const wrappedMessage = this.connection.wrapMessage(MessageType.UDPTunnel, voicePacket);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 获取配置
   */
  getConfig(): ClientConfig {
    return this.config;
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: ClientConfigUpdate): void {
    this.config = this.deepMerge(this.config, newConfig);
  }

  /**
   * 发送版本信息
   */
  private async sendVersion(): Promise<void> {
    const versionMessage = mumbleproto.Version.fromObject({
      version: 0x010203, // 版本号 (1.2.3)
      release: 'MuNode Client',
      os: process.platform,
      os_version: process.version
    });

    const serialized = versionMessage.serialize();
    const wrappedMessage = this.connection.wrapMessage(MessageType.Version, serialized);
    await this.connection.sendTCP(wrappedMessage);
  }

  /**
   * 加载配置
   */
  private loadConfig(userConfig?: ClientConfigUpdate): ClientConfig {
    // 默认配置
    const defaultConfig: ClientConfig = {
      connection: {
        host: 'localhost',
        port: 64738,
        autoReconnect: true,
        reconnectDelay: 1000,
        reconnectMaxDelay: 30000,
        connectTimeout: 10000
      },
      auth: {
        username: 'MuNodeClient',
        password: undefined,
        tokens: [],
        certificate: undefined,
        key: undefined
      },
      audio: {
        encoder: {
          codec: 'opus',
          bitrate: 64000,
          frameSize: 20,
          vbr: true
        },
        decoder: {
          codecs: ['opus'],
          autoDetect: true
        },
        inputSampleRate: 48000,
        outputSampleRate: 48000
      },
      api: {
        http: {
          enabled: false,
          host: 'localhost',
          port: 8080,
          cors: true
        },
        websocket: {
          enabled: false,
          path: '/ws'
        }
      },
      webhooks: [],
      logging: {
        level: 'info',
        file: undefined
      }
    };

    // 深度合并用户配置
    return this.deepMerge(defaultConfig, userConfig || {});
  }

  /**
   * 深度合并对象
   */
  private deepMerge<T extends object>(target: T, source: object): T {
    const result = { ...target } as T;

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const sourceValue = (source as {[key: string]: unknown})[key];
        const targetValue = (result as {[key: string]: unknown})[key];

        if (this.isObject(sourceValue) && this.isObject(targetValue)) {
          (result as {[key: string]: unknown})[key] = this.deepMerge(targetValue, sourceValue);
        } else if (sourceValue !== undefined) {
          (result as {[key: string]: unknown})[key] = sourceValue;
        }
      }
    }

    return result;
  }

  /**
   * 检查是否为对象
   */
  private isObject(item: unknown): item is object {
    return Boolean(item && typeof item === 'object' && !Array.isArray(item));
  }

  /**
   * 获取连接管理器 (内部使用)
   */
  getConnectionManager(): ConnectionManager {
    return this.connection;
  }

  /**
   * 获取认证管理器 (内部使用)
   */
  getAuthManager(): AuthManager {
    return this.auth;
  }

  /**
   * 获取状态管理器 (内部使用)
   */
  getStateManager(): StateManager {
    return this.state;
  }

  /**
   * 获取加密管理器 (内部使用)
   */
  getCryptoManager(): CryptoManager {
    return this.crypto;
  }

  /**
   * 获取音频管理器 (内部使用)
   */
  getAudioManager(): AudioStreamManager {
    return this.audioManager;
  }
}
