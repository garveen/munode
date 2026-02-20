import type { Logger } from '@munode/common';
import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';


/**
 * Hub 集群处理器接口
 */
export interface IClusterHandler {
  handleEdgeJoin(params: RPCParams<'edge.join'>): Promise<RPCResult<'edge.join'>>;
  handleEdgeJoinComplete(params: RPCParams<'edge.joinComplete'>): Promise<RPCResult<'edge.joinComplete'>>;
  handleEdgeReportPeerDisconnect(params: RPCParams<'edge.reportPeerDisconnect'>): Promise<RPCResult<'edge.reportPeerDisconnect'>>;
  handleEdgeReportQuality(params: { edge_id: number; target_edge_id: number; quality: { rtt: number; packetLoss: number; jitter: number; samples: number } }): Promise<{ success: boolean }>;
  handleGetClusterStatus(params: RPCParams<'cluster.getStatus'>): Promise<RPCResult<'cluster.getStatus'>>;
}

/**
 * Hub 集群处理器 - 处理集群管理相关的操作
 */
export class ClusterHandler implements IClusterHandler {
  private factory: HubHandlerFactory;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
  }

  /**
   * 处理Edge加入集群
   */
  async handleEdgeJoin(params: RPCParams<'edge.join'>): Promise<RPCResult<'edge.join'>> {
    this.logger.info(`Edge ${params.server_id} requesting to join cluster`);

    // 将 voicePort（即 edge_port）存入注册表中，以便在 peer 列表中返回
    const edge = this.factory.getRegistry().getEdge(params.server_id);
    if (edge && params.voicePort) {
      edge.edge_port = params.voicePort;
      this.logger.info(`Stored edge_port=${params.voicePort} for Edge ${params.server_id}`);
    }

    // 获取所有已注册的Edge作为Peer列表
    const allEdges = this.factory.getRegistry().getEdgeList();
    const peers = allEdges
      .filter((e) => e.server_id !== params.server_id)
      .map((e) => ({
        id: e.server_id,
        name: e.name,
        host: e.host,
        port: e.port,                        // 客户端主端口
        voicePort: e.edge_port || e.port,    // Edge 间 TCP 专用端口
        certHash: e.certificate,
      }));

    // 生成加入令牌
    const token = `token-${params.server_id}-${Date.now()}`;

    this.logger.info(`Edge ${params.server_id} join request accepted, peers: ${peers.length}`);

    return {
      success: true,
      token,
      peers,
      timeout: 60000,
    };
  }

  /**
   * 处理Edge加入完成
   */
  async handleEdgeJoinComplete(params: RPCParams<'edge.joinComplete'>): Promise<RPCResult<'edge.joinComplete'>> {
    this.logger.info(
      `Edge ${params.server_id} completed join, connected peers: ${params.connectedPeers.join(',')}`
    );

    // 广播新成员加入通知（排除新加入的 edge 自己，避免自连接）
    const edge = this.factory.getRegistry().getEdge(params.server_id);
    if (edge) {
      this.factory.getControlService().broadcastExcept(edge.server_id, 'edge.peerJoined', {
        id: edge.server_id,
        name: edge.name,
        host: edge.host,
        port: edge.port,                          // 客户端主端口
        voicePort: edge.edge_port || edge.port,   // Edge 间 TCP 专用端口
        certHash: edge.certificate,
      });
    }

    return { success: true };
  }

  /**
   * 处理Edge报告对等节点断开
   */
  async handleEdgeReportPeerDisconnect(params: RPCParams<'edge.reportPeerDisconnect'>): Promise<RPCResult<'edge.reportPeerDisconnect'>> {
    this.logger.warn(`Peer disconnect reported: Edge ${params.localEdgeId} <-> Edge ${params.remoteEdgeId}`);

    // 获取远程Edge的客户端数量
    const remoteEdge = this.factory.getRegistry().getEdge(params.remoteEdgeId);
    const remoteClientCount = remoteEdge?.stats?.user_count || 0;

    this.logger.info(`Comparing client counts: local=${params.localClientCount}, remote=${remoteClientCount}`);

    // 比较客户端数量，让客户端少的Edge断开重连
    if (params.localClientCount < remoteClientCount) {
      this.logger.info(`Instructing Edge ${params.localEdgeId} to disconnect (fewer clients)`);
      return { action: 'disconnect' };
    } else if (params.localClientCount > remoteClientCount) {
      this.logger.info(`Instructing Edge ${params.remoteEdgeId} to disconnect (fewer clients)`);
      // 通知远程Edge断开
      this.factory.getControlService().notify(params.remoteEdgeId, 'edge.forceDisconnect', {
        reason: 'Peer connection failed, fewer clients',
      });
      return { action: 'wait' };
    } else {
      // 客户端数量相同，让ID较小的断开
      if (params.localEdgeId < params.remoteEdgeId) {
        return { action: 'disconnect' };
      } else {
        this.factory.getControlService().notify(params.remoteEdgeId, 'edge.forceDisconnect', {
          reason: 'Peer connection failed, tie-break',
        });
        return { action: 'wait' };
      }
    }
  }

  /**
   * 处理Edge上报的网络质量信息
   */
  async handleEdgeReportQuality(params: { edge_id: number; target_edge_id: number; quality: { rtt: number; packetLoss: number; jitter: number; samples: number } }): Promise<{ success: boolean }> {
    try {
      this.logger.info(`Edge ${params.edge_id} reported quality to Edge ${params.target_edge_id}:`, params.quality);

      // 更新网络拓扑中的链接质量
      this.factory.getNetworkTopologyManager().handleQualityReport(
        params.edge_id,
        params.target_edge_id,
        {
          rtt: params.quality.rtt,
          packetLoss: params.quality.packetLoss,
          jitter: params.quality.jitter,
          samples: params.quality.samples,
          lastUpdate: Date.now(),
        }
      );

      return { success: true };
    } catch (error) {
      this.logger.error('Error handling quality report:', error);
      return { success: false };
    }
  }

  /**
   * 处理获取集群状态
   */
  async handleGetClusterStatus(_params: RPCParams<'cluster.getStatus'>): Promise<RPCResult<'cluster.getStatus'>> {
    const edges = this.factory.getRegistry().getEdgeList();
    return {
      edges: edges.map((edge) => ({
        id: edge.server_id,
        name: edge.name,
        host: edge.host,
        port: edge.port,
        client_count: edge.current_load || 0,
        status: (edge.last_seen && Date.now() - edge.last_seen < 10000 ? 'online' : 'offline'),
         last_seen: edge.last_seen,
      })),
    };
  }
}