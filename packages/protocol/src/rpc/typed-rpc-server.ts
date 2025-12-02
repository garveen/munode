/**
 * Type-Safe RPC Server Handler
 * 为 Hub Server 提供类型安全的请求处理器
 * 
 * Note: This module bridges between TypeScript types and Protobuf types.
 * The RPC channel now uses TypedRPCRequest/TypedRPCResponse protobuf messages.
 */

import type { RPCChannel, hubedgeRpc } from './rpc-channel.js';
import type {
  EdgeToHubMethods,
  RPCParams,
  RPCResult,
  HubToEdgeNotifications,
  NotificationParams,
} from './rpc-types.js';

/**
 * RPC 方法处理器类型
 */
export type RPCHandler<M extends EdgeToHubMethods['method']> = (
  channel: RPCChannel,
  params: RPCParams<M>
) => Promise<RPCResult<M>>;

/**
 * RPC 错误
 */
export interface RPCError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Handler definition for batch registration
 */
export interface HandlerDefinition<M extends EdgeToHubMethods['method']> {
  method: M;
  handler: RPCHandler<M>;
}

/**
 * 类型安全的 RPC 服务器
 *
 * 使用方法：
 * ```typescript
 * const server = new TypedRPCServer();
 *
 * // 方式1：单个注册
 * server.handle('edge.register', async (channel, params) => {
 *   return { success: true, hubServerId: 1, edgeList: [] };
 * });
 *
 * // 方式2：批量注册（推荐）
 * server.registerHandlers([
 *   { method: 'edge.register', handler: async (channel, params) => { ... } },
 *   { method: 'edge.heartbeat', handler: async (channel, params) => { ... } },
 * ]);
 *
 * // 在收到请求时调用
 * server.handleRequest(channel, message, respond);
 * ```
 */
export class TypedRPCServer {
  private handlers = new Map<string, RPCHandler<EdgeToHubMethods['method']>>();

  /**
   * 注册类型安全的处理器
   * @param method RPC 方法名
   * @param handler 处理函数（参数和返回值类型自动推断）
   */
  handle<M extends EdgeToHubMethods['method']>(method: M, handler: RPCHandler<M>): void {
    this.handlers.set(method, handler);
  }

  /**
   * 批量注册处理器（使用列表+循环方式）
   * @param definitions 处理器定义列表
   */
  registerHandlers(definitions: Array<{ method: string; handler: (channel: RPCChannel, params: unknown) => Promise<unknown> }>): void {
    for (const def of definitions) {
      // Cast to the expected type since we're accepting a more flexible handler signature
      this.handlers.set(def.method, def.handler as RPCHandler<EdgeToHubMethods['method']>);
    }
  }

  /**
   * 取消注册处理器
   * @param method RPC 方法名
   */
  unregister(method: string): void {
    this.handlers.delete(method);
  }

  /**
   * 获取所有已注册的方法名
   */
  getRegisteredMethods(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * 检查方法是否已注册
   */
  hasHandler(method: string): boolean {
    return this.handlers.has(method);
  }

  /**
   * 处理 RPC 请求
   * 
   * This method handles TypedRPCRequest and extracts params based on method name.
   * 
   * @param channel RPC 通道
   * @param request TypedRPCRequest 消息
   * @param respond 响应函数，接收 TypedRPCResponse
   */
  async handleRequest(
    channel: RPCChannel,
    request: hubedgeRpc.TypedRPCRequest,
    respond: (response: hubedgeRpc.TypedRPCResponse, error?: RPCError) => void
  ): Promise<void> {
    const method = request.method;
    const handler = this.handlers.get(method);

    if (!handler) {
      const { TypedRPCResponse } = require('../generated/proto/HubEdgeRPC.js').hubedge;
      respond(new TypedRPCResponse({ request_id: request.request_id }), {
        code: -32601,
        message: `Method not found: ${method}`,
      });
      return;
    }

    try {
      // Extract params from request based on method
      const params = this.extractRequestParams(request);
      const result = await handler(channel, params);
      
      // Create typed response
      const response = this.createTypedResponse(method, request.request_id, result);
      respond(response, undefined);
    } catch (error) {
      const { TypedRPCResponse } = require('../generated/proto/HubEdgeRPC.js').hubedge;
      respond(new TypedRPCResponse({ request_id: request.request_id }), {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
        data: error,
      });
    }
  }

  /**
   * Extract params from TypedRPCRequest based on method
   */
  private extractRequestParams(request: hubedgeRpc.TypedRPCRequest): unknown {
    const method = request.method;
    
    switch (method) {
      case 'edge.register':
        return request.edge_register?.toObject();
      case 'edge.heartbeat':
        return request.edge_heartbeat?.toObject();
      case 'edge.allocateSessionId':
        return request.edge_allocate_session_id?.toObject();
      case 'edge.authenticateUser':
        return request.edge_authenticate_user?.toObject();
      case 'edge.reportSession':
        const reportSession = request.edge_report_session?.toObject();
        if (reportSession) {
          return {
            ...reportSession,
            startTime: new Date(reportSession.start_time),
          };
        }
        return reportSession;
      case 'edge.syncVoiceTarget':
        return request.edge_sync_voice_target?.toObject();
      case 'edge.getVoiceTargets':
        return request.edge_get_voice_targets?.toObject();
      case 'edge.routeVoice':
        const routeVoice = request.edge_route_voice?.toObject();
        if (routeVoice) {
          return {
            fromEdgeId: routeVoice.from_edge_id,
            fromSessionId: routeVoice.from_session_id,
            target_id: routeVoice.target_id,
            voiceData: routeVoice.voice_data,
            timestamp: routeVoice.timestamp,
          };
        }
        return routeVoice;
      case 'edge.adminOperation':
        return request.edge_admin_operation?.toObject();
      case 'edge.exchangeCertificates':
        return request.edge_exchange_certificates?.toObject();
      case 'edge.fullSync':
        return request.edge_full_sync?.toObject();
      case 'edge.getChannels':
        return {};
      case 'edge.getACLs':
        return request.edge_get_acls?.toObject();
      case 'edge.saveChannel':
        return { channel: request.edge_save_channel?.toObject() };
      case 'edge.saveACL':
        return request.edge_save_acl?.toObject();
      case 'edge.join':
        const join = request.edge_join?.toObject();
        if (join) {
          return {
            server_id: join.server_id,
            name: join.name,
            host: join.host,
            port: join.port,
            voicePort: join.voice_port,
            capacity: join.capacity,
          };
        }
        return join;
      case 'edge.joinComplete':
        const joinComplete = request.edge_join_complete?.toObject();
        if (joinComplete) {
          return {
            server_id: joinComplete.server_id,
            token: joinComplete.token,
            connectedPeers: joinComplete.connected_peers,
          };
        }
        return joinComplete;
      case 'edge.handleACL':
        const handleACL = request.edge_handle_acl?.toObject();
        if (handleACL) {
          return {
            ...handleACL,
            raw_data: handleACL.raw_data 
              ? Buffer.from(handleACL.raw_data).toString('base64')
              : undefined,
          };
        }
        return handleACL;
      case 'edge.handlePermissionQuery':
        return request.edge_handle_permission_query?.toObject();
      case 'edge.reportPeerDisconnect':
        const peerDisconnect = request.edge_report_peer_disconnect?.toObject();
        if (peerDisconnect) {
          return {
            localEdgeId: peerDisconnect.local_edge_id,
            remoteEdgeId: peerDisconnect.remote_edge_id,
            localClientCount: peerDisconnect.local_client_count,
          };
        }
        return peerDisconnect;
      case 'edge.reportQuality':
        return request.edge_report_quality?.toObject();
      case 'cluster.getStatus':
        return {};
      case 'blob.put':
        return request.blob_put?.toObject();
      case 'blob.get':
        return request.blob_get?.toObject();
      case 'blob.getUserTexture':
        return request.blob_get_user_texture?.toObject();
      case 'blob.getUserComment':
        return request.blob_get_user_comment?.toObject();
      case 'blob.setUserTexture':
        return request.blob_set_user_texture?.toObject();
      case 'blob.setUserComment':
        return request.blob_set_user_comment?.toObject();
      default:
        return {};
    }
  }

  /**
   * Create TypedRPCResponse from method and result
   */
  private createTypedResponse(
    method: string,
    requestId: string,
    result: unknown
  ): hubedgeRpc.TypedRPCResponse {
    const { TypedRPCResponse } = require('../generated/proto/HubEdgeRPC.js').hubedge;
    const rpc = require('../generated/proto/HubEdgeRPC.js').hubedge;
    
    const response = new TypedRPCResponse({
      request_id: requestId,
      method,
    });

    switch (method) {
      case 'edge.register':
        response.edge_register = rpc.EdgeRegisterResult.fromObject(result);
        break;
      case 'edge.heartbeat':
        response.edge_heartbeat = rpc.EdgeHeartbeatResult.fromObject(result);
        break;
      case 'edge.allocateSessionId':
        response.edge_allocate_session_id = rpc.EdgeAllocateSessionIdResult.fromObject(result);
        break;
      case 'edge.authenticateUser':
        response.edge_authenticate_user = rpc.EdgeAuthenticateUserResult.fromObject(result);
        break;
      case 'edge.reportSession':
        response.edge_report_session = rpc.EdgeReportSessionResult.fromObject(result);
        break;
      case 'edge.syncVoiceTarget':
        response.edge_sync_voice_target = rpc.EdgeSyncVoiceTargetResult.fromObject(result);
        break;
      case 'edge.getVoiceTargets':
        response.edge_get_voice_targets = rpc.EdgeGetVoiceTargetsResult.fromObject(result);
        break;
      case 'edge.routeVoice':
        response.edge_route_voice = rpc.EdgeRouteVoiceResult.fromObject(result);
        break;
      case 'edge.adminOperation':
        response.edge_admin_operation = rpc.EdgeAdminOperationResult.fromObject(result);
        break;
      case 'edge.exchangeCertificates':
        response.edge_exchange_certificates = rpc.EdgeExchangeCertificatesResult.fromObject(result);
        break;
      case 'edge.fullSync':
        response.edge_full_sync = rpc.EdgeFullSyncResult.fromObject(result);
        break;
      case 'edge.getChannels':
        response.edge_get_channels = rpc.EdgeGetChannelsResult.fromObject(result);
        break;
      case 'edge.getACLs':
        response.edge_get_acls = rpc.EdgeGetACLsResult.fromObject(result);
        break;
      case 'edge.saveChannel':
        response.edge_save_channel = rpc.EdgeSaveChannelResult.fromObject(result);
        break;
      case 'edge.saveACL':
        response.edge_save_acl = rpc.EdgeSaveACLResult.fromObject(result);
        break;
      case 'edge.join':
        response.edge_join = rpc.EdgeJoinResult.fromObject(result);
        break;
      case 'edge.joinComplete':
        response.edge_join_complete = rpc.EdgeJoinCompleteResult.fromObject(result);
        break;
      case 'edge.handleACL':
        response.edge_handle_acl = rpc.EdgeHandleACLResult.fromObject(result);
        break;
      case 'edge.handlePermissionQuery':
        response.edge_handle_permission_query = rpc.EdgeHandlePermissionQueryResult.fromObject(result);
        break;
      case 'edge.reportPeerDisconnect':
        response.edge_report_peer_disconnect = rpc.EdgeReportPeerDisconnectResult.fromObject(result);
        break;
      case 'edge.reportQuality':
        response.edge_report_quality = rpc.EdgeReportQualityResult.fromObject(result);
        break;
      case 'cluster.getStatus':
        response.cluster_get_status = rpc.ClusterGetStatusResult.fromObject(result);
        break;
      case 'blob.put':
        response.blob_put = rpc.BlobPutResult.fromObject(result);
        break;
      case 'blob.get':
        response.blob_get = rpc.BlobGetResult.fromObject(result);
        break;
      case 'blob.getUserTexture':
        response.blob_get_user_texture = rpc.BlobGetUserTextureResult.fromObject(result);
        break;
      case 'blob.getUserComment':
        response.blob_get_user_comment = rpc.BlobGetUserCommentResult.fromObject(result);
        break;
      case 'blob.setUserTexture':
        response.blob_set_user_texture = rpc.BlobSetUserTextureResult.fromObject(result);
        break;
      case 'blob.setUserComment':
        response.blob_set_user_comment = rpc.BlobSetUserCommentResult.fromObject(result);
        break;
    }

    return response;
  }

  /**
   * 发送类型安全的通知到客户端
   * @param channel RPC 通道
   * @param method 通知方法名
   * @param params 通知参数
   */
  notify<M extends HubToEdgeNotifications['method']>(
    channel: RPCChannel,
    method: M,
    params: NotificationParams<M>
  ): void {
    const notification = this.createTypedNotification(method, params);
    channel.notify(method, notification);
  }

  /**
   * Create a TypedRPCNotification from method and params
   */
  private createTypedNotification<M extends HubToEdgeNotifications['method']>(
    method: M,
    params: NotificationParams<M>
  ): hubedgeRpc.TypedRPCNotification {
    const { TypedRPCNotification } = require('../generated/proto/HubEdgeRPC.js').hubedge;
    const rpc = require('../generated/proto/HubEdgeRPC.js').hubedge;
    const notification = new TypedRPCNotification({
      method,
      timestamp: Date.now(),
    });

    switch (method) {
      case 'voice.data':
        notification.voice_data = rpc.HubVoiceDataParams.fromObject({
          from_session_id: (params as NotificationParams<'voice.data'>).fromSessionId,
          target_session_id: (params as NotificationParams<'voice.data'>).targetSessionId,
          voice_data: (params as NotificationParams<'voice.data'>).voiceData,
          timestamp: (params as NotificationParams<'voice.data'>).timestamp,
        });
        break;
      case 'edge.forceDisconnect':
        notification.force_disconnect = rpc.HubForceDisconnectParams.fromObject(params);
        break;
      case 'edge.peerJoined':
        notification.peer_joined = rpc.HubPeerJoinedParams.fromObject({
          id: (params as NotificationParams<'edge.peerJoined'>).id,
          name: (params as NotificationParams<'edge.peerJoined'>).name,
          host: (params as NotificationParams<'edge.peerJoined'>).host,
          port: (params as NotificationParams<'edge.peerJoined'>).port,
          voice_port: (params as NotificationParams<'edge.peerJoined'>).voicePort,
        });
        break;
      case 'hub.aclResponse':
        notification.acl_response = rpc.HubACLResponseParams.fromObject({
          edge_id: (params as NotificationParams<'hub.aclResponse'>).edge_id,
          actor_session: (params as NotificationParams<'hub.aclResponse'>).actor_session,
          success: (params as NotificationParams<'hub.aclResponse'>).success,
          channel_id: (params as NotificationParams<'hub.aclResponse'>).channel_id,
          raw_data: (params as NotificationParams<'hub.aclResponse'>).raw_data 
            ? Buffer.from((params as NotificationParams<'hub.aclResponse'>).raw_data!, 'base64')
            : undefined,
          error: (params as NotificationParams<'hub.aclResponse'>).error,
          permission_denied: (params as NotificationParams<'hub.aclResponse'>).permission_denied,
        });
        break;
    }

    return notification;
  }

  /**
   * 广播类型安全的通知到所有客户端
   * 使用 Promise.allSettled 确保单个客户端失败不影响其他客户端
   * @param channels RPC 通道列表
   * @param method 通知方法名
   * @param params 通知参数
   */
  async broadcast<M extends HubToEdgeNotifications['method']>(
    channels: RPCChannel[],
    method: M,
    params: NotificationParams<M>
  ): Promise<void> {
    const promises = channels.map(channel => 
      Promise.resolve().then(() => {
        try {
          this.notify(channel, method, params);
        } catch (error) {
          // 记录错误但不中断其他广播
          throw error;
        }
      })
    );
    
    await Promise.allSettled(promises);
  }
}

/**
 * 创建类型安全的 RPC 服务器
 */
export function createTypedRPCServer(): TypedRPCServer {
  return new TypedRPCServer();
}
