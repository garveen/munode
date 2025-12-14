import type { Logger } from '@munode/common';
import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult, ChannelData, ACLData, GlobalSession } from '@munode/protocol';


/**
 * Hub 同步处理器接口
 */
export interface ISyncHandler {
  handleFullSync(params: RPCParams<'edge.fullSync'>): Promise<RPCResult<'edge.fullSync'>>;
  handleGetChannels(params: RPCParams<'edge.getChannels'>): Promise<RPCResult<'edge.getChannels'>>;
  handleGetACLs(params: RPCParams<'edge.getACLs'>): Promise<RPCResult<'edge.getACLs'>>;
}

/**
 * Hub 同步处理器 - 处理数据同步相关的操作
 */
export class SyncHandler implements ISyncHandler {
  private factory: HubHandlerFactory;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
  }

  /**
   * 处理完整同步
   */
  async handleFullSync(params: RPCParams<'edge.fullSync'>): Promise<RPCResult<'edge.fullSync'>> {
    // 获取所有频道
    let dbChannels;
    if (this.factory.getChannelManager()) {
      dbChannels = this.factory.getChannelManager().getAllChannels();
    } else {
      dbChannels = await this.factory.getDatabase().getAllChannels();
    }

    // 映射数据库字段到protocol字段，并加载每个频道的链接
    const channels: ChannelData[] = await Promise.all(
      dbChannels.map(ch => this.mapChannelToProtocol(ch))
    );

    // 获取所有会话（从内存中的 sessionManager 获取当前活跃会话）
    let sessions: GlobalSession[] = this.factory.getSessionManager().getAllSessions();

    // If ninja channels are configured and user info is provided, filter sessions
    const channelNinjaEnabled = this.factory.getConfig().channelNinja ?? false;
    const hasNinjaChannels = (this.factory.getConfig().ninjaChannels?.length ?? 0) > 0;

    if (channelNinjaEnabled && hasNinjaChannels && this.factory.getPermissionChecker() &&
        params.for_user_id !== undefined && params.for_user_id > 0) {
      this.logger.debug(`Channel Ninja: Filtering fullSync sessions for user_id=${params.for_user_id}`);

      // Create user info for the requesting user
      const requestingUserInfo = {
        session_id: 0, // Not important for permission check
        user_id: params.for_user_id,
        cert_hash: params.for_user_cert_hash,
        channel_id: params.for_user_channel_id ?? 0,
        groups: params.for_user_groups || [],
      };

      // Filter sessions to only include users the requesting user can see
      const filteredSessions: GlobalSession[] = [];
      for (const session of sessions) {
        const canSee = await this.factory.getPermissionChecker().canUserSeeOtherUser(
          requestingUserInfo,
          requestingUserInfo.channel_id,
          session.channel_id ?? 0,
          new Set(this.factory.getConfig().ninjaChannels || [])
        );

        if (canSee) {
          filteredSessions.push(session);
        } else {
          this.logger.debug(`Channel Ninja: Hiding session ${session.session_id} (${session.username}) from user ${params.for_user_id}`);
        }
      }

      this.logger.info(`Channel Ninja: Filtered sessions for user ${params.for_user_id}: ${sessions.length} -> ${filteredSessions.length}`);
      sessions = filteredSessions;
    }

    // 获取所有Edge
    const dbEdges = await this.factory.getDatabaseOperations().getActiveEdges();
    const edges = dbEdges.map((edge) => ({
      server_id: edge.server_id,
      name: edge.name,
      host: edge.host,
      port: edge.port,
      region: edge.region,
      current_load: edge.current_load,
      capacity: edge.capacity,
    }));

    // 获取所有ACL
    const dbAcls = await this.factory.getDatabaseOperations().getAllChannelACLs();
    const acls: ACLData[] = dbAcls.map((acl) => ({
      id: acl.id,
      channel_id: acl.channel_id,
      user_id: acl.user_id !== undefined && acl.user_id >= 0 ? acl.user_id : undefined, // Skip negative user_ids
      group: acl.group,
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));

    return {
      channels,
      channelLinks: [], // TODO: 实现频道链接
      acls,
      bans: [], // TODO: 实现封禁数据
      sessions,
      configs: {}, // TODO: 实现配置数据
      timestamp: Date.now(),
      sequence: 0,
      edges,
    };
  }

  /**
   * 处理获取频道列表
   */
  async handleGetChannels(_params: RPCParams<'edge.getChannels'>): Promise<RPCResult<'edge.getChannels'>> {
    // Use ChannelManager if available, otherwise fall back to direct database access
    let dbChannels;
    if (this.factory.getChannelManager()) {
      dbChannels = this.factory.getChannelManager().getAllChannels();
    } else {
      dbChannels = await this.factory.getDatabase().getAllChannels();
    }

    // DEBUG: 打印从数据库/ChannelManager获取的原始数据
    this.logger.info(`[handleGetChannels] Got ${dbChannels.length} channels from ${this.factory.getChannelManager() ? 'ChannelManager' : 'Database'}`);
    for (const ch of dbChannels) {
      this.logger.info(`[handleGetChannels] Raw channel: id=${ch.id}, name=${ch.name}, parent_id=${ch.parent_id}, keys=${Object.keys(ch).join(',')}`);
    }

    // 映射数据库字段到protocol字段，并加载每个频道的链接
    const channels: ChannelData[] = await Promise.all(
      dbChannels.map(ch => this.mapChannelToProtocol(ch))
    );

    // DEBUG: 打印映射后的数据
    for (const ch of channels) {
      this.logger.info(`[handleGetChannels] Mapped channel: channel_id=${ch.channel_id}, name=${ch.name}, parent_id=${ch.parent_id}`);
    }

    return { success: true, channels };
  }

  /**
   * 处理获取ACL列表
   */
  async handleGetACLs(params: RPCParams<'edge.getACLs'>): Promise<RPCResult<'edge.getACLs'>> {
    const dbAcls = this.factory.getAclManager()
      ? await this.factory.getAclManager().getChannelACLs(params.channel_id)
      : await this.factory.getDatabase().getChannelACLs(params.channel_id);
    const acls: ACLData[] = dbAcls.map((acl) => ({
      id: acl.id,
      channel_id: acl.channel_id,
      user_id: acl.user_id,
      group: acl.group,
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));
    return { success: true, acls };
  }

  /**
   * Helper method to load channel links for a single channel
   * @private
   */
  private async loadChannelLinks(channelId: number): Promise<number[]> {
    try {
      if (this.factory.getChannelManager()) {
        return await this.factory.getChannelManager().getChannelLinks(channelId);
      } else {
        return await this.factory.getDatabase().getChannelLinks(channelId);
      }
    } catch (error) {
      this.logger.warn(`Failed to get links for channel ${channelId}:`, error);
      return [];
    }
  }

  /**
   * Helper method to convert database/manager channel to protocol ChannelData with links
   * @private
   */
  private async mapChannelToProtocol(ch: 
    | { id: number; name: string; position: number; max_users: number; parent_id: number; inherit_acl: number; description_blob?: string }
    | { channel_id: number; name: string; position: number; max_users: number; parent_id: number; inherit_acl: boolean; description_blob?: string }
  ): Promise<ChannelData> {
    const channelId = 'channel_id' in ch ? ch.channel_id : ch.id;
    const links = await this.loadChannelLinks(channelId);

    return {
      channel_id: channelId,
      name: channelId === 0 ? (this.factory.getConfig().registerName || 'Root') : ch.name,
      parent_id: ch.parent_id >= 0 ? ch.parent_id : undefined, // Skip negative parent_ids (root channel)
      position: ch.position,
      max_users: ch.max_users,
      inherit_acl: typeof ch.inherit_acl === 'boolean' ? ch.inherit_acl : (ch.inherit_acl === 1),
      description: ch.description_blob,
      temporary: false, // 从数据库加载的频道都不是临时频道
      links,
    };
  }
}