/**
 * Type-Safe RPC Client
 * 为 RPCChannel 提供类型安全的包装器
 * 
 * Note: This module bridges between TypeScript types and Protobuf types.
 * The RPC channel now uses TypedRPCRequest/TypedRPCResponse protobuf messages.
 */

import type { RPCChannel } from './rpc-channel.js';
import { hubedge as hubedgeRpc } from '../generated/proto/HubEdgeRPC.js';
import type {
  EdgeToHubMethods,
  RPCParams,
  RPCResult,
  HubToEdgeNotifications,
  NotificationParams,
} from './rpc-types.js';

// Import protobuf types for typed conversions
type TypedRPCRequest = hubedgeRpc.TypedRPCRequest;
type TypedRPCResponse = hubedgeRpc.TypedRPCResponse;
type TypedRPCNotification = hubedgeRpc.TypedRPCNotification;

// Specific params types for type-safe conversions
interface EdgeRouteVoiceParamsTS {
  fromEdgeId: number;
  fromSessionId: number;
  target_id: number;
  voiceData: Buffer;
  timestamp: number;
}

interface EdgeJoinParamsTS {
  server_id: number;
  name: string;
  host: string;
  port: number;
  voicePort: number;
  capacity: number;
}

interface EdgeJoinCompleteParamsTS {
  server_id: number;
  token: string;
  connectedPeers: number[];
}

interface EdgeReportPeerDisconnectParamsTS {
  localEdgeId: number;
  remoteEdgeId: number;
  localClientCount: number;
}

interface EdgeReportSessionParamsTS {
  session_id: number;
  user_id: number;
  username: string;
  edge_server_id: number;
  channel_id?: number;
  startTime: Date | number;
  ip_address: string;
  groups?: string[];
  cert_hash?: string;
  version?: string;
  release?: string;
  os?: string;
  os_version?: string;
}

interface EdgeHandleACLParamsTS {
  edge_id: number;
  actor_session: number;
  actor_user_id: number;
  actor_username: string;
  channel_id: number;
  query: boolean;
  raw_data: string | Buffer;
}

interface EdgeSaveChannelParamsTS {
  channel?: {
    id?: number;
    name?: string;
    position?: number;
    max_users?: number;
    parent_id?: number;
    inherit_acl?: boolean;
    description?: string;
    description_blob?: string;
  };
}

interface HubVoiceDataParamsTS {
  fromSessionId: number;
  targetSessionId: number;
  voiceData: Buffer;
  timestamp: number;
}

interface HubPeerJoinedParamsTS {
  id: number;
  name: string;
  host: string;
  port: number;
  voicePort: number;
}

interface HubACLResponseParamsTS {
  edge_id: number;
  actor_session: number;
  success: boolean;
  channel_id?: number;
  raw_data?: string;
  error?: string;
  permission_denied?: boolean;
}

/**
 * 类型安全的 RPC 客户端
 */
export class TypedRPCClient {
  constructor(private channel: RPCChannel) {}

  /**
   * 类型安全的 RPC 调用
   */
  async call<M extends EdgeToHubMethods['method']>(
    method: M,
    params: RPCParams<M>
  ): Promise<RPCResult<M>> {
    const request = this.createTypedRequest(method, params);
    const response = await this.channel.call(method, request);
    return this.extractTypedResult(method, response) as RPCResult<M>;
  }

  /**
   * Create a TypedRPCRequest from method and params
   */
  private createTypedRequest<M extends EdgeToHubMethods['method']>(
    method: M,
    params: RPCParams<M>
  ): TypedRPCRequest {
    const request = new hubedgeRpc.TypedRPCRequest({
      request_id: '',
      method,
    }) as TypedRPCRequest;

    // Set the appropriate params field based on method
    switch (method) {
      case 'edge.register':
        request.edge_register = hubedgeRpc.EdgeRegisterParams.fromObject(params);
        break;
      case 'edge.heartbeat':
        request.edge_heartbeat = hubedgeRpc.EdgeHeartbeatParams.fromObject(params);
        break;
      case 'edge.allocateSessionId':
        request.edge_allocate_session_id = hubedgeRpc.EdgeAllocateSessionIdParams.fromObject(params);
        break;
      case 'edge.authenticateUser':
        request.edge_authenticate_user = hubedgeRpc.EdgeAuthenticateUserParams.fromObject(params);
        break;
      case 'edge.reportSession': {
        const p = params as EdgeReportSessionParamsTS;
        request.edge_report_session = hubedgeRpc.EdgeReportSessionParams.fromObject({
          ...p,
          start_time: p.startTime instanceof Date ? p.startTime.getTime() : p.startTime,
        });
        break;
      }
      case 'edge.syncVoiceTarget':
        request.edge_sync_voice_target = hubedgeRpc.EdgeSyncVoiceTargetParams.fromObject(params);
        break;
      case 'edge.getVoiceTargets':
        request.edge_get_voice_targets = hubedgeRpc.EdgeGetVoiceTargetsParams.fromObject(params);
        break;
      case 'edge.routeVoice': {
        const p = params as EdgeRouteVoiceParamsTS;
        request.edge_route_voice = hubedgeRpc.EdgeRouteVoiceParams.fromObject({
          from_edge_id: p.fromEdgeId,
          from_session_id: p.fromSessionId,
          target_id: p.target_id,
          voice_data: p.voiceData,
          timestamp: p.timestamp,
        });
        break;
      }
      case 'edge.adminOperation':
        request.edge_admin_operation = hubedgeRpc.EdgeAdminOperationParams.fromObject(params);
        break;
      case 'edge.exchangeCertificates':
        request.edge_exchange_certificates = hubedgeRpc.EdgeExchangeCertificatesParams.fromObject(params);
        break;
      case 'edge.fullSync':
        request.edge_full_sync = hubedgeRpc.EdgeFullSyncParams.fromObject(params);
        break;
      case 'edge.getChannels':
        request.edge_get_channels = hubedgeRpc.EdgeGetChannelsParams.fromObject({});
        break;
      case 'edge.getACLs':
        request.edge_get_acls = hubedgeRpc.EdgeGetACLsParams.fromObject(params);
        break;
      case 'edge.saveChannel': {
        const p = params as EdgeSaveChannelParamsTS;
        request.edge_save_channel = hubedgeRpc.EdgeSaveChannelParams.fromObject(p.channel || p);
        break;
      }
      case 'edge.saveACL':
        request.edge_save_acl = hubedgeRpc.EdgeSaveACLParams.fromObject(params);
        break;
      case 'edge.join': {
        const p = params as EdgeJoinParamsTS;
        request.edge_join = hubedgeRpc.EdgeJoinParams.fromObject({
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
        const p = params as EdgeJoinCompleteParamsTS;
        request.edge_join_complete = hubedgeRpc.EdgeJoinCompleteParams.fromObject({
          server_id: p.server_id,
          token: p.token,
          connected_peers: p.connectedPeers,
        });
        break;
      }
      case 'edge.handleACL': {
        const p = params as EdgeHandleACLParamsTS;
        request.edge_handle_acl = hubedgeRpc.EdgeHandleACLParams.fromObject({
          ...p,
          raw_data: typeof p.raw_data === 'string' 
            ? Buffer.from(p.raw_data, 'base64')
            : p.raw_data,
        });
        break;
      }
      case 'edge.handlePermissionQuery':
        request.edge_handle_permission_query = hubedgeRpc.EdgeHandlePermissionQueryParams.fromObject(params);
        break;
      case 'edge.reportPeerDisconnect': {
        const p = params as EdgeReportPeerDisconnectParamsTS;
        request.edge_report_peer_disconnect = hubedgeRpc.EdgeReportPeerDisconnectParams.fromObject({
          local_edge_id: p.localEdgeId,
          remote_edge_id: p.remoteEdgeId,
          local_client_count: p.localClientCount,
        });
        break;
      }
      case 'edge.reportQuality':
        request.edge_report_quality = hubedgeRpc.EdgeReportQualityParams.fromObject(params);
        break;
      case 'cluster.getStatus':
        request.cluster_get_status = hubedgeRpc.ClusterGetStatusParams.fromObject({});
        break;
      case 'blob.put':
        request.blob_put = hubedgeRpc.BlobPutParams.fromObject(params);
        break;
      case 'blob.get':
        request.blob_get = hubedgeRpc.BlobGetParams.fromObject(params);
        break;
      case 'blob.getUserTexture':
        request.blob_get_user_texture = hubedgeRpc.BlobGetUserTextureParams.fromObject(params);
        break;
      case 'blob.getUserComment':
        request.blob_get_user_comment = hubedgeRpc.BlobGetUserCommentParams.fromObject(params);
        break;
      case 'blob.setUserTexture':
        request.blob_set_user_texture = hubedgeRpc.BlobSetUserTextureParams.fromObject(params);
        break;
      case 'blob.setUserComment':
        request.blob_set_user_comment = hubedgeRpc.BlobSetUserCommentParams.fromObject(params);
        break;
    }
    
    return request;
  }

  /**
   * Extract typed result from TypedRPCResponse
   */
  private extractTypedResult<M extends EdgeToHubMethods['method']>(
    method: M,
    response: TypedRPCResponse
  ): RPCResult<M> | Record<string, never> {
    switch (method) {
      case 'edge.register':
        return response.edge_register?.toObject() as RPCResult<M>;
      case 'edge.heartbeat':
        return response.edge_heartbeat?.toObject() as RPCResult<M>;
      case 'edge.allocateSessionId':
        return response.edge_allocate_session_id?.toObject() as RPCResult<M>;
      case 'edge.authenticateUser':
        return response.edge_authenticate_user?.toObject() as RPCResult<M>;
      case 'edge.reportSession':
        return response.edge_report_session?.toObject() as RPCResult<M>;
      case 'edge.syncVoiceTarget':
        return response.edge_sync_voice_target?.toObject() as RPCResult<M>;
      case 'edge.getVoiceTargets':
        return response.edge_get_voice_targets?.toObject() as RPCResult<M>;
      case 'edge.routeVoice':
        return response.edge_route_voice?.toObject() as RPCResult<M>;
      case 'edge.adminOperation':
        return response.edge_admin_operation?.toObject() as RPCResult<M>;
      case 'edge.exchangeCertificates':
        return response.edge_exchange_certificates?.toObject() as RPCResult<M>;
      case 'edge.fullSync':
        return response.edge_full_sync?.toObject() as RPCResult<M>;
      case 'edge.getChannels':
        return response.edge_get_channels?.toObject() as RPCResult<M>;
      case 'edge.getACLs':
        return response.edge_get_acls?.toObject() as RPCResult<M>;
      case 'edge.saveChannel':
        return response.edge_save_channel?.toObject() as RPCResult<M>;
      case 'edge.saveACL':
        return response.edge_save_acl?.toObject() as RPCResult<M>;
      case 'edge.join':
        return response.edge_join?.toObject() as RPCResult<M>;
      case 'edge.joinComplete':
        return response.edge_join_complete?.toObject() as RPCResult<M>;
      case 'edge.handleACL':
        return response.edge_handle_acl?.toObject() as RPCResult<M>;
      case 'edge.handlePermissionQuery':
        return response.edge_handle_permission_query?.toObject() as RPCResult<M>;
      case 'edge.reportPeerDisconnect':
        return response.edge_report_peer_disconnect?.toObject() as RPCResult<M>;
      case 'edge.reportQuality':
        return response.edge_report_quality?.toObject() as RPCResult<M>;
      case 'cluster.getStatus':
        return response.cluster_get_status?.toObject() as RPCResult<M>;
      case 'blob.put':
        return response.blob_put?.toObject() as RPCResult<M>;
      case 'blob.get':
        return response.blob_get?.toObject() as RPCResult<M>;
      case 'blob.getUserTexture':
        return response.blob_get_user_texture?.toObject() as RPCResult<M>;
      case 'blob.getUserComment':
        return response.blob_get_user_comment?.toObject() as RPCResult<M>;
      case 'blob.setUserTexture':
        return response.blob_set_user_texture?.toObject() as RPCResult<M>;
      case 'blob.setUserComment':
        return response.blob_set_user_comment?.toObject() as RPCResult<M>;
      default:
        return {};
    }
  }

  /**
   * 类型安全的通知发送（无需等待响应）
   */
  notify<M extends HubToEdgeNotifications['method']>(
    method: M,
    params: NotificationParams<M>
  ): void {
    const notification = this.createTypedNotification(method, params);
    this.channel.notify(method, notification);
  }

  /**
   * Create a TypedRPCNotification from method and params
   */
  private createTypedNotification<M extends HubToEdgeNotifications['method']>(
    method: M,
    params: NotificationParams<M>
  ): TypedRPCNotification {
    const { TypedRPCNotification: Notif } = require('../generated/proto/HubEdgeRPC.js').hubedge;
    const rpc = require('../generated/proto/HubEdgeRPC.js').hubedge;
    const notification = new Notif({
      method,
      timestamp: Date.now(),
    }) as TypedRPCNotification;

    switch (method) {
      case 'voice.data': {
        const p = params as HubVoiceDataParamsTS;
        notification.voice_data = rpc.HubVoiceDataParams.fromObject({
          from_session_id: p.fromSessionId,
          target_session_id: p.targetSessionId,
          voice_data: p.voiceData,
          timestamp: p.timestamp,
        });
        break;
      }
      case 'edge.forceDisconnect':
        notification.force_disconnect = rpc.HubForceDisconnectParams.fromObject(params);
        break;
      case 'edge.peerJoined': {
        const p = params as HubPeerJoinedParamsTS;
        notification.peer_joined = rpc.HubPeerJoinedParams.fromObject({
          id: p.id,
          name: p.name,
          host: p.host,
          port: p.port,
          voice_port: p.voicePort,
        });
        break;
      }
      case 'hub.aclResponse': {
        const p = params as HubACLResponseParamsTS;
        notification.acl_response = rpc.HubACLResponseParams.fromObject({
          edge_id: p.edge_id,
          actor_session: p.actor_session,
          success: p.success,
          channel_id: p.channel_id,
          raw_data: p.raw_data 
            ? Buffer.from(p.raw_data, 'base64')
            : undefined,
          error: p.error,
          permission_denied: p.permission_denied,
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
