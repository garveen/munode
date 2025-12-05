import { createLogger } from '@munode/common';
import type { HubHandlerFactory } from '../factory.js';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import type { EdgeNotificationParams } from '@munode/protocol';

const logger = createLogger({ service: 'hub-notification-handler' });

/**
 * Hub 通知处理器接口
 */
export interface INotificationHandler {
  handleUserRemoveNotification(params: EdgeNotificationParams<'edge.userRemoveNotification'>): Promise<void>;
  handlePluginDataTransmissionNotification(params: EdgeNotificationParams<'edge.pluginDataTransmissionNotification'>): Promise<void>;
  handleUserStatsNotification(params: EdgeNotificationParams<'edge.userStatsNotification'>): Promise<void>;
}

/**
 * Hub 通知处理器 - 处理来自 Edge 的通知消息
 */
export class NotificationHandler implements INotificationHandler {
  private factory: HubHandlerFactory;
  private permissionChecker: HubPermissionChecker;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.permissionChecker = factory.getPermissionChecker();
  }

  /**
   * 处理 UserRemove 通知 - 执行完整的业务逻辑并广播
   */
  async handleUserRemoveNotification(params: EdgeNotificationParams<'edge.userRemoveNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, target_session, reason, ban } = params;

      logger.info(`Hub received UserRemove from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), target: ${target_session}, ban: ${ban}`);

      const sessionManager = this.factory.getSessionManager();
      const databaseOperations = this.factory.getDatabaseOperations();

      // 获取目标会话
      const targetSession = sessionManager.getSession(target_session);
      if (!targetSession) {
        this.factory.getControlService().notify(edge_id, 'hub.userRemoveResponse', {
          success: false,
          actor_session,
          error: 'Target session not found',
        });
        return;
      }

      // 获取actor会话
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.factory.getControlService().notify(edge_id, 'hub.userRemoveResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      // 权限检查：Kick需要root频道的Kick权限，Ban需要Ban权限

      const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);
      const requiredPermission = ban ? Permission.Ban : Permission.Kick;

      // Kick/Ban权限只在root频道检查
      const hasPermission = await this.permissionChecker.hasPermission(
        0, // root channel
        actorUserInfo,
        requiredPermission
      );

      if (!hasPermission) {
        this.factory.getControlService().notify(edge_id, 'hub.userRemoveResponse', {
          success: false,
          actor_session,
          error: `Permission denied: ${ban ? 'Ban' : 'Kick'}Permission required`,
          permission_denied: true,
          permission_type: ban ? 'Ban' : 'Kick',
        });
        return;
      }


      // 如果是ban，记录到数据库
      if (ban) {
        // 将IP地址转换为Buffer
        // 简化处理：使用IP字符串的hash作为标识
        const ipBuffer = Buffer.from(targetSession.ip_address || '0.0.0.0');

        // 添加ban记录
        const banManager = this.factory.getBanManager();
        if (banManager) {
          await banManager.addBan({
            address: ipBuffer,
            mask: 32, // 精确匹配单个IP
            hash: targetSession.cert_hash,
            reason: reason || 'No reason provided',
            start: Math.floor(Date.now() / 1000), // Unix timestamp in seconds
            duration: 0, // 0表示永久ban
          });
        } else {
          await databaseOperations.addBan({
            address: ipBuffer,
            mask: 32,
            hash: targetSession.cert_hash,
            reason: reason || 'No reason provided',
            start: Math.floor(Date.now() / 1000),
            duration: 0,
          });
        }
        logger.info(`User ${targetSession.username} (session ${target_session}) banned by ${actor_username}, reason: ${reason}`);
      } else {
        logger.info(`User ${targetSession.username} (session ${target_session}) kicked by ${actor_username}, reason: ${reason}`);
      }

      // 向发起Edge回复成功
      this.factory.getControlService().notify(edge_id, 'hub.userRemoveResponse', {
        success: true,
        actor_session,
        target_session,
        ban,
      });

      // 广播UserRemove给所有Edge
      this.factory.getControlService().broadcast('hub.userRemoveBroadcast', {
        actor_session,
        target_session,
        target_edge_id: targetSession.edge_id,
        reason,
        ban,
      });

      // 从会话管理器移除目标会话
      sessionManager.removeSession(target_session);

      logger.debug(`Broadcasted UserRemove for session ${target_session} to all edges`);
    } catch (error) {
      logger.error('Error handling UserRemove notification:', error);
    }
  }

  /**
   * 处理 PluginDataTransmission 通知
   */
  async handlePluginDataTransmissionNotification(params: EdgeNotificationParams<'edge.pluginDataTransmissionNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, pluginData } = params;

      logger.info(`Hub received PluginDataTransmission from Edge ${edge_id}, actor: ${actor_username}(${actor_session})`);

      const sessionManager = this.factory.getSessionManager();

      // 获取actor会话
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        logger.warn(`Actor session ${actor_session} not found in Hub`);
        return;
      }

      // 目标会话列表
      const targetSessions: number[] = [];
      const targetSessionsByEdge = new Map<number, number[]>(); // edge_id -> session_ids

      // 1. 处理直接指定的接收者
      if (pluginData.receiverSessions && pluginData.receiverSessions.length > 0) {
        for (const targetSession of pluginData.receiverSessions) {
          const session = sessionManager.getSession(targetSession);
          if (session) {
            targetSessions.push(targetSession);
            // 按Edge分组
            if (!targetSessionsByEdge.has(session.edge_id)) {
              targetSessionsByEdge.set(session.edge_id, []);
            }
            targetSessionsByEdge.get(session.edge_id)!.push(targetSession);
          }
        }
      } else {
        // 2. 如果没有指定接收者，广播给所有用户（除了发送者）
        const allSessions = sessionManager.getAllSessions();
        for (const session of allSessions) {
          if (session.session_id !== actor_session) {
            targetSessions.push(session.session_id);
            // 按Edge分组
            if (!targetSessionsByEdge.has(session.edge_id)) {
              targetSessionsByEdge.set(session.edge_id, []);
            }
            targetSessionsByEdge.get(session.edge_id)!.push(session.session_id);
          }
        }
      }

      if (targetSessions.length === 0) {
        logger.warn(`PluginDataTransmission from ${actor_username} has no valid targets`);
        return;
      }

      // 按Edge广播（每个Edge只发送其本地用户的session列表）
      for (const [target_edge_id, sessions] of targetSessionsByEdge.entries()) {
        this.factory.getControlService().notify(target_edge_id, 'hub.pluginDataBroadcast', {
          pluginData: {
            senderSession: pluginData.senderSession,
            dataID: pluginData.dataID || '',
            data: pluginData.data || Buffer.alloc(0),
            receiverSessions: sessions, // 只发送该Edge需要接收的用户列表
          },
          target_sessions: sessions,
        });
      }

      logger.info(`Broadcasted PluginDataTransmission from ${actor_username} to ${targetSessions.length} users across ${targetSessionsByEdge.size} edges`);
    } catch (error) {
      logger.error('Error handling PluginDataTransmission notification:', error);
    }
  }

  /**
   * 处理 UserStats 请求通知 - 从Hub获取完整的用户统计信息
   */
  async handleUserStatsNotification(params: EdgeNotificationParams<'edge.userStatsNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, target_session, stats_only } = params;

      logger.info(`Hub received UserStats request from Edge ${edge_id}, actor: ${actor_session}, target: ${target_session}`);

      const sessionManager = this.factory.getSessionManager();
      const permissionChecker = this.factory.getPermissionChecker();

      // 获取actor和target会话
      const actorSession = sessionManager.getSession(actor_session);
      const targetSession = sessionManager.getSession(target_session);

      if (!actorSession) {
        logger.warn(`Actor session ${actor_session} not found in Hub`);
        this.factory.getControlService().notify(edge_id, 'hub.userStatsResponse', {
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      if (!targetSession) {
        logger.warn(`Target session ${target_session} not found in Hub`);
        this.factory.getControlService().notify(edge_id, 'hub.userStatsResponse', {
          actor_session,
          error: 'Target session not found',
        });
        return;
      }

      // 权限检查
      const actorUserInfo = this.permissionChecker.sessionToUserInfo(actorSession, actorSession.channel_id);

      // extended权限：自己 或者 有 Register 权限
      let extended = actor_session === target_session;
      if (!extended) {
        const hasRegister = await this.permissionChecker.hasPermission(
          0, // root channel
          actorUserInfo,
          Permission.Register
        );
        extended = hasRegister;
      }

      // 如果没有extended权限，检查是否有进入目标用户频道的权限
      if (!extended) {
        const hasEnter = await permissionChecker!.hasPermission(
          targetSession.channel_id,
          actorUserInfo,
          Permission.Enter
        );
        if (!hasEnter) {
          logger.warn(`Permission denied for UserStats: actor ${actor_session} cannot enter target ${target_session} channel`);
          this.factory.getControlService().notify(edge_id, 'hub.userStatsResponse', {
            actor_session,
            error: 'Permission denied: Cannot view user stats',
          });
          return;
        }
      }

      // 构建UserStats响应
      const now = Math.floor(Date.now() / 1000);
      const userStats: any = {
        session: target_session,
        onlinesecs: now - targetSession.connected_at,
        idlesecs: now - targetSession.last_active,
        stats_only: stats_only || false,  // 包含 stats_only 标志
      };

      // details权限：extended 且不是 stats_only 模式
      const details = extended && !stats_only;

      if (details) {
        // 添加证书信息
        if (targetSession.cert_hash) {
          userStats.strong_certificate = true;

          // 根据配置决定返回真实证书哈希还是用户ID哈希
          if (this.factory.getConfig().hideCertHashes) {
            // 返回用户ID的哈希（如果有用户ID）
            if (targetSession.user_id !== undefined && targetSession.user_id !== null) {
              userStats.cert_hash = await this.hashUserId(targetSession.user_id);
            }
          } else {
            // 返回真实的证书哈希
            userStats.cert_hash = targetSession.cert_hash;
          }

          // stats_only 模式下不添加证书链
          // TODO: 从证书缓存获取完整证书链（仅在非 stats_only 模式）
        }

        // 添加IP地址
        if (targetSession.ip_address) {
          // 将IP字符串转换为字节数组
          const ipParts = targetSession.ip_address.split('.');
          if (ipParts.length === 4) {
            userStats.address = Buffer.from(ipParts.map(p => parseInt(p, 10)));
          }
        }
      }

      // 版本和OS信息只有extended权限才能查看（管理员或查看自己）
      // 普通用户不能看到其他用户的版本和OS信息
      if (details) {
        // 添加客户端版本信息
        if (targetSession.version || targetSession.release || targetSession.os) {
          userStats.version = {
            version_v1: targetSession.version ? parseInt(targetSession.version.split('.')[0]) || 0 : 0,
            version_v2: targetSession.version ? parseInt(targetSession.version.split('.')[1]) || 0 : 0,
            version_v3: targetSession.version ? parseInt(targetSession.version.split('.')[2]) || 0 : 0,
            release: targetSession.release || '',
            os: targetSession.os || '',
            os_version: targetSession.os_version || '',
          };
        }

        // 添加网络统计信息（从Edge获取）
        // 这里返回占位数据，实际应该从Edge获取
        userStats.from_client = {
          good: 0,
          late: 0,
          lost: 0,
          resync: 0,
        };
        userStats.from_server = {
          good: 0,
          late: 0,
          lost: 0,
          resync: 0,
        };
        userStats.udp_packets = 0;
        userStats.tcp_packets = 0;
        userStats.udp_ping_avg = 0;
        userStats.udp_ping_var = 0;
        userStats.tcp_ping_avg = 0;
        userStats.tcp_ping_var = 0;
      }

      // 返回响应给发起请求的Edge
      this.factory.getControlService().notify(edge_id, 'hub.userStatsResponse', {
        actor_session,
        userStats,
      });

      logger.info(`Sent UserStats response to Edge ${edge_id} for session ${target_session}`);
    } catch (error) {
      logger.error('Error handling UserStats notification:', error);
    }
  }

  /**
   * 计算用户ID的SHA1哈希
   * 用于在hideCertHashes=true时替代真实证书哈希
   * @param userId - 用户ID
   * @returns SHA1哈希（40位十六进制字符串）
   */
  private async hashUserId(userId: number): Promise<string> {
    const { createHash } = await import('crypto');
    const hash = createHash('sha1');
    hash.update('this is a random hash salt for nothing' + userId);
    return hash.digest('hex');
  }
}