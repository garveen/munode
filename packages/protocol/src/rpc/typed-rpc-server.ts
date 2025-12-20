/**
 * Type-Safe RPC Server Handler
 * 为 Hub Server 提供类型安全的请求处理器
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
  HubNotificationParams,
} from './rpc-types.js';

// Use generic version for type-safe notifications
type NotificationParams<M extends HubToEdgeNotifications['method']> = HubNotificationParams<M>;

// Import protobuf types for typed conversions
type TypedRPCRequest = hubedgeRpc.TypedRPCRequest;
type TypedRPCResponse = hubedgeRpc.TypedRPCResponse;
type TypedRPCNotification = hubedgeRpc.TypedRPCNotification;

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
  data?: string;
}

/**
 * Handler definition for batch registration
 */
export interface HandlerDefinition<M extends EdgeToHubMethods['method']> {
  method: M;
  handler: RPCHandler<M>;
}

// TypeScript interface types for Hub->Edge notifications
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
 * 类型安全的 RPC 服务器
 */
export class TypedRPCServer {
  private handlers = new Map<string, RPCHandler<EdgeToHubMethods['method']>>();

  /**
   * 注册类型安全的处理器
   */
  handle<M extends EdgeToHubMethods['method']>(method: M, handler: RPCHandler<M>): void {
    this.handlers.set(method, handler);
  }

  /**
   * 批量注册处理器（使用列表+循环方式）
   * Uses a flexible type to allow any string method names
   */
  registerHandlers(
    definitions: Array<{
      method: string;
      handler: (channel: RPCChannel, params: RPCParams<EdgeToHubMethods['method']>) => Promise<RPCResult<EdgeToHubMethods['method']>>;
    }>
  ): void {
    for (const def of definitions) {
      this.handlers.set(def.method, def.handler as RPCHandler<EdgeToHubMethods['method']>);
    }
  }

  /**
   * 取消注册处理器
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
   */
  async handleRequest(
    channel: RPCChannel,
    request: TypedRPCRequest,
    respond: (response: TypedRPCResponse, error?: RPCError) => void
  ): Promise<void> {
    const method = request.method;
    const handler = this.handlers.get(method);

    if (!handler) {
      respond({ request_id: request.request_id, method }, {
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
      respond({ request_id: request.request_id, method }, {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }

  /**
   * Extract params from TypedRPCRequest based on method
   */
  private extractRequestParams(request: TypedRPCRequest): RPCParams<EdgeToHubMethods['method']> {
    const method = request.method;
    
    switch (method) {
      case 'edge.register':
        return request.edge_register as RPCParams<'edge.register'>;
      case 'edge.heartbeat':
        return request.edge_heartbeat as RPCParams<'edge.heartbeat'>;
      case 'edge.allocateSessionId':
        return request.edge_allocate_session_id as RPCParams<'edge.allocateSessionId'>;
      case 'edge.authenticateUser':
        // 直接返回protobuf对象，保留has_字段信息
        return request.edge_authenticate_user as any as RPCParams<'edge.authenticateUser'>;

      case 'edge.syncVoiceTarget':
        return request.edge_sync_voice_target as RPCParams<'edge.syncVoiceTarget'>;
      case 'edge.getVoiceTargets':
        return request.edge_get_voice_targets as RPCParams<'edge.getVoiceTargets'>;
      case 'edge.routeVoice': {
        const routeVoice = request.edge_route_voice;
        if (routeVoice) {
          return {
            fromEdgeId: routeVoice.from_edge_id,
            fromSessionId: routeVoice.from_session_id,
            target_id: routeVoice.target_id,
            voiceData: Buffer.from(routeVoice.voice_data),
            timestamp: routeVoice.timestamp,
          } as RPCParams<'edge.routeVoice'>;
        }
        throw new Error('Missing edge.routeVoice params');
      }
      case 'edge.adminOperation':
        return request.edge_admin_operation as RPCParams<'edge.adminOperation'>;
      case 'edge.exchangeCertificates':
        return request.edge_exchange_certificates as RPCParams<'edge.exchangeCertificates'>;
      case 'edge.fullSync':
        return request.edge_full_sync as RPCParams<'edge.fullSync'>;
      case 'edge.getChannels':
        return {} as RPCParams<'edge.getChannels'>;
      case 'edge.getACLs':
        return request.edge_get_acls as RPCParams<'edge.getACLs'>;
      case 'edge.saveChannel':
        return { channel: request.edge_save_channel } as RPCParams<'edge.saveChannel'>;
      case 'edge.saveACL':
        return request.edge_save_acl as RPCParams<'edge.saveACL'>;
      case 'edge.join': {
        const join = request.edge_join;
        if (join) {
          return {
            server_id: join.server_id,
            name: join.name,
            host: join.host,
            port: join.port,
            voicePort: join.voice_port,
            capacity: join.capacity,
          } as RPCParams<'edge.join'>;
        }
        throw new Error('Missing edge.join params');
      }
      case 'edge.joinComplete': {
        const joinComplete = request.edge_join_complete;
        if (joinComplete) {
          return {
            server_id: joinComplete.server_id,
            token: joinComplete.token,
            connectedPeers: joinComplete.connected_peers,
          } as RPCParams<'edge.joinComplete'>;
        }
        throw new Error('Missing edge.joinComplete params');
      }
      case 'edge.handleACL': {
        const handleACL = request.edge_handle_acl;
        if (handleACL) {
          return {
            edge_id: handleACL.edge_id,
            actor_session: handleACL.actor_session,
            actor_user_id: handleACL.actor_user_id,
            actor_username: handleACL.actor_username,
            channel_id: handleACL.channel_id,
            query: handleACL.query,
            raw_data: Buffer.from(handleACL.raw_data).toString('base64'),
          } as RPCParams<'edge.handleACL'>;
        }
        throw new Error('Missing edge.handleACL params');
      }
      case 'edge.handlePermissionQuery':
        return request.edge_handle_permission_query as RPCParams<'edge.handlePermissionQuery'>;
      case 'edge.reportPeerDisconnect': {
        const peerDisconnect = request.edge_report_peer_disconnect;
        if (peerDisconnect) {
          return {
            localEdgeId: peerDisconnect.local_edge_id,
            remoteEdgeId: peerDisconnect.remote_edge_id,
            localClientCount: peerDisconnect.local_client_count,
          } as RPCParams<'edge.reportPeerDisconnect'>;
        }
        throw new Error('Missing edge.reportPeerDisconnect params');
      }
      case 'edge.reportQuality':
        return request.edge_report_quality as RPCParams<'edge.reportQuality'>;
      case 'cluster.getStatus':
        return {} as RPCParams<'cluster.getStatus'>;
      case 'blob.put':
        return request.blob_put as RPCParams<'blob.put'>;
      case 'blob.get':
        return request.blob_get as RPCParams<'blob.get'>;
      case 'blob.getUserTexture':
        return request.blob_get_user_texture as RPCParams<'blob.getUserTexture'>;
      case 'blob.getUserComment':
        return request.blob_get_user_comment as RPCParams<'blob.getUserComment'>;
      case 'blob.setUserTexture':
        return request.blob_set_user_texture as RPCParams<'blob.setUserTexture'>;
      case 'blob.setUserComment':
        return request.blob_set_user_comment as RPCParams<'blob.setUserComment'>;
      default:
        return {} as RPCParams<EdgeToHubMethods['method']>;
    }
  }

  /**
   * Create TypedRPCResponse from method and result
   * Directly passes result to protobuf fromObject() without field mapping.
   * Business logic should return objects with protobuf-compatible field names.
   */
  private createTypedResponse(
    method: string,
    requestId: string,
    result: RPCResult<EdgeToHubMethods['method']>
  ): TypedRPCResponse {
    const response: TypedRPCResponse = {
      request_id: requestId,
      method,
    };

    // Directly convert result to protobuf format based on method
    // Type narrowing through switch cases ensures type safety
    switch (method) {
      case 'edge.register':
        response.edge_register = result as RPCResult<'edge.register'>;
        break;
      case 'edge.heartbeat':
        response.edge_heartbeat = result as RPCResult<'edge.heartbeat'>;
        break;
      case 'edge.allocateSessionId':
        response.edge_allocate_session_id = result as RPCResult<'edge.allocateSessionId'>;
        break;
      case 'edge.authenticateUser':
        response.edge_authenticate_user = result as RPCResult<'edge.authenticateUser'>;
        break;
      case 'edge.syncVoiceTarget':
        response.edge_sync_voice_target = result as RPCResult<'edge.syncVoiceTarget'>;
        break;
      case 'edge.getVoiceTargets':
        response.edge_get_voice_targets = result as RPCResult<'edge.getVoiceTargets'>;
        break;
      case 'edge.routeVoice':
        response.edge_route_voice = result as RPCResult<'edge.routeVoice'>;
        break;
      case 'edge.adminOperation':
        response.edge_admin_operation = result as RPCResult<'edge.adminOperation'>;
        break;
      case 'edge.exchangeCertificates':
        response.edge_exchange_certificates = result as RPCResult<'edge.exchangeCertificates'>;
        break;
      case 'edge.fullSync':
        response.edge_full_sync = result as RPCResult<'edge.fullSync'>;
        break;
      case 'edge.getChannels':
        response.edge_get_channels = result as RPCResult<'edge.getChannels'>;
        break;
      case 'edge.getACLs':
        response.edge_get_acls = result as RPCResult<'edge.getACLs'>;
        break;
      case 'edge.saveChannel':
        response.edge_save_channel = result as RPCResult<'edge.saveChannel'>;
        break;
      case 'edge.saveACL':
        response.edge_save_acl = result as RPCResult<'edge.saveACL'>;
        break;
      case 'edge.join':
        response.edge_join = result as RPCResult<'edge.join'>;
        break;
      case 'edge.joinComplete':
        response.edge_join_complete = result as RPCResult<'edge.joinComplete'>;
        break;
      case 'edge.handleACL':
        response.edge_handle_acl = result as RPCResult<'edge.handleACL'>;
        break;
      case 'edge.handlePermissionQuery':
        response.edge_handle_permission_query = result as RPCResult<'edge.handlePermissionQuery'>;
        break;
      case 'edge.reportPeerDisconnect':
        response.edge_report_peer_disconnect = result as RPCResult<'edge.reportPeerDisconnect'>;
        break;
      case 'edge.reportQuality':
        response.edge_report_quality = result as RPCResult<'edge.reportQuality'>;
        break;
      case 'cluster.getStatus':
        response.cluster_get_status = result as RPCResult<'cluster.getStatus'>;
        break;
      case 'blob.put':
        response.blob_put = result as RPCResult<'blob.put'>;
        break;
      case 'blob.get':
        response.blob_get = result as RPCResult<'blob.get'>;
        break;
      case 'blob.getUserTexture':
        response.blob_get_user_texture = result as RPCResult<'blob.getUserTexture'>;
        break;
      case 'blob.getUserComment':
        response.blob_get_user_comment = result as RPCResult<'blob.getUserComment'>;
        break;
      case 'blob.setUserTexture':
        response.blob_set_user_texture = result as RPCResult<'blob.setUserTexture'>;
        break;
      case 'blob.setUserComment':
        response.blob_set_user_comment = result as RPCResult<'blob.setUserComment'>;
        break;
    }

    return response;
  }

  /**
   * 发送类型安全的通知到客户端
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
  ): TypedRPCNotification {
    const notification: TypedRPCNotification = {
      method,
      timestamp: Date.now(),
    };

    switch (method) {
      case 'voice.data': {
        const p = params as HubVoiceDataParamsTS;
        notification.voice_data = {
          from_session_id: p.fromSessionId,
          target_session_id: p.targetSessionId,
          voice_data: p.voiceData,
          timestamp: p.timestamp,
        };
        break;
      }
      case 'edge.forceDisconnect': {
        const p = params as NotificationParams<'edge.forceDisconnect'>;
        notification.force_disconnect = {
          reason: p.reason,
        };
        break;
      }
      case 'edge.peerJoined': {
        const p = params as HubPeerJoinedParamsTS;
        notification.peer_joined = {
          id: p.id,
          name: p.name,
          host: p.host,
          port: p.port,
          voice_port: p.voicePort,
        };
        break;
      }
      case 'hub.aclResponse': {
        const p = params as HubACLResponseParamsTS;
        notification.acl_response = {
          edge_id: p.edge_id,
          actor_session: p.actor_session,
          success: p.success,
          channel_id: p.channel_id,
          raw_data: p.raw_data 
            ? Buffer.from(p.raw_data, 'base64')
            : undefined,
          error: p.error,
          permission_denied: p.permission_denied,
        };
        break;
      }
    }

    return notification;
  }

  /**
   * 广播类型安全的通知到所有客户端
   */
  async broadcast<M extends HubToEdgeNotifications['method']>(
    channels: RPCChannel[],
    method: M,
    params: NotificationParams<M>
  ): Promise<void> {
    const promises = channels.map(channel => 
      Promise.resolve().then(() => {
        this.notify(channel, method, params);
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
