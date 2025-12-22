import type { Logger } from 'winston';
import { mumbleproto } from '@munode/protocol';
import { MessageType } from '@munode/protocol';
import type { ChannelInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';

/**
 * 消息处理器 - 处理文本消息和频道/用户列表发送
 */
export class MessageHandlers {
  private logger: Logger;

  constructor(private factory: HandlerFactory) {
    this.logger = factory.logger;
  }

  private get clientManager() { return this.factory.clientManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get config() { return this.factory.config; }
  private get hubClient() { return this.factory.hubClient; }
  private get stateManager() { return this.factory.stateManager; }

  /**
   * 处理文本消息
   * 
   * 架构说明：Edge转发到Hub进行权限检查和目标解析，Hub广播给所有Edge
   */
  handleTextMessage(session_id: number, data: Buffer): void {
    try {
      const textMessage = mumbleproto.TextMessage.decode(data);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        this.logger.warn(`TextMessage from unauthenticated session: ${session_id}`);
        return;
      }

      // 检查客户端是否已认证
      if (!actor.user_id || actor.user_id <= 0) {
        this.logger.warn(`TextMessage from unauthenticated session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        this.logger.error('TextMessage rejected: Hub client not available (standalone mode not supported)');
        this.sendPermissionDenied(session_id, 'text_message', 'Server must be connected to Hub');
        return;
      }

      // 设置发送者
      textMessage.actor = session_id;

      // 转发到Hub处理（Hub会进行权限检查、目标解析和广播）
      // 注意：参数需要扁平化，不使用嵌套的textMessage对象
      this.hubClient.notify('hub.handleTextMessage', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        session: textMessage.session || [],
        channel_id: textMessage.channel_id || [],
        tree_id: textMessage.tree_id || [],
        message: textMessage.message || '',
      });

        this.logger.debug(`Forwarded TextMessage from session ${session_id} to Hub`);
    } catch (error) {
        this.logger.error(`Error handling TextMessage for session ${session_id}:`, error);
    }
  }

  /**
   * 处理插件数据传输
   * 
   * 架构说明：Edge转发到Hub进行目标解析，Hub广播给所有Edge
   */
  handlePluginDataTransmission(session_id: number, data: Buffer): void {
    try {
      const pluginData = mumbleproto.PluginDataTransmission.decode(data);

        this.logger.debug(`Received PluginDataTransmission from session ${session_id}, dataID=${pluginData.dataID}, data.length=${pluginData.data?.length}, receivers=${pluginData.receiverSessions?.length}`);

      // 获取执行操作的客户端
      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        this.logger.warn(`PluginDataTransmission from unauthenticated session: ${session_id}`);
        return;
      }

      // 检查客户端是否已认证
      if (!actor.user_id || actor.user_id <= 0) {
        this.logger.warn(`PluginDataTransmission from unauthenticated session: ${session_id}`);
        return;
      }

      // 必须在集群模式下运行
      if (!this.hubClient) {
        this.logger.error('PluginDataTransmission rejected: Hub client not available (standalone mode not supported)');
        return;
      }

      // 设置发送者
      pluginData.senderSession = session_id;

      // 转发到Hub处理（Hub会进行目标解析和广播）
      this.hubClient.notify('hub.handlePluginDataTransmission', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        actor_username: actor.username,
        actor_channel_id: actor.channel_id,
        sender_session: session_id,
        dataID: pluginData.dataID || '',
        data: pluginData.data || Buffer.alloc(0),
        receiver_sessions: pluginData.receiverSessions || [],
      });

        this.logger.debug(`Forwarded PluginDataTransmission from session ${session_id} to Hub`);
    } catch (error) {
        this.logger.error(`Error handling PluginDataTransmission for session ${session_id}:`, error);
    }
  }

  /**
   * 获取频道的正确 parent 值（用于发送给客户端）
   * 根据 Mumble 协议规范：
   * - 根频道 (ID=0) 不应该包含 parent 字段（返回 undefined）
   * - 其他频道必须有有效的 parent_id，且不能指向自己
   * - 如果 parent_id 无效，默认使用根频道 (0)
   */
  private getChannelParentForProtocol(channel: ChannelInfo): number | undefined {
    if (channel.id === 0) {
      // 根频道不设置 parent 字段
      return undefined;
    }
    
    // 处理无效的 parent_id：-1, null, undefined, 自引用
    if (
      channel.parent_id === undefined || 
      channel.parent_id === null || 
      channel.parent_id === -1 ||
      channel.parent_id === channel.id
    ) {
      // 如果 parent_id 无效或指向自己，使用根频道作为父频道
        this.logger.warn(
        `Channel ${channel.id} (${channel.name}) has invalid parent_id=${channel.parent_id}, using root channel (0) as parent`
      );
      return 0;
    }
    
    return channel.parent_id;
  }

  /**
   * 发送频道树给客户端
   * 
   * 实现方式：模仿官方C实现（Murmur）的BFS遍历方式
   * 
   * 官方实现策略：
   * 1. 使用BFS（广度优先搜索）遍历频道树
   * 2. 在第一次遍历中，发送所有频道的完整信息（包括正确的parent、name、description等）
   * 3. 在第二次遍历中，单独发送频道链接（links）
   * 
   * 注意：Go实现使用了两次发送parent的策略，但C实现不需要
   */
  sendChannelTree(session_id: number): void {
    let channels: ChannelInfo[];

    // 在集群模式下，从stateManager获取频道（Hub同步的数据）
    if (this.stateManager) {
      const stateChannels = this.stateManager.getAllChannels();
      
        this.logger.debug(`[sendChannelTree] DEBUG: stateManager.getAllChannels() returned ${stateChannels.length} channels`);
      stateChannels.forEach(ch => {
        this.logger.debug(`[sendChannelTree] DEBUG: Channel from state: id=${ch.channel_id}, name=${ch.name}, parent_id=${ch.parent_id}`);
      });
      
      // 转换ChannelData为ChannelInfo
      channels = stateChannels.map((ch) => ({
        id: ch.channel_id,
        name: ch.name,
        parent_id: ch.channel_id === 0 ? -1 : (ch.parent_id ?? 0),
        description: ch.description || '',
        position: ch.position || 0,
        max_users: ch.max_users || 0,
        temporary: ch.temporary || false,
        inherit_acl: ch.inherit_acl !== false, // 默认 true
        children: [],
        links: ch.links || [],
      }));
      
        this.logger.debug(
        `[sendChannelTree] Cluster mode: sending ${channels.length} channels from stateManager to session ${session_id}`
      );
    } else {
      channels = [];
    }

    if (!channels || channels.length === 0) {
        this.logger.warn(`[sendChannelTree] No channels to send`);
      return;
    }

    // 构建频道映射和父子关系
    const channelMap = new Map<number, ChannelInfo>();
    const childrenMap = new Map<number, ChannelInfo[]>();
    
    for (const channel of channels) {
      channelMap.set(channel.id, channel);
      
      // 初始化children数组
      if (!childrenMap.has(channel.id)) {
        childrenMap.set(channel.id, []);
      }
      
      // 添加到父频道的children列表
      const parentId = channel.id === 0 ? -1 : (channel.parent_id ?? 0);
      if (parentId >= 0 && parentId !== channel.id) {
        if (!childrenMap.has(parentId)) {
          childrenMap.set(parentId, []);
        }
        childrenMap.get(parentId).push(channel);
      }
    }

        this.logger.debug(`[sendChannelTree] Starting BFS channel tree traversal for session ${session_id}`);

    // === Pass 1: BFS遍历发送所有频道的完整信息 ===
    const queue: ChannelInfo[] = [];
    const visited = new Set<number>();
    const channelsToSendLinks: ChannelInfo[] = [];
    
    // 从根频道开始
    const rootChannel = channelMap.get(0);
    if (!rootChannel) {
        this.logger.error('[sendChannelTree] Root channel (ID=0) not found!');
      return;
    }
    
    queue.push(rootChannel);
    visited.add(0);
    
    while (queue.length > 0) {
      const channel = queue.shift();
      
      // 准备ChannelState消息
      const parentId = this.getChannelParentForProtocol(channel);
      
      // 构造ChannelState对象 - 注意：根频道不应该设置parent字段
      // ts-proto requires all repeated fields to be arrays (not undefined)
      const channelStateData: any = {
        channel_id: channel.id,
        name: channel.name,
        description: channel.description || '',
        position: channel.position,
        temporary: channel.temporary,
        max_users: channel.max_users || 0,
        // ts-proto's encoder will iterate over these fields, so they must be arrays
        links: [],
        links_add: [],
        links_remove: [],
      };
      
      // 只有非根频道才设置parent
      if (parentId !== undefined) {
        channelStateData.parent = parentId;
      }
      
      const channelStateMessage = mumbleproto.ChannelState.encode(channelStateData).finish();

        this.logger.debug(
        `[sendChannelTree] BFS: channel ${channel.id} (${channel.name}), ` +
        `parent=${parentId === undefined ? 'NONE' : parentId}, ` +
        `has_parent=${channelStateData.parent !== undefined}, ` +
        `pos=${channel.position}`
      );

      this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(channelStateMessage));
      
      // 如果有links，记录下来稍后发送
      if (channel.links && channel.links.length > 0) {
        channelsToSendLinks.push(channel);
      }
      
      // 将子频道加入队列（按position排序）
      const children = childrenMap.get(channel.id) || [];
      children.sort((a, b) => (a.position || 0) - (b.position || 0));
      
      for (const child of children) {
        if (!visited.has(child.id)) {
          visited.add(child.id);
          queue.push(child);
        }
      }
    }

    // === Pass 2: 发送频道链接 ===
    for (const channel of channelsToSendLinks) {
      const channelStateMessage = mumbleproto.ChannelState.encode({
        channel_id: channel.id,
        links_add: channel.links || [],  // Ensure it's always an array for ts-proto
        links: [],  // Must provide empty array for ts-proto encoder
        links_remove: [],  // Must provide empty array for ts-proto encoder
      } as any).finish();

        this.logger.debug(
        `[sendChannelTree] Links: channel ${channel.id} links: [${channel.links.join(', ')}]`
      );

      this.messageHandler.sendMessage(session_id, MessageType.ChannelState, Buffer.from(channelStateMessage));
    }

        this.logger.info(
      `[sendChannelTree] Completed BFS channel tree traversal. Sent ${visited.size} channels (${channelsToSendLinks.length} with links) to session ${session_id}`
    );
  }

  /**
   * 发送用户列表给新认证的客户端（不包括自己）
   * 权限规则：只有已注册用户才能看到其他用户的证书哈希
   */
  async sendUserListToClient(session_id: number): Promise<void> {
    const receiverClient = this.clientManager.getClient(session_id);
    if (!receiverClient) {
        this.logger.warn(`Client session ${session_id} not found for sendUserList`);
      return;
    }
    
    // 只有已注册用户才能看到证书哈希
    const receiverIsRegistered = receiverClient.user_id > 0;

    // 从Hub获取全部用户会话信息，传递请求用户的信息用于ninja频道过滤
    if (this.hubClient && this.hubClient.isConnected()) {
      try {
        const syncData = await this.hubClient.call('edge.fullSync', {
          for_user_id: receiverClient.user_id,
          for_user_groups: receiverClient.groups || [],
          for_user_channel_id: receiverClient.channel_id,
          for_user_cert_hash: receiverClient.cert_hash,
        });
        const allSessions = syncData.sessions || [];
        
        let sentCount = 0;
        for (const session of allSessions) {
          // 发送所有其他已认证用户的状态（不包括自己）
          if (session.user_id > 0 && session.session_id !== session_id) {
            const userStateData: {
              session: number;
              user_id: number;
              name: string;
              channel_id: number;
              temporary_access_tokens: string[];
              listening_channel_add: number[];
              listening_channel_remove: number[];
              hash?: string;
              mute?: boolean;
              deaf?: boolean;
              suppress?: boolean;
              self_mute?: boolean;
              self_deaf?: boolean;
              priority_speaker?: boolean;
              recording?: boolean;
            } = {
              session: session.session_id,
              user_id: session.user_id,
              name: session.username,
              channel_id: session.channel_id,
              temporary_access_tokens: [],
              listening_channel_add: [],
              listening_channel_remove: [],
            };
            
            // 只有已注册用户才能看到证书哈希
            if (session.cert_hash && receiverIsRegistered) {
              userStateData.hash = session.cert_hash;
            }
            // 只添加值为 true 的状态字段（参考 Murmur 实现）
            // 注意：deaf 和 self_deaf 可以与 mute/self_mute 同时存在，不使用 else if
            if (session.deaf === true) {
              userStateData.deaf = true;
            }
            if (session.mute === true) {
              userStateData.mute = true;
            }
            if (session.suppress === true) userStateData.suppress = true;
            if (session.priority_speaker === true) userStateData.priority_speaker = true;
            if (session.recording === true) userStateData.recording = true;
            if (session.self_deaf === true) {
              userStateData.self_deaf = true;
            }
            if (session.self_mute === true) {
              userStateData.self_mute = true;
            }
            
            this.logger.debug(`[EDGE-USERLIST] Sending user ${session.username}(${session.session_id}) to client ${session_id}: self_deaf=${userStateData.self_deaf}, self_mute=${userStateData.self_mute}, raw_session_state={self_deaf=${session.self_deaf}, self_mute=${session.self_mute}}`);
            
            const userStateMessage = mumbleproto.UserState.encode(userStateData).finish();
            this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(userStateMessage)); 
            sentCount++;
          }
        }
        
        this.logger.debug(`Sent user list to session ${session_id} (${sentCount} users, receiver_registered=${receiverIsRegistered})`);
      } catch (error) {
        this.logger.error(`Failed to get user list from Hub for session ${session_id}:`, error);
        this.sendLocalUserListToClient(session_id);
      }
    } else {
        this.logger.warn(`Hub not connected, sending local users only to session ${session_id}`);
      this.sendLocalUserListToClient(session_id);
    }
  }

  /**
   * Fallback: 只发送本地Edge的用户列表（降级方案）
   * 注意：这个方案不推荐使用，因为无法应用 Hub 的权限检查
   */
  private sendLocalUserListToClient(session_id: number): void {
    const clients = this.clientManager.getAllClients();

    // 获取接收方信息，判断是否为注册用户
    const receiver = this.clientManager.getClient(session_id);
    const receiverIsRegistered = receiver && receiver.user_id > 0;

    for (const client of clients) {
      // 发送所有其他已认证的客户端状态（不包括自己）
      // 注意：降级模式下不发送敏感信息（如证书哈希）
      if (client.user_id > 0 && client.session !== session_id) {
        const userStateData: any = {
          session: client.session,
          name: client.username,
          user_id: client.user_id,
          channel_id: client.channel_id,
        };
        
        // 🔒 证书哈希只发送给已注册用户
        if (client.cert_hash && receiverIsRegistered) {
          userStateData.hash = client.cert_hash;
        }
        
        // 添加其他字段
        if (client.mute) userStateData.mute = client.mute;
        if (client.deaf) userStateData.deaf = client.deaf;
        if (client.suppress) userStateData.suppress = client.suppress;
        if (client.self_mute) userStateData.self_mute = client.self_mute;
        if (client.self_deaf) userStateData.self_deaf = client.self_deaf;
        if (client.priority_speaker) userStateData.priority_speaker = client.priority_speaker;
        if (client.recording) userStateData.recording = client.recording;

        const userStateMessage = mumbleproto.UserState.encode(userStateData).finish();
        this.messageHandler.sendMessage(session_id, MessageType.UserState, Buffer.from(userStateMessage)); 
      }
    }
    
        this.logger.debug(`Sent local user list to session ${session_id} (${clients.filter(c => c.user_id > 0 && c.session !== session_id).length} users, registered=${receiverIsRegistered})`);
  }

  /**
   * 发送权限拒绝消息
   */
  sendPermissionDenied(
    session_id: number,
    permission: string,
    reason: string,
    channel_id?: number,
    type?: number
  ): void {
    try {
      // 构建 mumbleproto.PermissionDenied 消息
      const permissionDenied: Partial<{
        reason: string;
        session: number;
        type: number;
        permission?: number;
        channel_id?: number;
        name?: string;
      }> = {
        reason: reason,
        session: session_id,
        type: type,
        permission: undefined,
        channel_id: channel_id,
      };

      // 设置 DenyType
      if (type !== undefined) {
        permissionDenied.type = type;
      } else if (permission === 'Text' || permission === 'text') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.Text;
      } else if (permission === 'SuperUser' || permission === 'superuser') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.SuperUser;
      } else if (permission === 'ChannelName' || permission === 'channel_name') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.ChannelName;
      } else if (permission === 'TextTooLong' || permission === 'text_too_long') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.TextTooLong;
      } else if (permission === 'TemporaryChannel' || permission === 'temporary_channel') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.TemporaryChannel;
      } else if (permission === 'MissingCertificate' || permission === 'missing_certificate') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.MissingCertificate;
      } else if (permission === 'UserName' || permission === 'username') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.UserName;
      } else if (permission === 'ChannelFull' || permission === 'channel_full') {
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.ChannelFull;
      } else {
        // 默认为 Permission 类型
        permissionDenied.type = mumbleproto.PermissionDenied_DenyType.Permission;

        // 尝试将权限字符串转换为权限位
        const permissionMap: { [key: string]: number } = {
          write: 0x00001,
          traverse: 0x00002,
          enter: 0x00004,
          speak: 0x00008,
          mutedeafen: 0x00010,
          move: 0x00020,
          make_channel: 0x00040,
          link_channel: 0x00080,
          whisper: 0x00100,
          text_message: 0x00200,
          temp_channel: 0x00400,
          kick: 0x10000,
          ban: 0x20000,
          register: 0x40000,
          self_register: 0x80000,
        };

        const permissionBit = permissionMap[permission.toLowerCase()];
        if (permissionBit !== undefined) {
          permissionDenied.permission = permissionBit;
        }
      }

      // 编码并发送消息
      const message = mumbleproto.PermissionDenied.encode(permissionDenied).finish();
      this.messageHandler.sendMessage(session_id, MessageType.PermissionDenied, Buffer.from(message));

        this.logger.warn(
        `Permission denied for session ${session_id}: type=${permissionDenied.type}, permission=${permission}, reason=${reason}, channel=${channel_id || 'N/A'}`
      );
    } catch (error) {
        this.logger.error(`Error sending mumbleproto.PermissionDenied to session ${session_id}:`, error);
    }
  }

  /**
   * 发送拒绝消息
   */
  sendReject(
    session_id: number,
    reason: string,
    rejectType: mumbleproto.Reject_RejectType = mumbleproto.Reject_RejectType.None
  ): void {
        this.logger.debug(`Sending reject to session ${session_id}: type=${rejectType}, reason=${reason}`);

    const rejectMessage = mumbleproto.Reject.encode({
      type: rejectType,
      reason: reason,
    } as any).finish();

    this.messageHandler.sendMessage(session_id, MessageType.Reject, Buffer.from(rejectMessage));
  }

  /**
   * 广播用户状态给所有已认证的客户端
   * 类似 Go 实现的 broadcastProtoMessageWithPredicate
   * 
   * 权限说明：
   * - 如果 UserState 包含 certificate hash，只发送给已注册用户
   * - 参考 Go 实现: if connectedClient.HasCertificate() && client.IsRegistered()
   */
  broadcastUserStateToAuthenticatedClients(
    userState: mumbleproto.UserState,
    excludeSession?: number
  ): void {
    const clients = this.clientManager.getAllClients();
    
    // 检查 UserState 是否包含证书哈希
    const hasCertHash = userState !== undefined && userState.hash;
    
    if (hasCertHash) {
      // 如果包含证书哈希，需要根据接收方权限单独发送
      let broadcastCount = 0;
      for (const client of clients) {
        // 只广播给已收到完整用户列表的客户端，排除指定的会话
        if (client !== undefined && client.session !== excludeSession) {
          const receiverIsRegistered = client.user_id > 0;
          
          if (receiverIsRegistered) {
            // 已注册用户：发送完整的 UserState（包含证书哈希）
            const serializedState = mumbleproto.UserState.encode(userState).finish();
            this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(serializedState));
            broadcastCount++;
          } else {
            // 未注册用户：需要克隆 UserState 并移除证书哈希
            const stateWithoutHash = { ...userState, hash: undefined };
            
            const serializedState = mumbleproto.UserState.encode(stateWithoutHash).finish();
            this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(serializedState));
            broadcastCount++;
          }
        }
      }
      
        this.logger.debug(
        `Broadcasted UserState (with cert_hash permission check) to ${broadcastCount} authenticated clients`
      );
    } else {
      // 如果不包含证书哈希，可以直接广播给所有人
      const serializedState = mumbleproto.UserState.encode(userState).finish();
      
      for (const client of clients) {
        // 只广播给已收到完整用户列表的客户端，排除指定的会话
        if (client !== undefined && client.session !== excludeSession) {
          this.messageHandler.sendMessage(client.session, MessageType.UserState, Buffer.from(serializedState));
        }
      }
      
        this.logger.debug(
        `Broadcasted UserState to ${clients.filter(c => c !== undefined && c.session !== excludeSession).length} authenticated clients`
      );
    }
  }

}
