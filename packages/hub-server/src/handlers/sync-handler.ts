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

    // Ensure channels have all required fields for protobuf
    const protobufChannels = channels.map(ch => ({
      channel_id: ch.channel_id,
      name: ch.name,
      parent_id: ch.parent_id,
      description: ch.description,
      position: ch.position,
      max_users: ch.max_users,
      temporary: ch.temporary,
      inherit_acl: ch.inherit_acl,
      links: ch.links || [],
    }));

    // Ensure sessions have all required fields for protobuf
    const protobufSessions = sessions.map(s => ({
      session_id: s.session_id,
      edge_id: s.edge_id,
      user_id: s.user_id,
      username: s.username,
      channel_id: s.channel_id,
      ip_address: s.ip_address,
      cert_hash: s.cert_hash,
      connected_at: s.connected_at,
      groups: s.groups || [],
      mute: s.mute,
      deaf: s.deaf,
      suppress: s.suppress,
      self_mute: s.self_mute,
      self_deaf: s.self_deaf,
      priority_speaker: s.priority_speaker,
      recording: s.recording,
    }));

    if (protobufSessions.length > 0) {
      const sampleCount = Math.min(3, protobufSessions.length);
      const samples = protobufSessions.slice(0, sampleCount).map(s => `${s.username}(deaf=${s.self_deaf},mute=${s.self_mute})`).join(', ');
      this.logger.debug(`[HUB-FULLSYNC] Returning ${protobufSessions.length} sessions, first ${sampleCount} states: ${samples}`);
    } else {
      this.logger.debug(`[HUB-FULLSYNC] Returning 0 sessions`);
    }

    return {
      channels: protobufChannels,
      channel_links: [], // TODO: 实现频道链接
      acls,
      bans: [], // TODO: 实现封禁数据
      sessions: protobufSessions,
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

    // 映射数据库字段到protocol字段，并加载每个频道的链接
    const channels: ChannelData[] = await Promise.all(
      dbChannels.map(ch => this.mapChannelToProtocol(ch))
    );

    // Ensure channels have all required fields for protobuf
    const protobufChannels = channels.map(ch => ({
      channel_id: ch.channel_id,
      name: ch.name,
      parent_id: ch.parent_id,
      description: ch.description,
      position: ch.position,
      max_users: ch.max_users,
      temporary: ch.temporary,
      inherit_acl: ch.inherit_acl,
      links: ch.links || [],
    }));

    return { channels: protobufChannels };
  }

  /**
   * 处理获取ACL列表
   */
  async handleGetACLs(params: RPCParams<'edge.getACLs'>): Promise<RPCResult<'edge.getACLs'>> {
    const dbAcls = this.factory.getAclManager()
      ? await this.factory.getAclManager().getChannelACLs(params.channel_id)
      : await this.factory.getDatabase().getChannelACLs(params.channel_id);
    const acls: ACLData[] = dbAcls.map((acl) => {
      const result: ACLData = {
        id: acl.id,
        channel_id: acl.channel_id,
        group: acl.group,
        apply_here: acl.apply_here,
        apply_subs: acl.apply_subs,
        allow: acl.allow,
        deny: acl.deny,
      };
      // Only include user_id if it's a valid positive number
      // Protobuf user_id is optional uint32
      if (acl.user_id && acl.user_id > 0) {
        result.user_id = acl.user_id;
      }
      return result;
    });
    return { acls };
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