import type { Logger } from '@munode/common';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';
import type { GlobalSessionManager } from '../session-manager.js';
import type { HubConfig } from '../types.js';
import type { PermWorkerChannel, PermWorkerACLEntry, PermWorkerUserInfo } from '../permission-worker.js';


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

}

/**
 * 认证处理器实现
 */
export class AuthenticationHandler implements IAuthenticationHandler {
  private factory: HubHandlerFactory;
  private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
  }

  handleAllocateSessionId(params: RPCParams<'edge.allocateSessionId'>): Promise<RPCResult<'edge.allocateSessionId'>> {
    const sessionManager = this.factory.getSessionManager();
    const session_id = sessionManager.allocateSessionId();
    this.logger.debug(`Allocated session ID ${session_id} for Edge ${params.edge_id}`);
    return Promise.resolve({ session_id });
  }

  async handleAuthenticateUser(params: RPCParams<'edge.authenticateUser'>): Promise<RPCResult<'edge.authenticateUser'>> {
    const authManager = this.factory.getAuthManager();
    if (!authManager) {
      this.logger.error('Auth manager not initialized');
      return {
        success: false,
        reason: 'Authentication service not available',
        groups: [],
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

      // 如果认证失败，直接返回，确保包含必需的groups字段
      if (!authResult.success) {
        return {
          success: authResult.success,
          user_id: authResult.user_id,
          username: authResult.username,
          display_name: authResult.display_name,
          groups: authResult.groups || [],
          reason: authResult.reason,
          reject_type: authResult.reject_type,
        };
      }

      // 认证成功，处理 session 创建和频道分配
      const sessionManager = this.factory.getSessionManager();
      const permissionChecker = this.factory.getPermissionChecker();
      const config = this.factory.getConfig();
      const db = this.factory.getDatabase();

      // 确定目标频道：优先使用 last channel，否则使用默认频道
      let actualChannelId = config.default_channel ?? 0;
      
      // 如果用户已注册，尝试获取上次登录的频道
      if (authResult.user_id && authResult.user_id > 0) {
        try {
          const lastChannelId = await db.getUserLastChannel(authResult.user_id);
          if (lastChannelId > 0) {
            const lastChannel = await db.getChannel(lastChannelId);
            if (lastChannel) {
              // 检查用户是否有 Enter 权限
              const userInfo = {
                session_id: params.session_id,
                user_id: authResult.user_id,
                cert_hash: params.client_info.certificate_hash || '',
                channel_id: lastChannelId,
                groups: authResult.groups || [],
              };
              
              const hasEnterPermission = await permissionChecker.hasPermission(
                lastChannelId,
                userInfo,
                Permission.Enter
              );
              
              if (hasEnterPermission) {
                actualChannelId = lastChannelId;
                this.logger.debug(`User ${params.username} (${authResult.user_id}) restored to last channel ${lastChannelId}`);
              } else {
                this.logger.info(`User ${params.username} (${authResult.user_id}) has no Enter permission for last channel ${lastChannelId}, using default channel`);
              }
            }
          }
        } catch (error) {
          this.logger.error(`Failed to get last channel for user ${authResult.user_id}:`, error);
        }
      }

      // 检查 Channel Ninja
      if (config.channel_ninja && config.ninja_channels?.length > 0 && permissionChecker) {
        const transitiveLinks = await permissionChecker.getTransitivelyLinkedChannels(actualChannelId);
        let isNinjaRelated = false;
        for (const chId of transitiveLinks) {
          if (config.ninja_channels.includes(chId)) {
            isNinjaRelated = true;
            break;
          }
        }

        if (isNinjaRelated) {
          const tempUserInfo = {
            session_id: params.session_id,
            user_id: authResult.user_id || 0,
            cert_hash: params.client_info.certificate_hash || '',
            channel_id: actualChannelId,
            groups: authResult.groups || [],
          };

          let hasPermission = false;
          for (const chId of transitiveLinks) {
            if (await permissionChecker.canUserAccessChannel(chId, tempUserInfo)) {
              hasPermission = true;
              break;
            }
          }

          if (!hasPermission) {
            const defaultChannel = config.default_channel ?? 0;
            this.logger.info(`Channel Ninja: User ${params.username} was in ninja channel ${actualChannelId} but has no permission, moving to default channel ${defaultChannel}`);
            actualChannelId = defaultChannel;
          }
        }
      }

      // 创建 session with default state values (all false)
      // Client will send UserState message after authentication to set actual states
      // This matches C++ Murmur behavior where User is created with bSelfMute=false, bSelfDeaf=false
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
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        self_mute?: boolean;
        self_deaf?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
      }

      // 检查用户在目标频道的 ACL 权限，自动设置 suppress 状态
      const tempUserInfo = {
        session_id: params.session_id,
        user_id: authResult.user_id || 0,
        cert_hash: params.client_info.certificate_hash || '',
        channel_id: actualChannelId,
        groups: authResult.groups || [],
      };
      
      const hasSpeak = await permissionChecker.hasPermission(
        actualChannelId,
        tempUserInfo,
        Permission.Speak
      );
      
      // 如果用户没有 Speak 权限，自动设置 suppress = true
      const initialSuppress = !hasSpeak;
      if (initialSuppress) {
        this.logger.info(`User ${params.username} lacks Speak permission in channel ${actualChannelId}, setting initial suppress=true`);
      }

      const session: SessionData = {
        session_id: params.session_id,
        edge_id: params.server_id,
        user_id: authResult.user_id || 0,
        username: authResult.display_name || authResult.username || params.username,
        ip_address: params.client_info.ip_address,
        cert_hash: params.client_info.certificate_hash || '',
        is_authenticated: true,
        channel_id: actualChannelId,
        connected_at: Math.floor(Date.now() / 1000),
        last_active: Math.floor(Date.now() / 1000),
        groups: authResult.groups || [],
        version: params.client_info.version?.toString(),
        release: params.client_info.release,
        os: params.client_info.os,
        os_version: params.client_info.os_version,
        // Set suppress based on ACL
        suppress: initialSuppress,
        // Include preConnect state from params if provided
        mute: params.mute,
        deaf: params.deaf,
        self_mute: params.self_mute,
        self_deaf: params.self_deaf,
        priority_speaker: params.priority_speaker,
        recording: params.recording,
      };

      this.logger.info(`Session created: ${params.username} (user_id: ${authResult.user_id}), groups: ${JSON.stringify(session.groups)}, channel: ${actualChannelId}`);

      // 注册 session
      sessionManager.reportSession(session);

      // 广播 userJoined（处理 Channel Ninja 可见性）
      await this.broadcastUserJoined(session, config, permissionChecker, sessionManager);

      // 异步计算该用户对所有频道的进入权限，完成后通知对应 Edge
      this.triggerChannelEnterPermissions(
        params.server_id,
        params.session_id,
        session.user_id,
        params.client_info.certificate_hash || '',
        actualChannelId,
        session.groups,
      ).catch(err => this.logger.error('triggerChannelEnterPermissions failed:', err));

      // Return authentication result, including target channel and initial state flags
      return {
        success: authResult.success,
        user_id: authResult.user_id,
        username: authResult.username,
        display_name: authResult.display_name,
        groups: authResult.groups || [],
        reason: authResult.reason,
        reject_type: authResult.reject_type,
        channel_id: actualChannelId,
        // Initial state flags from session
        mute: session.mute,
        deaf: session.deaf,
        suppress: session.suppress,
        self_mute: session.self_mute,
        self_deaf: session.self_deaf,
        priority_speaker: session.priority_speaker,
        recording: session.recording,
        // Server configuration
        cert_required: config.cert_required,
      } satisfies RPCResult<'edge.authenticateUser'>;
    } catch (error) {
      this.logger.error(`Authentication error for user ${params.username}:`, error);
      return {
        success: false,
        reason: 'Internal authentication error',
        groups: [],
      };
    }
  }



  /**
   * 在独立 Worker 线程中批量计算用户对全部频道的进入权限，
   * 计算完成后通过 Hub→Edge 通知推送给对应 Edge，
   * Edge 再以独立 ChannelState 消息更新客户端。
   */
  private async triggerChannelEnterPermissions(
    edgeId: number,
    sessionId: number,
    userId: number,
    certHash: string,
    channelId: number,
    groups: string[],
  ): Promise<void> {
    const channelManager = this.factory.getChannelManager();
    const aclManager = this.factory.getAclManager();
    const workerManager = this.factory.getPermissionWorkerManager();
    const controlService = this.factory.getControlService();

    // 从缓存取全部频道
    const allChannels = channelManager.getAllChannels();

    // 将 HubChannelData 转换为 PermWorkerChannel
    const workerChannels: PermWorkerChannel[] = allChannels.map(ch => ({
      id: ch.channel_id,
      parent_id: ch.parent_id ?? 0,
      inherit_acl: ch.inherit_acl ?? true,
    }));

    // 通过 ACLManager 读取全量 ACL（带缓存，acl 更新时自动失效）
    const allACLs = await aclManager.getAllChannelACLs();
    const aclMap = new Map<number, PermWorkerACLEntry[]>();
    for (const acl of allACLs) {
      const list = aclMap.get(acl.channel_id) ?? [];
      list.push({
        channel_id: acl.channel_id,
        user_id: acl.user_id,
        group: acl.group,
        apply_here: acl.apply_here,
        apply_subs: acl.apply_subs,
        allow: acl.allow,
        deny: acl.deny,
      });
      aclMap.set(acl.channel_id, list);
    }

    const userInfo: PermWorkerUserInfo = {
      session_id: sessionId,
      user_id: userId,
      cert_hash: certHash,
      channel_id: channelId,
      groups,
    };

    const results = await workerManager.calculateBulkEnterPermissions(workerChannels, aclMap, userInfo);

    // 通知对应 Edge，Edge 侧再将其转化为 ChannelState 消息推送给客户端
    controlService.notify(edgeId, 'hub.channelEnterPermissions', {
      session_id: sessionId,
      permissions: results,
    });

    this.logger.debug(
      `Sent channelEnterPermissions for session ${sessionId} to edge ${edgeId}: ${results.length} channels`,
    );
  }

  /**
   * 广播用户加入通知（处理 Channel Ninja 可见性）
   */
  private async broadcastUserJoined(
    session: {
      session_id: number;
      edge_id: number;
      user_id: number;
      username: string;
      channel_id: number;
      groups: string[];
      cert_hash: string;
      ip_address: string;
      is_authenticated: boolean;
      connected_at: number;
      last_active: number;
      mute?: boolean;
      deaf?: boolean;
      suppress?: boolean;
      self_mute?: boolean;
      self_deaf?: boolean;
      priority_speaker?: boolean;
      recording?: boolean;
    },
    config: HubConfig,
    permissionChecker: HubPermissionChecker,
    sessionManager: GlobalSessionManager
  ): Promise<void> {
    if (config.channel_ninja && config.ninja_channels?.length > 0) {
      this.logger.debug(`Channel Ninja: Filtering userJoined broadcast for ${session.username}`);
      
      const allSessions = sessionManager.getAllSessions();
      const visibleToSessions = new Map<number, number[]>();

      for (const otherSession of allSessions) {
        if (otherSession.session_id === session.session_id) continue;

        const otherUserInfo = permissionChecker.sessionToUserInfo(otherSession, otherSession.channel_id ?? 0);
        const canSee = await permissionChecker.canUserSeeOtherUser(
          otherUserInfo,
          otherSession.channel_id ?? 0,
          session.channel_id,
          new Set(config.ninja_channels)
        );

        if (canSee) {
          if (!visibleToSessions.has(otherSession.edge_id)) {
            visibleToSessions.set(otherSession.edge_id, []);
          }
          visibleToSessions.get(otherSession.edge_id)!.push(otherSession.session_id);
        }
      }

      // 发送 userJoined 给可见的 sessions
      for (const [edgeId, sessionIds] of visibleToSessions.entries()) {
        const userJoinedData: {
          session_id: number;
          edge_id: number;
          user_id: number;
          username: string;
          channel_id: number;
          groups: string[];
          cert_hash: string;
          target_sessions: number[];
          mute?: boolean;
          deaf?: boolean;
          suppress?: boolean;
          self_mute?: boolean;
          self_deaf?: boolean;
          priority_speaker?: boolean;
          recording?: boolean;
        } = {
          session_id: session.session_id,
          edge_id: session.edge_id,
          user_id: session.user_id,
          username: session.username,
          channel_id: session.channel_id,
          groups: session.groups,
          cert_hash: session.cert_hash,
          target_sessions: sessionIds,
        };
        
        if (session.mute !== undefined) userJoinedData.mute = session.mute;
        if (session.deaf !== undefined) userJoinedData.deaf = session.deaf;
        if (session.suppress !== undefined) userJoinedData.suppress = session.suppress;
        if (session.self_mute !== undefined) userJoinedData.self_mute = session.self_mute;
        if (session.self_deaf !== undefined) userJoinedData.self_deaf = session.self_deaf;
        if (session.priority_speaker !== undefined) userJoinedData.priority_speaker = session.priority_speaker;
        if (session.recording !== undefined) userJoinedData.recording = session.recording;
        
        this.factory.getControlService().notify(edgeId, 'hub.userJoined', userJoinedData);
      }

      this.logger.info(`Session ${session.session_id} created with ninja filtering: visible to ${Array.from(visibleToSessions.values()).flat().length} users`);
    } else {
      // 无 ninja filtering，广播给所有 edges
      const userJoinedData: {
        session_id: number;
        edge_id: number;
        user_id: number;
        username: string;
        channel_id: number;
        groups: string[];
        cert_hash: string;
        mute?: boolean;
        deaf?: boolean;
        suppress?: boolean;
        self_mute?: boolean;
        self_deaf?: boolean;
        priority_speaker?: boolean;
        recording?: boolean;
      } = {
        session_id: session.session_id,
        edge_id: session.edge_id,
        user_id: session.user_id,
        username: session.username,
        channel_id: session.channel_id,
        groups: session.groups,
        cert_hash: session.cert_hash,
      };
      
      if (session.mute !== undefined) userJoinedData.mute = session.mute;
      if (session.deaf !== undefined) userJoinedData.deaf = session.deaf;
      if (session.suppress !== undefined) userJoinedData.suppress = session.suppress;
      if (session.self_mute !== undefined) userJoinedData.self_mute = session.self_mute;
      if (session.self_deaf !== undefined) userJoinedData.self_deaf = session.self_deaf;
      if (session.priority_speaker !== undefined) userJoinedData.priority_speaker = session.priority_speaker;
      if (session.recording !== undefined) userJoinedData.recording = session.recording;
      
      this.factory.getControlService().broadcast('hub.userJoined', userJoinedData);
      this.logger.info(`Session ${session.session_id} created, broadcasted to all edges`);
    }
  }
}