import type { Logger } from '@munode/common';
import type { HubHandlerFactory } from '../factory.js';
import { HubPermissionChecker, Permission } from '../permission-checker.js';
import type { EdgeNotificationParams } from '@munode/protocol';


/**
 * Hub 通知处理器接口
 */
export interface INotificationHandler {
  handleUserRemoveNotification(params: EdgeNotificationParams<'edge.userRemoveNotification'>): Promise<void>;
  handlePluginDataTransmissionNotification(params: EdgeNotificationParams<'edge.pluginDataTransmissionNotification'>): Promise<void>;
  handleUserStatsNotification(params: EdgeNotificationParams<'edge.userStatsNotification'>): Promise<void>;
  handleConnectionFailureNotification(params: { edge_id: number; target_edge_id: number; timestamp: number }): Promise<void>;
  handleReconnectFailureNotification(params: { edge_id: number; target_edge_id: number; timestamp: number }): Promise<void>;
}

/**
 * Hub 通知处理器 - 处理来自 Edge 的通知消息
 */
export class NotificationHandler implements INotificationHandler {
  private factory: HubHandlerFactory;
  private permissionChecker: HubPermissionChecker;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
    this.permissionChecker = factory.getPermissionChecker();
  }

  /**
   * 处理 UserRemove 通知 - 执行完整的业务逻辑并广播
   */
  async handleUserRemoveNotification(params: EdgeNotificationParams<'edge.userRemoveNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, target_session, reason, ban } = params;

      this.logger.info(`Hub received UserRemove from Edge ${edge_id}, actor: ${actor_username}(${actor_session}), target: ${target_session}, ban: ${ban}`);

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
        this.logger.info(`User ${targetSession.username} (session ${target_session}) banned by ${actor_username}, reason: ${reason}`);
      } else {
        this.logger.info(`User ${targetSession.username} (session ${target_session}) kicked by ${actor_username}, reason: ${reason}`);
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
        session: target_session,
        actor: actor_session,
        reason,
        ban,
      });

      // 从会话管理器移除目标会话
      sessionManager.removeSession(target_session);

      this.logger.debug(`Broadcasted UserRemove for session ${target_session} to all edges`);
    } catch (error) {
      this.logger.error('Error handling UserRemove notification:', error);
    }
  }

  /**
   * 处理 PluginDataTransmission 通知
   */
  async handlePluginDataTransmissionNotification(params: EdgeNotificationParams<'edge.pluginDataTransmissionNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, actor_username, pluginData, receiver_sessions, dataID, data } = params;

      this.logger.info(`Hub received PluginDataTransmission from Edge ${edge_id}, actor: ${actor_username}(${actor_session})`);

      const sessionManager = this.factory.getSessionManager();

      // 获取actor会话
      const actorSession = sessionManager.getSession(actor_session);
      if (!actorSession) {
        this.logger.warn(`Actor session ${actor_session} not found in Hub`);
        return;
      }

      // 目标会话列表
      const targetSessions: number[] = [];
      const targetSessionsByEdge = new Map<number, number[]>(); // edge_id -> session_ids

      // Support both pluginData structure and direct fields
      const actualReceiverSessions = receiver_sessions;
      const actualDataID = pluginData?.dataID || dataID;
      const actualData = pluginData?.data || data;

      // 1. 处理直接指定的接收者
      if (actualReceiverSessions && actualReceiverSessions.length > 0) {
        for (const targetSession of actualReceiverSessions) {
          const session = sessionManager.getSession(targetSession);
          if (session) {
            targetSessions.push(targetSession);
            // 按Edge分组
            if (!targetSessionsByEdge.has(session.edge_id)) {
              targetSessionsByEdge.set(session.edge_id, []);
            }
            targetSessionsByEdge.get(session.edge_id).push(targetSession);
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
            targetSessionsByEdge.get(session.edge_id).push(session.session_id);
          }
        }
      }

      if (targetSessions.length === 0) {
        this.logger.warn(`PluginDataTransmission from ${actor_username} has no valid targets`);
        return;
      }

      // 确保data是Buffer类型（protobuf原生支持Buffer/Uint8Array）
      let dataBuffer: Buffer;
      if (!actualData) {
        dataBuffer = Buffer.alloc(0);
      } else if (Buffer.isBuffer(actualData)) {
        dataBuffer = actualData;
      } else if (ArrayBuffer.isView(actualData)) {
        // Handle Uint8Array and other TypedArray views
        dataBuffer = Buffer.from(actualData as Uint8Array);
      } else {
        this.logger.warn(`Unexpected data type for plugin data: ${typeof actualData}, using empty buffer`);
        dataBuffer = Buffer.alloc(0);
      }

      // 按Edge广播（每个Edge只发送其本地用户的session列表）
      for (const [target_edge_id, sessions] of targetSessionsByEdge.entries()) {
        this.factory.getControlService().notify(target_edge_id, 'hub.pluginDataBroadcast', {
          sender_session: actor_session,
          dataID: actualDataID || '',
          data: dataBuffer,
          target_sessions: sessions, // 传递目标会话列表
        });
      }

      this.logger.info(`Broadcasted PluginDataTransmission from ${actor_username} to ${targetSessions.length} users across ${targetSessionsByEdge.size} edges`);
    } catch (error) {
      this.logger.error('Error handling PluginDataTransmission notification:', error);
    }
    return Promise.resolve();
  }

  /**
   * 处理 UserStats 请求通知 - 从Hub获取完整的用户统计信息
   */
  async handleUserStatsNotification(params: EdgeNotificationParams<'edge.userStatsNotification'>): Promise<void> {
    try {
      const { edge_id, actor_session, target_session, stats_only } = params;

      this.logger.info(`Hub received UserStats request from Edge ${edge_id}, actor: ${actor_session}, target: ${target_session}`);

      const sessionManager = this.factory.getSessionManager();
      const permissionChecker = this.factory.getPermissionChecker();

      // 获取actor和target会话
      const actorSession = sessionManager.getSession(actor_session);
      const targetSession = sessionManager.getSession(target_session);

      if (!actorSession) {
        this.logger.warn(`Actor session ${actor_session} not found in Hub`);
        this.factory.getControlService().notify(edge_id, 'hub.userStatsResponse', {
          success: false,
          actor_session,
          error: 'Actor session not found',
        });
        return;
      }

      if (!targetSession) {
        this.logger.warn(`Target session ${target_session} not found in Hub`);
        this.factory.getControlService().notify(edge_id, 'hub.userStatsResponse', {
          success: false,
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
        const hasEnter = await permissionChecker.hasPermission(
          targetSession.channel_id,
          actorUserInfo,
          Permission.Enter
        );
        if (!hasEnter) {
          this.logger.warn(`Permission denied for UserStats: actor ${actor_session} cannot enter target ${target_session} channel`);
          this.factory.getControlService().notify(edge_id, 'hub.userStatsResponse', {
            success: false,
            actor_session,
            error: 'Permission denied: Cannot view user stats',
          });
          return;
        }
      }

      // 构建UserStats响应
      const now = Math.floor(Date.now() / 1000);
      const userStats: {
        session: number;
        stats_only?: boolean;
        certificates?: Buffer[];
        strong_certificate?: boolean;
        from_client?: {
          good?: number;
          late?: number;
          lost?: number;
          resync?: number;
        };
        from_server?: {
          good?: number;
          late?: number;
          lost?: number;
          resync?: number;
        };
        udp_packets?: number;
        tcp_packets?: number;
        udp_ping_avg?: number;
        udp_ping_var?: number;
        tcp_ping_avg?: number;
        tcp_ping_var?: number;
        version?: {
          major?: number;
          minor?: number;
          patch?: number;
        };
        address?: string;
        onlinesecs?: number;
        idlesecs?: number;
      } = {
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
          let certHash: Buffer;
          if (this.factory.getConfig().hideCertHashes) {
            // 返回用户ID的哈希（如果有用户ID）
            if (targetSession.user_id !== undefined && targetSession.user_id !== null) {
              const hashStr = await this.hashUserId(targetSession.user_id);
              certHash = Buffer.from(hashStr, 'utf-8');
            }
          } else {
            // 返回真实的证书哈希 - 转换为 Buffer
            certHash = typeof targetSession.cert_hash === 'string'
              ? Buffer.from(targetSession.cert_hash, 'utf-8')
              : targetSession.cert_hash;
          }

          // 将证书哈希添加到 certificates 数组
          if (certHash) {
            userStats.certificates = [certHash];
          }

          // stats_only 模式下不添加证书链
          // TODO: 从证书缓存获取完整证书链（仅在非 stats_only 模式）
        }

        // 添加IP地址（保持为字符串格式）
        if (targetSession.ip_address) {
          userStats.address = targetSession.ip_address;
        }
      }

      // 版本和OS信息只有extended权限才能查看（管理员或查看自己）
      // 普通用户不能看到其他用户的版本和OS信息
      if (details) {
        // 添加客户端版本信息
        if (targetSession.version || targetSession.release || targetSession.os) {
          // 解析版本号为 major.minor.patch 格式
          const versionParts = targetSession.version?.split('.') || [];
          userStats.version = {
            major: versionParts[0] ? parseInt(versionParts[0]) || 0 : 0,
            minor: versionParts[1] ? parseInt(versionParts[1]) || 0 : 0,
            patch: versionParts[2] ? parseInt(versionParts[2]) || 0 : 0,
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
        success: true,
        actor_session,
        userStats,
      });

      this.logger.info(`Sent UserStats response to Edge ${edge_id} for session ${target_session}`);
    } catch (error) {
      this.logger.error('Error handling UserStats notification:', error);
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

  /**
   * Track connection failure reports from edges
   * Key: "edgeA-edgeB", Value: { edgeA_reported: timestamp, edgeB_reported: timestamp }
   */
  private connectionFailureReports = new Map<string, { 
    edgeA: number; 
    edgeB: number; 
    edgeA_reported?: number; 
    edgeB_reported?: number; 
  }>();

  /**
   * Handle Edge connection failure notification
   * Reported when direct connection between Edges fails, but exit may not be necessary
   */
  async handleConnectionFailureNotification(params: { edge_id: number; target_edge_id: number; timestamp: number }): Promise<void> {
    try {
      const { edge_id, target_edge_id, timestamp } = params;
      this.logger.warn(`Edge ${edge_id} reported connection failure to Edge ${target_edge_id} at ${timestamp}`);
      
      // Record failure but don't take immediate action
      // Connection failure doesn't mean exit is needed, as routing through other Edges may be possible
      const failureKey = this.getFailureKey(edge_id, target_edge_id);
      let report = this.connectionFailureReports.get(failureKey);
      
      if (!report) {
        report = { edgeA: Math.min(edge_id, target_edge_id), edgeB: Math.max(edge_id, target_edge_id) };
        this.connectionFailureReports.set(failureKey, report);
      }
      
      if (edge_id === report.edgeA) {
        report.edgeA_reported = timestamp;
      } else {
        report.edgeB_reported = timestamp;
      }
      
      this.logger.debug(`Connection failure tracked: ${failureKey}`, report);
    } catch (error) {
      this.logger.error('Error handling connection failure notification:', error);
    }
    return Promise.resolve();
  }

  /**
   * Handle Edge reconnection failure notification (when both directions fail)
   * This is a more serious situation requiring check for disconnected clusters
   */
  async handleReconnectFailureNotification(params: { edge_id: number; target_edge_id: number; timestamp: number }): Promise<void> {
    try {
      const { edge_id, target_edge_id, timestamp } = params;
      this.logger.error(`Edge ${edge_id} reported reconnect failure to Edge ${target_edge_id} at ${timestamp}`);
      
      const failureKey = this.getFailureKey(edge_id, target_edge_id);
      let report = this.connectionFailureReports.get(failureKey);
      
      if (!report) {
        report = { edgeA: Math.min(edge_id, target_edge_id), edgeB: Math.max(edge_id, target_edge_id) };
        this.connectionFailureReports.set(failureKey, report);
      }
      
      if (edge_id === report.edgeA) {
        report.edgeA_reported = timestamp;
      } else {
        report.edgeB_reported = timestamp;
      }
      
      // 检查是否双方都报告了重连失败
      const REPORT_TIMEOUT = 60000; // 60秒内的报告认为是同一事件
      if (report.edgeA_reported && report.edgeB_reported) {
        const timeDiff = Math.abs(report.edgeA_reported - report.edgeB_reported);
        if (timeDiff < REPORT_TIMEOUT) {
          this.logger.warn(`Both Edge ${report.edgeA} and Edge ${report.edgeB} reported reconnect failure, initiating arbitration`);
          await this.performArbitration(report.edgeA, report.edgeB);
          // Clear report record
          this.connectionFailureReports.delete(failureKey);
        }
      }
    } catch (error) {
      this.logger.error('Error handling reconnect failure notification:', error);
    }
  }

  /**
   * Perform arbitration: check network topology to determine if some Edges need to exit
   * 
   * Arbitration logic:
   * 1. Check if the two Edges can connect through routing via other Edges
   * 2. If routing connection is not possible, disconnected clusters have formed
   * 3. Detect all disconnected clusters
   * 4. Select cluster with fewest users and request those Edges to exit
   */
  private async performArbitration(edgeA: number, edgeB: number): Promise<void> {
    try {
      this.logger.info(`Performing arbitration between Edge ${edgeA} and Edge ${edgeB}`);
      
      const topologyManager = this.factory.getNetworkTopologyManager();
      if (!topologyManager.isEnabled()) {
        this.logger.warn('Network topology manager is disabled, cannot perform arbitration');
        return;
      }
      
      // Check if connection is possible through routing
      const path = topologyManager.findBestPath(edgeA, edgeB);
      if (path && path.path.length > 0) {
        this.logger.info(`Edge ${edgeA} and ${edgeB} can still connect via routing: ${path.path.join(' -> ')}`);
        // Routing connection possible, no exit needed
        return;
      }
      
      this.logger.warn(`Edge ${edgeA} and ${edgeB} cannot connect via any routing path, detecting disconnected clusters`);
      
      // Detect disconnected clusters
      const clusters = this.detectDisconnectedClusters();
      
      if (clusters.length <= 1) {
        this.logger.info('Only one connected cluster found, no action needed');
        return;
      }
      
      this.logger.warn(`Detected ${clusters.length} disconnected edge clusters`);
      
      // Calculate user count for each cluster
      const sessionManager = this.factory.getSessionManager();
      const clusterStats = clusters.map((cluster, index) => {
        const userCount = cluster.reduce((sum, edgeId) => {
          const sessions = sessionManager.getEdgeSessions(edgeId);
          return sum + sessions.length;
        }, 0);
        
        return {
          index,
          edges: cluster,
          userCount,
        };
      });
      
      // Sort by user count to find smallest cluster
      clusterStats.sort((a, b) => a.userCount - b.userCount);
      
      this.logger.info('Cluster statistics:', clusterStats.map(c => ({
        edges: c.edges,
        users: c.userCount,
      })));
      
      // Select cluster with fewest users to exit
      const smallestCluster = clusterStats[0];
      
      if (smallestCluster.userCount === 0 && clusterStats.length > 1) {
        // If smallest cluster has no users, directly request shutdown
        this.logger.warn(`Cluster ${smallestCluster.edges.join(', ')} has no users, requesting shutdown`);
        await this.shutdownEdgeCluster(smallestCluster.edges);
      } else if (smallestCluster.userCount > 0) {
        // If smallest cluster has users, request graceful shutdown with client disconnection
        this.logger.warn(`Cluster ${smallestCluster.edges.join(', ')} has ${smallestCluster.userCount} users, requesting graceful shutdown`);
        await this.shutdownEdgeCluster(smallestCluster.edges);
      }
      
    } catch (error) {
      this.logger.error('Error performing arbitration:', error);
    }
  }

  /**
   * Detect disconnected Edge clusters
   * Uses Union-Find algorithm
   * 
   * Performance: O(n² * Dijkstra) where n is number of edges
   * For large clusters, consider caching connectivity or using BFS
   */
  private detectDisconnectedClusters(): number[][] {
    const topologyManager = this.factory.getNetworkTopologyManager();
    const allEdges = topologyManager.getAllEdges();
    
    if (allEdges.length === 0) {
      return [];
    }
    
    // Union-Find data structure
    const parent = new Map<number, number>();
    const rank = new Map<number, number>();
    
    // Initialize
    for (const edge of allEdges) {
      parent.set(edge, edge);
      rank.set(edge, 0);
    }
    
    // Find root with path compression
    const find = (x: number): number => {
      if (parent.get(x) !== x) {
        parent.set(x, find(parent.get(x)!));
      }
      return parent.get(x)!;
    };
    
    // Union by rank
    const union = (x: number, y: number): void => {
      const rootX = find(x);
      const rootY = find(y);
      
      if (rootX === rootY) return;
      
      const rankX = rank.get(rootX) ?? 0;
      const rankY = rank.get(rootY) ?? 0;
      
      if (rankX < rankY) {
        parent.set(rootX, rootY);
      } else if (rankX > rankY) {
        parent.set(rootY, rootX);
      } else {
        parent.set(rootY, rootX);
        rank.set(rootX, rankX + 1);
      }
    };
    
    // Check connectivity for all edge pairs
    // Note: This is O(n²) but typically n is small (< 10 edges in most deployments)
    for (let i = 0; i < allEdges.length; i++) {
      for (let j = i + 1; j < allEdges.length; j++) {
        const edgeA = allEdges[i];
        const edgeB = allEdges[j];
        
        // Check if connection is possible through routing
        const path = topologyManager.findBestPath(edgeA, edgeB);
        if (path && path.path.length > 0) {
          union(edgeA, edgeB);
        }
      }
    }
    
    // Collect all clusters
    const clusters = new Map<number, number[]>();
    for (const edge of allEdges) {
      const root = find(edge);
      if (!clusters.has(root)) {
        clusters.set(root, []);
      }
      clusters.get(root)!.push(edge);
    }
    
    return Array.from(clusters.values());
  }

  /**
   * Request Edge cluster shutdown
   * Send shutdown notifications to all Edges in the cluster, requiring them to disconnect clients and exit
   */
  private async shutdownEdgeCluster(edges: number[]): Promise<void> {
    for (const edgeId of edges) {
      try {
        this.logger.warn(`Requesting Edge ${edgeId} to shutdown and disconnect all clients`);
        this.factory.getControlService().notify(edgeId, 'hub.shutdownRequest', {
          reason: 'Network partition detected, this edge is in the smaller disconnected cluster',
          graceful: true,
          disconnect_clients: true,
        });
      } catch (error) {
        this.logger.error(`Failed to send shutdown request to Edge ${edgeId}:`, error);
      }
    }
    return Promise.resolve();
  }

  /**
   * Generate unique key for failure records
   * Ensure edgeA-edgeB and edgeB-edgeA use the same key
   */
  private getFailureKey(edgeA: number, edgeB: number): string {
    const min = Math.min(edgeA, edgeB);
    const max = Math.max(edgeA, edgeB);
    return `${min}-${max}`;
  }
}