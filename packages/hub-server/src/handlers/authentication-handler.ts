import type { Logger } from '@munode/common';
import { HubPermissionChecker } from '../permission-checker.js';
import { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';


/**
 * 认证处理器接口
 */
export interface IAuthenticationHandler {
  /**
   * 处理会话ID分配
   */
  handleAllocateSessionId(params: RPCParams<'edge.allocateSessionId'>): Promise<RPCResult<'edge.allocateSessionId'>>;

  /**
   * 处理用户认证
   */
  handleAuthenticateUser(params: RPCParams<'edge.authenticateUser'>): Promise<RPCResult<'edge.authenticateUser'>>;

  /**
   * 处理会话报告
   */
  handleReportSession(params: RPCParams<'edge.reportSession'>): Promise<RPCResult<'edge.reportSession'>>;
}

/**
 * 认证处理器实现
 */
export class AuthenticationHandler implements IAuthenticationHandler {
  private factory: HubHandlerFactory;
  private permissionChecker: HubPermissionChecker;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
    this.permissionChecker = factory.getPermissionChecker();
  }

  async handleAllocateSessionId(params: RPCParams<'edge.allocateSessionId'>): Promise<RPCResult<'edge.allocateSessionId'>> {
    const sessionManager = this.factory.getSessionManager();
    const session_id = sessionManager.allocateSessionId();
    this.logger.debug(`Allocated session ID ${session_id} for Edge ${params.edge_id}`);
    return { session_id };
  }

  async handleAuthenticateUser(params: RPCParams<'edge.authenticateUser'>): Promise<RPCResult<'edge.authenticateUser'>> {
    const authManager = this.factory.getAuthManager();
    if (!authManager) {
      this.logger.error('Auth manager not initialized');
      return {
        success: false,
        reason: 'Authentication service not available',
      };
    }

    try {
      this.logger.info(`Authentication request from Edge ${params.server_id} for user: ${params.username}, session: ${params.session_id}`);

      const authResult = await authManager.authenticate({
        session_id: params.session_id,
        server_id: params.server_id,
        username: params.username,
        password: params.password,
        tokens: params.tokens || [],
        client_info: params.client_info,
      });

      return authResult;
    } catch (error) {
      this.logger.error(`Authentication error for user ${params.username}:`, error);
      return {
        success: false,
        reason: 'Internal authentication error',
      };
    }
  }

  async handleReportSession(params: RPCParams<'edge.reportSession'>): Promise<RPCResult<'edge.reportSession'>> {
    const sessionManager = this.factory.getSessionManager();
    const permissionChecker = this.factory.getPermissionChecker();
    const config = this.factory.getConfig();

    // Determine the actual channel for this user
    let actualChannelId = params.channel_id;

    // Check if Channel Ninja is enabled and the requested channel is in a ninja group
    if (config.channelNinja && config.ninjaChannels?.length > 0 && permissionChecker) {
      // Check if the channel is related to a ninja channel
      const transitiveLinks = await permissionChecker.getTransitivelyLinkedChannels(actualChannelId);
      let isNinjaRelated = false;
      for (const chId of transitiveLinks) {
        if (config.ninjaChannels.includes(chId)) {
          isNinjaRelated = true;
          break;
        }
      }

      if (isNinjaRelated) {
        // Create a temporary user info to check permissions
        const tempUserInfo = {
          session_id: params.session_id,
          user_id: params.user_id,
          cert_hash: params.cert_hash,
          channel_id: actualChannelId,
          groups: params.groups || [],
        };

        // Check if user has permission to access any channel in the ninja group
        let hasPermission = false;
        for (const chId of transitiveLinks) {
          if (await permissionChecker.canUserAccessChannel(chId, tempUserInfo)) {
            hasPermission = true;
            break;
          }
        }

        if (!hasPermission) {
          // User was in a hidden channel but no longer has permission
          // Move them to the default channel
          const defaultChannel = config.defaultChannel ?? 0;
          this.logger.info(`Channel Ninja: User ${params.username} was in ninja channel ${actualChannelId} but has no permission, moving to default channel ${defaultChannel}`);
          actualChannelId = defaultChannel;
        }
      }
    }

    // 将RPC参数转换为GlobalSession对象
    // Note: params.startTime may be a Date object or ISO string (from JSON serialization)
    const startTime = params.startTime instanceof Date ? params.startTime : new Date(params.startTime);
    // Use proper typing instead of any
    interface SessionData {
      session_id: number;
      edge_id: number;
      user_id: number;
      username: string;
      ip_address: string;
      cert_hash: string;
      is_authenticated: boolean;
      channel_id: number;
      connected_at: number;
      last_active: number;
      groups: string[];
      version?: string;
      release?: string;
      os?: string;
      os_version?: string;
      // User state fields
      mute?: boolean;
      deaf?: boolean;
      suppress?: boolean;
      self_mute?: boolean;
      self_deaf?: boolean;
      priority_speaker?: boolean;
      recording?: boolean;
    }
    const session: SessionData = {
      session_id: params.session_id,
      edge_id: params.edge_server_id,
      user_id: params.user_id,
      username: params.username,
      ip_address: params.ip_address,
      cert_hash: params.cert_hash || '',
      is_authenticated: true,
      channel_id: actualChannelId, // Use the adjusted channel
      connected_at: Math.floor(startTime.getTime() / 1000),
      last_active: Math.floor(Date.now() / 1000),
      groups: params.groups || [], // 传递用户组信息
      version: params.version,
      release: params.release,
      os: params.os,
      os_version: params.os_version,
      // Include user state fields
      mute: params.mute,
      deaf: params.deaf,
      suppress: params.suppress,
      self_mute: params.self_mute,
      self_deaf: params.self_deaf,
      priority_speaker: params.priority_speaker,
      recording: params.recording,
    };

    this.logger.info(`Session reported: ${params.username} (user_id: ${params.user_id}), groups: ${JSON.stringify(session.groups)}, channel: ${actualChannelId}`);

    // 上报会话
    sessionManager.reportSession(session);

    this.logger.info(`Session reported: ${params.username} (session=${params.session_id}, edge=${params.edge_server_id}, user_id=${params.user_id}, channel=${actualChannelId})`);

    // Handle ninja channel visibility for the userJoined broadcast
    if (config.channelNinja && config.ninjaChannels?.length > 0 && permissionChecker) {
      this.logger.debug(`Channel Ninja: Filtering userJoined broadcast for ${params.username}`);
      
      // Filter which existing users should see this new user
      const allSessions = sessionManager.getAllSessions();
      const visibleToSessions = new Map<number, number[]>(); // edge_id -> session_ids
      const newUserInfo = this.permissionChecker.sessionToUserInfo(session, actualChannelId);

      for (const otherSession of allSessions) {
        if (otherSession.session_id === session.session_id) continue;

        const otherUserInfo = this.permissionChecker.sessionToUserInfo(otherSession, otherSession.channel_id ?? 0);

        // Check if other user can see this new user
        const canSee = await permissionChecker.canUserSeeOtherUser(
          otherUserInfo,
          otherSession.channel_id ?? 0,
          actualChannelId,
          new Set(config.ninjaChannels)
        );

        if (canSee) {
          if (!visibleToSessions.has(otherSession.edge_id)) {
            visibleToSessions.set(otherSession.edge_id, []);
          }
          visibleToSessions.get(otherSession.edge_id).push(otherSession.session_id);
        }
      }

      // Send userJoined to visible sessions only
      for (const [edgeId, sessionIds] of visibleToSessions.entries()) {
        this.factory.getControlService().notify(edgeId, 'hub.userJoined', {
          session_id: params.session_id,
          edge_id: params.edge_server_id,
          user_id: params.user_id,
          username: params.username,
          channel_id: actualChannelId,
          groups: session.groups || [],
          cert_hash: session.cert_hash,
          target_sessions: sessionIds,
        });
      }

      // Also check which users the new user can see (they need to send their state to the new user)
      const usersNewUserCanSee: number[] = [];
      for (const otherSession of allSessions) {
        if (otherSession.session_id === session.session_id) continue;

        const canSee = await permissionChecker.canUserSeeOtherUser(
          newUserInfo,
          actualChannelId,
          otherSession.channel_id ?? 0,
          new Set(config.ninjaChannels)
        );

        if (canSee) {
          usersNewUserCanSee.push(otherSession.session_id);
        }
      }

      // Note: visibleUsers notification is no longer needed - Edge relies on fullSync

      this.logger.info(`Session ${params.session_id} reported with ninja filtering: visible to ${Array.from(visibleToSessions.values()).flat().length} users, can see ${usersNewUserCanSee.length} users`);
    } else {
      // Broadcast new user joined notification to all edges (no ninja filtering)
      this.logger.debug(`Broadcasting userJoined (no ninja) to all edges: ${params.username}`);

      this.factory.getControlService().broadcast('hub.userJoined', {
        session_id: params.session_id,
        edge_id: params.edge_server_id,
        user_id: params.user_id,
        username: params.username,
        channel_id: actualChannelId,
        groups: session.groups || [],
        cert_hash: session.cert_hash,
      });

      this.logger.info(`Session ${params.session_id} reported from Edge ${params.edge_server_id}, broadcasted to all edges`);
    }

    return { success: true }; // Success response
  }
}