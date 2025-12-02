/**
 * Type-Safe RPC Client
 * 为 RPCChannel 提供类型安全的包装器
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
 * 类型安全的 RPC 客户端
 *
 * 使用方法：
 * ```typescript
 * const client = new TypedRPCClient(rpcChannel);
 *
 * // TypeScript 会自动推断参数和返回值类型
 * const result = await client.call('edge.register', {
 *   serverId: 1,
 *   name: 'edge-1',
 *   // ... TypeScript 会提示需要的字段
 * });
 *
 * // result 的类型会被自动推断为 RegisterResponse
 * console.log(result.success);
 * ```
 */
export class TypedRPCClient {
  constructor(private channel: RPCChannel) {}

  /**
   * 类型安全的 RPC 调用
   * @param method RPC 方法名
   * @param params 请求参数（类型会根据 method 自动推断）
   * @returns Promise，返回值类型根据 method 自动推断
   */
  async call<M extends EdgeToHubMethods['method']>(
    method: M,
    params: RPCParams<M>
  ): Promise<RPCResult<M>> {
    // Create typed RPC request with the params set on the appropriate field
    const request = this.createTypedRequest(method, params as Record<string, unknown>);
    const response = await this.channel.call(method, request);
    return this.extractTypedResult(method, response) as RPCResult<M>;
  }

  /**
   * Create a TypedRPCRequest from method and params
   */
  private createTypedRequest(
    method: string,
    params: Record<string, unknown>
  ): hubedgeRpc.TypedRPCRequest {
    const { TypedRPCRequest } = require('../generated/proto/HubEdgeRPC.js').hubedge;
    const rpc = require('../generated/proto/HubEdgeRPC.js').hubedge;
    
    const request = new TypedRPCRequest({
      request_id: '',
      method,
    });

    // Set the appropriate params field based on method
    switch (method) {
      case 'edge.register':
        request.edge_register = rpc.EdgeRegisterParams.fromObject(params);
        break;
      case 'edge.heartbeat':
        request.edge_heartbeat = rpc.EdgeHeartbeatParams.fromObject(params);
        break;
      case 'edge.allocateSessionId':
        request.edge_allocate_session_id = rpc.EdgeAllocateSessionIdParams.fromObject(params);
        break;
      case 'edge.authenticateUser':
        request.edge_authenticate_user = rpc.EdgeAuthenticateUserParams.fromObject(params);
        break;
      case 'edge.reportSession': {
        const p = params as Record<string, unknown>;
        const startTime = p.startTime;
        request.edge_report_session = rpc.EdgeReportSessionParams.fromObject({
          ...p,
          start_time: startTime instanceof Date ? startTime.getTime() : startTime,
        });
        break;
      }
      case 'edge.syncVoiceTarget':
        request.edge_sync_voice_target = rpc.EdgeSyncVoiceTargetParams.fromObject(params);
        break;
      case 'edge.getVoiceTargets':
        request.edge_get_voice_targets = rpc.EdgeGetVoiceTargetsParams.fromObject(params);
        break;
      case 'edge.routeVoice': {
        const p = params as Record<string, unknown>;
        request.edge_route_voice = rpc.EdgeRouteVoiceParams.fromObject({
          from_edge_id: p.fromEdgeId,
          from_session_id: p.fromSessionId,
          target_id: p.target_id,
          voice_data: p.voiceData,
          timestamp: p.timestamp,
        });
        break;
      }
      case 'edge.adminOperation':
        request.edge_admin_operation = rpc.EdgeAdminOperationParams.fromObject(params);
        break;
      case 'edge.exchangeCertificates':
        request.edge_exchange_certificates = rpc.EdgeExchangeCertificatesParams.fromObject(params);
        break;
      case 'edge.fullSync':
        request.edge_full_sync = rpc.EdgeFullSyncParams.fromObject(params);
        break;
      case 'edge.getChannels':
        request.edge_get_channels = rpc.EdgeGetChannelsParams.fromObject({});
        break;
      case 'edge.getACLs':
        request.edge_get_acls = rpc.EdgeGetACLsParams.fromObject(params);
        break;
      case 'edge.saveChannel': {
        const p = params as Record<string, unknown>;
        request.edge_save_channel = rpc.EdgeSaveChannelParams.fromObject(p.channel || p);
        break;
      }
      case 'edge.saveACL':
        request.edge_save_acl = rpc.EdgeSaveACLParams.fromObject(params);
        break;
      case 'edge.join': {
        const p = params as Record<string, unknown>;
        request.edge_join = rpc.EdgeJoinParams.fromObject({
          server_id: p.server_id,
          name: p.name,
          host: p.host,
          port: p.port,
          voice_port: p.voicePort,
          capacity: p.capacity,
        });
        break;
      }
      case 'edge.joinComplete': {
        const p = params as Record<string, unknown>;
        request.edge_join_complete = rpc.EdgeJoinCompleteParams.fromObject({
          server_id: p.server_id,
          token: p.token,
          connected_peers: p.connectedPeers,
        });
        break;
      }
      case 'edge.handleACL': {
        const p = params as Record<string, unknown>;
        request.edge_handle_acl = rpc.EdgeHandleACLParams.fromObject({
          ...p,
          raw_data: typeof p.raw_data === 'string' 
            ? Buffer.from(p.raw_data as string, 'base64')
            : p.raw_data,
        });
        break;
      }
      case 'edge.handlePermissionQuery':
        request.edge_handle_permission_query = rpc.EdgeHandlePermissionQueryParams.fromObject(params);
        break;
      case 'edge.reportPeerDisconnect': {
        const p = params as Record<string, unknown>;
        request.edge_report_peer_disconnect = rpc.EdgeReportPeerDisconnectParams.fromObject({
          local_edge_id: p.localEdgeId,
          remote_edge_id: p.remoteEdgeId,
          local_client_count: p.localClientCount,
        });
        break;
      }
      case 'edge.reportQuality':
        request.edge_report_quality = rpc.EdgeReportQualityParams.fromObject(params);
        break;
      case 'cluster.getStatus':
        request.cluster_get_status = rpc.ClusterGetStatusParams.fromObject({});
        break;
      case 'blob.put':
        request.blob_put = rpc.BlobPutParams.fromObject(params);
        break;
      case 'blob.get':
        request.blob_get = rpc.BlobGetParams.fromObject(params);
        break;
      case 'blob.getUserTexture':
        request.blob_get_user_texture = rpc.BlobGetUserTextureParams.fromObject(params);
        break;
      case 'blob.getUserComment':
        request.blob_get_user_comment = rpc.BlobGetUserCommentParams.fromObject(params);
        break;
      case 'blob.setUserTexture':
        request.blob_set_user_texture = rpc.BlobSetUserTextureParams.fromObject(params);
        break;
      case 'blob.setUserComment':
        request.blob_set_user_comment = rpc.BlobSetUserCommentParams.fromObject(params);
        break;
    }
    
    return request;
  }

  /**
   * Extract typed result from TypedRPCResponse
   */
  private extractTypedResult(
    method: string,
    response: hubedgeRpc.TypedRPCResponse
  ): unknown {
    switch (method) {
      case 'edge.register':
        return response.edge_register?.toObject();
      case 'edge.heartbeat':
        return response.edge_heartbeat?.toObject();
      case 'edge.allocateSessionId':
        return response.edge_allocate_session_id?.toObject();
      case 'edge.authenticateUser':
        return response.edge_authenticate_user?.toObject();
      case 'edge.reportSession':
        return response.edge_report_session?.toObject();
      case 'edge.syncVoiceTarget':
        return response.edge_sync_voice_target?.toObject();
      case 'edge.getVoiceTargets':
        return response.edge_get_voice_targets?.toObject();
      case 'edge.routeVoice':
        return response.edge_route_voice?.toObject();
      case 'edge.adminOperation':
        return response.edge_admin_operation?.toObject();
      case 'edge.exchangeCertificates':
        return response.edge_exchange_certificates?.toObject();
      case 'edge.fullSync':
        return response.edge_full_sync?.toObject();
      case 'edge.getChannels':
        return response.edge_get_channels?.toObject();
      case 'edge.getACLs':
        return response.edge_get_acls?.toObject();
      case 'edge.saveChannel':
        return response.edge_save_channel?.toObject();
      case 'edge.saveACL':
        return response.edge_save_acl?.toObject();
      case 'edge.join':
        return response.edge_join?.toObject();
      case 'edge.joinComplete':
        return response.edge_join_complete?.toObject();
      case 'edge.handleACL':
        return response.edge_handle_acl?.toObject();
      case 'edge.handlePermissionQuery':
        return response.edge_handle_permission_query?.toObject();
      case 'edge.reportPeerDisconnect':
        return response.edge_report_peer_disconnect?.toObject();
      case 'edge.reportQuality':
        return response.edge_report_quality?.toObject();
      case 'cluster.getStatus':
        return response.cluster_get_status?.toObject();
      case 'blob.put':
        return response.blob_put?.toObject();
      case 'blob.get':
        return response.blob_get?.toObject();
      case 'blob.getUserTexture':
        return response.blob_get_user_texture?.toObject();
      case 'blob.getUserComment':
        return response.blob_get_user_comment?.toObject();
      case 'blob.setUserTexture':
        return response.blob_set_user_texture?.toObject();
      case 'blob.setUserComment':
        return response.blob_set_user_comment?.toObject();
      default:
        return {};
    }
  }

  /**
   * 类型安全的通知发送（无需等待响应）
   * @param method 通知方法名
   * @param params 通知参数
   */
  notify<M extends HubToEdgeNotifications['method']>(
    method: M,
    params: NotificationParams<M>
  ): void {
    const notification = this.createTypedNotification(method, params as Record<string, unknown>);
    this.channel.notify(method, notification);
  }

  /**
   * Create a TypedRPCNotification from method and params
   */
  private createTypedNotification(
    method: string,
    params: Record<string, unknown>
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
          from_session_id: params.fromSessionId,
          target_session_id: params.targetSessionId,
          voice_data: params.voiceData,
          timestamp: params.timestamp,
        });
        break;
      case 'edge.forceDisconnect':
        notification.force_disconnect = rpc.HubForceDisconnectParams.fromObject(params);
        break;
      case 'edge.peerJoined':
        notification.peer_joined = rpc.HubPeerJoinedParams.fromObject({
          id: params.id,
          name: params.name,
          host: params.host,
          port: params.port,
          voice_port: params.voicePort,
        });
        break;
      case 'hub.aclResponse': {
        const rawData = params.raw_data;
        notification.acl_response = rpc.HubACLResponseParams.fromObject({
          edge_id: params.edge_id,
          actor_session: params.actor_session,
          success: params.success,
          channel_id: params.channel_id,
          raw_data: typeof rawData === 'string' 
            ? Buffer.from(rawData, 'base64')
            : rawData,
          error: params.error,
          permission_denied: params.permission_denied,
        });
        break;
      }
    }

    return notification;
  }

  /**
   * 获取底层 RPCChannel
   */
  getChannel(): RPCChannel {
    return this.channel;
  }
}

/**
 * 创建类型安全的 RPC 客户端
 */
export function createTypedRPCClient(channel: RPCChannel): TypedRPCClient {
  return new TypedRPCClient(channel);
}
