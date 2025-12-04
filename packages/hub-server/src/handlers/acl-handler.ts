import { createLogger } from '@munode/common';
import { mumbleproto } from '@munode/protocol';
import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';
import { HubPermissionChecker, Permission } from '../permission-checker.js';

const logger = createLogger({ service: 'hub-acl-handler' });

/**
 * Hub ACL处理器接口
 */
export interface IACLHandler {
  handleACLRequest(params: RPCParams<'edge.handleACL'>): Promise<RPCResult<'edge.handleACL'>>;
  handlePermissionQueryRequest(params: RPCParams<'edge.handlePermissionQuery'>): Promise<RPCResult<'edge.handlePermissionQuery'>>;
  handleSaveACL(params: RPCParams<'edge.saveACL'>): Promise<RPCResult<'edge.saveACL'>>;
}

/**
 * Hub ACL处理器 - 处理ACL和权限相关的操作
 */
export class ACLHandler implements IACLHandler {
  private factory: HubHandlerFactory;
  private hubPermissionChecker: HubPermissionChecker;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.hubPermissionChecker = this.factory.getPermissionChecker();
  }

  /**
   * 处理来自 Edge 的 ACL 请求（查询或更新）
   */
  async handleACLRequest(params: RPCParams<'edge.handleACL'>): Promise<RPCResult<'edge.handleACL'>> {
    try {
      const { edge_id, actor_session, channel_id, query, raw_data } = params;

      logger.info(`Hub received ACL request from Edge ${edge_id}, actor: ${actor_session}, channel: ${channel_id}, query: ${query}`);

      if (!this.factory.getDatabase()) {
        logger.error('Database not available');
        return { success: false, error: 'Database not available' };
      }

      // 解码 ACL 消息
      const aclData = Buffer.from(raw_data, 'base64');
      const acl = mumbleproto.ACL.deserialize(aclData);

      // 获取频道信息
      const channel = this.factory.getChannelManager()
        ? this.factory.getChannelManager()!.getChannel(channel_id)
        : await this.factory.getDatabase()!.getChannel(channel_id);
      if (!channel) {
        logger.warn(`ACL for non-existent channel: ${channel_id}`);
        return { success: false, error: 'Channel not found' };
      }

      // 权限检查：需要 Write 权限（查询和修改都需要）
      // 允许三种情况（与Go实现一致）：
      // 1. 用户在目标频道有 Write 权限
      // 2. 用户在父频道有 Write 权限（如果父频道存在）
      // 3. 用户在根频道(ID=0)有 Write 权限（Murmur的管理员绕过机制）
      if (this.factory.getPermissionChecker() && this.factory.getSessionManager()) {
        const actorGlobalSession = this.factory.getSessionManager().getSession(actor_session);
        if (!actorGlobalSession) {
          logger.warn(`ACL request from unknown session: ${actor_session}`);
          return { success: false, error: 'Session not found' };
        }

        const actorUserInfo = this.hubPermissionChecker.sessionToUserInfo(actorGlobalSession, actorGlobalSession.channel_id);

        logger.debug(`ACL permission check for user ${actorUserInfo.user_id} (${actorGlobalSession.username}), groups: ${JSON.stringify(actorUserInfo.groups)}`);

        // 检查三个位置的 Write 权限
        const hasWriteOnChannel = await this.hubPermissionChecker.hasPermission(
          channel_id,
          actorUserInfo,
          Permission.Write
        );

        let hasWriteOnParent = false;
        if (channel.parent_id > 0) {
          hasWriteOnParent = await this.hubPermissionChecker.hasPermission(
            channel.parent_id,
            actorUserInfo,
            Permission.Write
          );
        }

        const hasWriteOnRoot = await this.hubPermissionChecker.hasPermission(
          0,
          actorUserInfo,
          Permission.Write
        );        const hasWritePermission = hasWriteOnChannel || hasWriteOnParent || hasWriteOnRoot;

        if (!hasWritePermission) {
          logger.warn(`ACL request denied for session ${actor_session}: no Write permission on channel ${channel.name}`);
          return {
            success: false,
            error: 'Permission denied: Write permission required',
            permission_denied: true
          };
        }

        logger.debug(`ACL request permission granted for session ${actor_session}`);
      }

      if (query) {
        // === 查询 ACL ===
        logger.debug(`Processing ACL query for channel ${channel_id}`);

        // 构建频道链：从当前频道向上遍历到根频道或不继承ACL的频道
        const channelsInChain: Array<{ id: number; inherit_acl: boolean; parent_id: number }> = [];
        let currentChannelId: number | null = channel_id;

        while (currentChannelId !== null && currentChannelId >= 0) {
          const ch = this.factory.getChannelManager()
            ? this.factory.getChannelManager()!.getChannel(currentChannelId)
            : await this.factory.getDatabase()!.getChannel(currentChannelId);
          if (!ch) break;

          channelsInChain.unshift({ id: ch.id, inherit_acl: ch.inherit_acl, parent_id: ch.parent_id });

          // 如果是当前频道或者继承ACL，且有父频道，继续向上
          if ((ch.id === channel_id || ch.inherit_acl) && ch.parent_id > 0) {
            currentChannelId = ch.parent_id;
          } else {
            break;
          }
        }

        logger.debug(`Built channel chain for ACL query: ${channelsInChain.map(c => c.id).join(' -> ')}`);

        // 收集所有相关的 ACL（包括继承的）
        const allACLs: mumbleproto.ACL.ChanACL[] = [];

        for (const iterChannel of channelsInChain) {
          const channelACLs = this.factory.getAclManager()
            ? await this.factory.getAclManager()!.getChannelACLs(iterChannel.id)
            : await this.factory.getDatabase()!.getChannelACLs(iterChannel.id);
          logger.debug(`Channel ${iterChannel.id} has ${channelACLs.length} ACL entries`);

          for (const aclEntry of channelACLs) {
            // 如果是当前频道，或者 ACL 应用于子频道，则包含此 ACL
            if (iterChannel.id === channel_id || aclEntry.apply_subs) {
              const chanACL: any = {
                apply_here: aclEntry.apply_here,
                apply_subs: aclEntry.apply_subs,
                inherited: iterChannel.id !== channel_id,
                group: aclEntry.group || undefined,
                grant: aclEntry.allow,
                deny: aclEntry.deny,
              };
              if (aclEntry.user_id && aclEntry.user_id > 0) {
                chanACL.user_id = aclEntry.user_id;
              }
              allACLs.push(new mumbleproto.ACL.ChanACL(chanACL));
            }
          }
        }

        logger.debug(`Collected ${allACLs.length} total ACL entries`);

        // 收集频道组信息（包括继承的组）
        const allGroups: mumbleproto.ACL.ChanGroup[] = [];

        if (this.factory.getChannelGroupManager()) {
          const channelGroups = await this.factory.getChannelGroupManager()!.getChannelGroups(channel_id, true);

          for (const channelGroup of channelGroups) {
            const chanGroup: any = {
              name: channelGroup.name,
              inherited: channelGroup.channel_id !== channel_id,
              inherit: channelGroup.inherit,
              inheritable: channelGroup.inheritable,
              add: channelGroup.add_members,
              remove: channelGroup.remove_members,
              inherited_members: channelGroup.inherited_members,
            };
            allGroups.push(new mumbleproto.ACL.ChanGroup(chanGroup));
          }
        }

        logger.debug(`Collected ${allGroups.length} total groups`);

        // 构建 ACL 响应 - 确保groups字段总是存在
        const aclResponse = new mumbleproto.ACL({
          channel_id,
          inherit_acls: channel.inherit_acl,
          acls: allACLs.length > 0 ? allACLs : [],
          groups: allGroups.length > 0 ? allGroups : [],
          query: false,
        });

        const responseData = aclResponse.serialize();
        logger.debug(`ACL response built: ${allACLs.length} ACLs, ${allGroups.length} groups`);

        logger.info(`ACL query completed for channel ${channel_id}`);
        return {
          success: true,
          channel_id,
          raw_data: Buffer.from(responseData).toString('base64')
        };
      } else {
        // === 更新 ACL ===
        logger.debug(`Processing ACL update for channel ${channel_id}`);

        const acls = acl.acls ?? [];

        // 转换为数据库格式
        const aclData = acls.map((aclMsg) => ({
          user_id: aclMsg.user_id,
          group: aclMsg.group || '',
          apply_here: aclMsg.apply_here !== false,
          apply_subs: aclMsg.apply_subs !== false,
          allow: aclMsg.grant || 0,
          deny: aclMsg.deny || 0,
        }));

        // 使用 ACLManager 保存 ACL
        if (this.factory.getAclManager()) {
          await this.factory.getAclManager()!.saveACLs(channel_id, aclData);
          logger.info(`ACL updated for channel ${channel_id}: ${aclData.length} entries`);
        }

        // 更新频道的 inherit_acl 设置
        if (acl.inherit_acls !== undefined && acl.inherit_acls !== channel.inherit_acl) {
          if (this.factory.getChannelManager()) {
            await this.factory.getChannelManager()!.updateChannel(channel_id, { inherit_acl: acl.inherit_acls });
          } else {
            await this.factory.getDatabase()!.updateChannel(channel_id, { inherit_acl: acl.inherit_acls });
          }
          logger.info(`Channel ${channel_id} inherit_acl updated to ${acl.inherit_acls}`);
        }

        // 处理频道组更新
        if (this.factory.getChannelGroupManager() && acl.groups && acl.groups.length > 0) {
          logger.info(`Channel ${channel_id} channel groups update requested: ${acl.groups.length} groups`);

          // 只保存非继承的组
          const channelGroupsToSave = acl.groups
            .filter(g => !g.inherited)
            .map(g => ({
              channel_id,
              name: g.name,
              inherit: g.inherit !== false,
              inheritable: g.inheritable !== false,
              add_members: g.add || [],
              remove_members: g.remove || [],
            }));

          await this.factory.getChannelGroupManager()!.saveChannelGroups(channel_id, channelGroupsToSave);
          logger.info(`Saved ${channelGroupsToSave.length} channel groups for channel ${channel_id}`);
        }

        // 通知所有 Edge 刷新该频道的权限
        // 这会触发 Edge 重新计算频道内所有用户的 suppress 状态
        logger.info(`Broadcasting ACL update notification for channel ${channel_id}`);
        this.factory.getControlService().broadcast('edge.aclUpdated', {
          channel_id,
          timestamp: Date.now(),
        });

        logger.info(`ACL update completed for channel ${channel_id}`);
        return {
          success: true,
          channel_id
        };
      }
    } catch (error) {
      logger.error('Error handling ACL request:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * 处理来自 Edge 的 PermissionQuery 请求
   */
  async handlePermissionQueryRequest(params: RPCParams<'edge.handlePermissionQuery'>): Promise<RPCResult<'edge.handlePermissionQuery'>> {
    try {
      const { edge_id, actor_session, channel_id } = params;

      logger.debug(`Hub received PermissionQuery from Edge ${edge_id}, actor: ${actor_session}, channel: ${channel_id}`);

      // 获取会话信息
      if (!this.factory.getSessionManager()) {
        logger.error('SessionManager not available');
        return { success: false, error: 'SessionManager not available' };
      }

      const actorGlobalSession = this.factory.getSessionManager().getSession(actor_session);
      if (!actorGlobalSession) {
        logger.warn(`PermissionQuery from unknown session: ${actor_session}`);
        return {
          success: false,
          error: 'Session not found'
        };
      }

      // 转换为 UserInfo
      const actorUserInfo = this.hubPermissionChecker.sessionToUserInfo(actorGlobalSession, actorGlobalSession.channel_id);

      logger.debug(`PermissionQuery for user ${actorUserInfo.user_id} (${actorGlobalSession.username}), groups: ${JSON.stringify(actorUserInfo.groups)}, channel: ${channel_id}`);

      // 计算权限
      if (!this.factory.getPermissionChecker()) {
        logger.error('PermissionChecker not available');
        return { success: false, error: 'PermissionChecker not available' };
      }

      const permissions = await this.factory.getPermissionChecker()!.calculatePermission(channel_id, actorUserInfo);

      logger.debug(`PermissionQuery result for session ${actor_session} on channel ${channel_id}: ${permissions} (0x${permissions.toString(16)})`);

      return {
        success: true,
        permissions,
      };
    } catch (error) {
      logger.error(`PermissionQuery error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      };
    }
  }

  /**
   * 处理保存ACL
   */
  async handleSaveACL(params: RPCParams<'edge.saveACL'>): Promise<RPCResult<'edge.saveACL'>> {
    if (!this.factory.getAclManager()) {
      throw new Error('ACLManager not available');
    }

    const { channel_id, acls } = params;

    console.log(acls)

    // Convert RPC ACL format to ACLManager format
    const aclData = acls.map((acl) => ({
      user_id: acl.user_id,
      group: acl.group,
      apply_here: acl.apply_here,
      apply_subs: acl.apply_subs,
      allow: acl.allow,
      deny: acl.deny,
    }));

    // Use ACLManager to save ACLs
    const aclIds = await this.factory.getAclManager()!.saveACLs(channel_id, aclData);

    return { success: true, aclIds };
  }
}