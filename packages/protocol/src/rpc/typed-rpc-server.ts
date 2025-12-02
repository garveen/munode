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
  NotificationParams,
} from './rpc-types.js';

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
      respond(new hubedgeRpc.TypedRPCResponse({ request_id: request.request_id }) as TypedRPCResponse, {
        code: -32601,
        message: `Method not found: ${method}`,
      });
      return;
    }

    try {
      // Extract params from request based on method
      const params = this.extractRequestParams(request);
      const result = await handler(channel, params as RPCParams<EdgeToHubMethods['method']>);
      
      // Create typed response
      const response = this.createTypedResponse(method, request.request_id, result);
      respond(response, undefined);
    } catch (error) {
      respond(new hubedgeRpc.TypedRPCResponse({ request_id: request.request_id }) as TypedRPCResponse, {
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
        return request.edge_register?.toObject() as RPCParams<'edge.register'>;
      case 'edge.heartbeat':
        return request.edge_heartbeat?.toObject() as RPCParams<'edge.heartbeat'>;
      case 'edge.allocateSessionId':
        return request.edge_allocate_session_id?.toObject() as RPCParams<'edge.allocateSessionId'>;
      case 'edge.authenticateUser':
        return request.edge_authenticate_user?.toObject() as RPCParams<'edge.authenticateUser'>;
      case 'edge.reportSession': {
        const reportSession = request.edge_report_session?.toObject();
        if (reportSession) {
          return {
            session_id: reportSession.session_id,
            user_id: reportSession.user_id,
            username: reportSession.username,
            edge_server_id: reportSession.edge_server_id,
            channel_id: reportSession.channel_id,
            startTime: new Date(reportSession.start_time),
            ip_address: reportSession.ip_address,
            groups: reportSession.groups,
            cert_hash: reportSession.cert_hash,
            version: reportSession.version,
            release: reportSession.release,
            os: reportSession.os,
            os_version: reportSession.os_version,
          } as RPCParams<'edge.reportSession'>;
        }
        throw new Error('Missing edge.reportSession params');
      }
      case 'edge.syncVoiceTarget':
        return request.edge_sync_voice_target?.toObject() as RPCParams<'edge.syncVoiceTarget'>;
      case 'edge.getVoiceTargets':
        return request.edge_get_voice_targets?.toObject() as RPCParams<'edge.getVoiceTargets'>;
      case 'edge.routeVoice': {
        const routeVoice = request.edge_route_voice?.toObject();
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
        return request.edge_admin_operation?.toObject() as RPCParams<'edge.adminOperation'>;
      case 'edge.exchangeCertificates':
        return request.edge_exchange_certificates?.toObject() as RPCParams<'edge.exchangeCertificates'>;
      case 'edge.fullSync':
        return request.edge_full_sync?.toObject() as RPCParams<'edge.fullSync'>;
      case 'edge.getChannels':
        return {} as RPCParams<'edge.getChannels'>;
      case 'edge.getACLs':
        return request.edge_get_acls?.toObject() as RPCParams<'edge.getACLs'>;
      case 'edge.saveChannel':
        return { channel: request.edge_save_channel?.toObject() } as RPCParams<'edge.saveChannel'>;
      case 'edge.saveACL':
        return request.edge_save_acl?.toObject() as RPCParams<'edge.saveACL'>;
      case 'edge.join': {
        const join = request.edge_join?.toObject();
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
        const joinComplete = request.edge_join_complete?.toObject();
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
        const handleACL = request.edge_handle_acl?.toObject();
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
        return request.edge_handle_permission_query?.toObject() as RPCParams<'edge.handlePermissionQuery'>;
      case 'edge.reportPeerDisconnect': {
        const peerDisconnect = request.edge_report_peer_disconnect?.toObject();
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
        return request.edge_report_quality?.toObject() as RPCParams<'edge.reportQuality'>;
      case 'cluster.getStatus':
        return {} as RPCParams<'cluster.getStatus'>;
      case 'blob.put':
        return request.blob_put?.toObject() as RPCParams<'blob.put'>;
      case 'blob.get':
        return request.blob_get?.toObject() as RPCParams<'blob.get'>;
      case 'blob.getUserTexture':
        return request.blob_get_user_texture?.toObject() as RPCParams<'blob.getUserTexture'>;
      case 'blob.getUserComment':
        return request.blob_get_user_comment?.toObject() as RPCParams<'blob.getUserComment'>;
      case 'blob.setUserTexture':
        return request.blob_set_user_texture?.toObject() as RPCParams<'blob.setUserTexture'>;
      case 'blob.setUserComment':
        return request.blob_set_user_comment?.toObject() as RPCParams<'blob.setUserComment'>;
      default:
        return {} as RPCParams<EdgeToHubMethods['method']>;
    }
  }

  /**
   * Create TypedRPCResponse from method and result
   * Uses type narrowing with method-specific result types for type safety
   */
  private createTypedResponse(
    method: string,
    requestId: string,
    result: RPCResult<EdgeToHubMethods['method']>
  ): TypedRPCResponse {
    const response = new hubedgeRpc.TypedRPCResponse({
      request_id: requestId,
      method,
    }) as TypedRPCResponse;

    // Convert result to protobuf format based on method
    // Each case narrows the result type appropriately
    switch (method) {
      case 'edge.register': {
        const r = result as RPCResult<'edge.register'>;
        response.edge_register = hubedgeRpc.EdgeRegisterResult.fromObject({
          success: r.success,
          hub_server_id: r.hub_server_id,
          edge_list: r.edge_list,
          challenge: r.challenge,
          challenge_timeout: r.challenge_timeout,
          error: r.error,
        });
        break;
      }
      case 'edge.heartbeat': {
        const r = result as RPCResult<'edge.heartbeat'>;
        response.edge_heartbeat = hubedgeRpc.EdgeHeartbeatResult.fromObject({
          success: r.success,
          updated_edges: r.updated_edges,
          error: r.error,
        });
        break;
      }
      case 'edge.allocateSessionId': {
        const r = result as RPCResult<'edge.allocateSessionId'>;
        response.edge_allocate_session_id = hubedgeRpc.EdgeAllocateSessionIdResult.fromObject({
          session_id: r.session_id,
        });
        break;
      }
      case 'edge.authenticateUser': {
        const r = result as RPCResult<'edge.authenticateUser'>;
        response.edge_authenticate_user = hubedgeRpc.EdgeAuthenticateUserResult.fromObject({
          success: r.success,
          user_id: r.user_id,
          username: r.username,
          display_name: r.displayName,
          groups: r.groups,
          reason: r.reason,
          reject_type: r.rejectType,
        });
        break;
      }
      case 'edge.reportSession': {
        const r = result as RPCResult<'edge.reportSession'>;
        response.edge_report_session = hubedgeRpc.EdgeReportSessionResult.fromObject({
          success: r.success,
          error: r.error,
        });
        break;
      }
      case 'edge.syncVoiceTarget': {
        const r = result as RPCResult<'edge.syncVoiceTarget'>;
        response.edge_sync_voice_target = hubedgeRpc.EdgeSyncVoiceTargetResult.fromObject({
          success: r.success,
          error: r.error,
        });
        break;
      }
      case 'edge.getVoiceTargets': {
        const r = result as RPCResult<'edge.getVoiceTargets'>;
        response.edge_get_voice_targets = hubedgeRpc.EdgeGetVoiceTargetsResult.fromObject({
          voice_targets: r.voiceTargets?.map(vt => ({
            edge_id: vt.edge_id,
            client_session: vt.client_session,
            target_id: vt.target_id,
            config: vt.config ? {
              sessions: vt.config.sessions?.map((s: number) => ({ session: s })),
              channels: vt.config.channels?.map((c: { channel_id: number; include_subchannels?: boolean; include_links?: boolean; group?: string }) => ({
                channel_id: c.channel_id,
                children: c.include_subchannels,
                links: c.include_links,
                group: c.group,
              })),
            } : undefined,
            timestamp: vt.timestamp,
          })),
        });
        break;
      }
      case 'edge.routeVoice': {
        const r = result as RPCResult<'edge.routeVoice'>;
        response.edge_route_voice = hubedgeRpc.EdgeRouteVoiceResult.fromObject({
          success: r.success,
          routed_to: r.routedTo?.map(rt => ({
            session_id: rt.session_id,
            edge_id: rt.edge_id,
          })),
        });
        break;
      }
      case 'edge.adminOperation': {
        const r = result as RPCResult<'edge.adminOperation'>;
        response.edge_admin_operation = hubedgeRpc.EdgeAdminOperationResult.fromObject({
          success: r.success,
          message: r.message,
          stats: r.stats ? {
            edges: r.stats.edges,
            sessions: r.stats.sessions,
            voice_targets: r.stats.voiceTargets,
            channels: r.stats.channels,
          } : undefined,
        });
        break;
      }
      case 'edge.exchangeCertificates': {
        const r = result as RPCResult<'edge.exchangeCertificates'>;
        response.edge_exchange_certificates = hubedgeRpc.EdgeExchangeCertificatesResult.fromObject({
          success: r.success,
          error: r.error,
        });
        break;
      }
      case 'edge.fullSync': {
        const r = result as RPCResult<'edge.fullSync'>;
        response.edge_full_sync = hubedgeRpc.EdgeFullSyncResult.fromObject({
          channels: r.channels?.map(c => ({
            channel_id: c.id,
            name: c.name,
            parent_id: c.parent_id,
            description: c.description,
            position: c.position,
            max_users: c.max_users,
            temporary: c.temporary,
            inherit_acl: c.inherit_acl,
            links: c.links || [],
          })),
          channel_links: r.channelLinks?.map(l => ({
            channel_id: l.channel_id,
            target_id: l.target_id,
          })),
          acls: r.acls?.map(a => ({
            id: a.id,
            channel_id: a.channel_id,
            user_id: a.user_id,
            group: a.group,
            apply_here: a.apply_here,
            apply_subs: a.apply_subs,
            allow: a.allow,
            deny: a.deny,
          })),
          bans: r.bans?.map(b => ({
            address: b.address,
            mask: b.mask,
            username: b.name,
            cert_hash: b.hash,
            reason: b.reason,
            start: b.start,
            duration: b.duration,
          })),
          sessions: r.sessions?.map(s => ({
            session_id: s.session_id,
            edge_id: s.edge_id,
            user_id: s.user_id,
            username: s.username,
            channel_id: s.channel_id || 0,
            ip_address: s.ip_address,
            cert_hash: s.cert_hash,
            connected_at: s.connected_at,
            groups: s.groups || [],
          })),
          timestamp: r.timestamp,
          sequence: r.sequence,
          edges: r.edges?.map(e => ({
            server_id: e.server_id,
            name: e.name,
            host: e.host,
            port: e.port,
            region: e.region,
            current_load: e.current_load,
            capacity: e.capacity,
          })),
        });
        break;
      }
      case 'edge.getChannels': {
        const r = result as RPCResult<'edge.getChannels'>;
        response.edge_get_channels = hubedgeRpc.EdgeGetChannelsResult.fromObject({
          channels: r.channels?.map(c => ({
            channel_id: c.id,
            name: c.name,
            parent_id: c.parent_id,
            description: c.description,
            position: c.position,
            max_users: c.max_users,
            temporary: c.temporary,
            inherit_acl: c.inherit_acl,
            links: c.links || [],
          })),
        });
        break;
      }
      case 'edge.getACLs': {
        const r = result as RPCResult<'edge.getACLs'>;
        response.edge_get_acls = hubedgeRpc.EdgeGetACLsResult.fromObject({
          acls: r.acls?.map(a => ({
            id: a.id,
            channel_id: a.channel_id,
            user_id: a.user_id,
            group: a.group,
            apply_here: a.apply_here,
            apply_subs: a.apply_subs,
            allow: a.allow,
            deny: a.deny,
          })),
        });
        break;
      }
      case 'edge.saveChannel': {
        const r = result as RPCResult<'edge.saveChannel'>;
        response.edge_save_channel = hubedgeRpc.EdgeSaveChannelResult.fromObject({
          success: r.success,
          channel_id: r.channel_id,
          error: r.error,
        });
        break;
      }
      case 'edge.saveACL': {
        const r = result as RPCResult<'edge.saveACL'>;
        response.edge_save_acl = hubedgeRpc.EdgeSaveACLResult.fromObject({
          success: r.success,
          acl_ids: r.aclIds,
        });
        break;
      }
      case 'edge.join': {
        const r = result as RPCResult<'edge.join'>;
        response.edge_join = hubedgeRpc.EdgeJoinResult.fromObject({
          success: r.success,
          token: r.token,
          peers: r.peers?.map(p => ({
            id: p.id,
            name: p.name,
            host: p.host,
            port: p.port,
            voice_port: p.voicePort,
          })),
          timeout: r.timeout,
        });
        break;
      }
      case 'edge.joinComplete': {
        const r = result as RPCResult<'edge.joinComplete'>;
        response.edge_join_complete = hubedgeRpc.EdgeJoinCompleteResult.fromObject({
          success: r.success,
          error: r.error,
        });
        break;
      }
      case 'edge.handleACL': {
        const r = result as RPCResult<'edge.handleACL'>;
        response.edge_handle_acl = hubedgeRpc.EdgeHandleACLResult.fromObject({
          success: r.success,
          error: r.error,
          permission_denied: r.permission_denied,
          channel_id: r.channel_id,
          raw_data: r.raw_data ? Buffer.from(r.raw_data, 'base64') : undefined,
        });
        break;
      }
      case 'edge.handlePermissionQuery': {
        const r = result as RPCResult<'edge.handlePermissionQuery'>;
        response.edge_handle_permission_query = hubedgeRpc.EdgeHandlePermissionQueryResult.fromObject({
          success: r.success,
          permissions: r.permissions,
          error: r.error,
        });
        break;
      }
      case 'edge.reportPeerDisconnect': {
        const r = result as RPCResult<'edge.reportPeerDisconnect'>;
        response.edge_report_peer_disconnect = hubedgeRpc.EdgeReportPeerDisconnectResult.fromObject({
          action: r.action,
        });
        break;
      }
      case 'edge.reportQuality': {
        const r = result as RPCResult<'edge.reportQuality'>;
        response.edge_report_quality = hubedgeRpc.EdgeReportQualityResult.fromObject({
          success: r.success,
        });
        break;
      }
      case 'cluster.getStatus': {
        const r = result as RPCResult<'cluster.getStatus'>;
        response.cluster_get_status = hubedgeRpc.ClusterGetStatusResult.fromObject({
          edges: r.edges?.map(e => ({
            id: e.id,
            name: e.name,
            host: e.host,
            port: e.port,
            client_count: e.clientCount,
            status: e.status,
            last_seen: e.lastSeen,
          })),
        });
        break;
      }
      case 'blob.put': {
        const r = result as RPCResult<'blob.put'>;
        response.blob_put = hubedgeRpc.BlobPutResult.fromObject({
          success: r.success,
          hash: r.hash,
          error: r.error,
        });
        break;
      }
      case 'blob.get': {
        const r = result as RPCResult<'blob.get'>;
        response.blob_get = hubedgeRpc.BlobGetResult.fromObject({
          success: r.success,
          data: r.data,
          error: r.error,
        });
        break;
      }
      case 'blob.getUserTexture': {
        const r = result as RPCResult<'blob.getUserTexture'>;
        response.blob_get_user_texture = hubedgeRpc.BlobGetUserTextureResult.fromObject({
          success: r.success,
          data: r.data,
          hash: r.hash,
          error: r.error,
        });
        break;
      }
      case 'blob.getUserComment': {
        const r = result as RPCResult<'blob.getUserComment'>;
        response.blob_get_user_comment = hubedgeRpc.BlobGetUserCommentResult.fromObject({
          success: r.success,
          data: r.data,
          hash: r.hash,
          error: r.error,
        });
        break;
      }
      case 'blob.setUserTexture': {
        const r = result as RPCResult<'blob.setUserTexture'>;
        response.blob_set_user_texture = hubedgeRpc.BlobSetUserTextureResult.fromObject({
          success: r.success,
          hash: r.hash,
          error: r.error,
        });
        break;
      }
      case 'blob.setUserComment': {
        const r = result as RPCResult<'blob.setUserComment'>;
        response.blob_set_user_comment = hubedgeRpc.BlobSetUserCommentResult.fromObject({
          success: r.success,
          hash: r.hash,
          error: r.error,
        });
        break;
      }
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
    const notification = new hubedgeRpc.TypedRPCNotification({
      method,
      timestamp: Date.now(),
    }) as TypedRPCNotification;

    switch (method) {
      case 'voice.data': {
        const p = params as HubVoiceDataParamsTS;
        notification.voice_data = hubedgeRpc.HubVoiceDataParams.fromObject({
          from_session_id: p.fromSessionId,
          target_session_id: p.targetSessionId,
          voice_data: p.voiceData,
          timestamp: p.timestamp,
        });
        break;
      }
      case 'edge.forceDisconnect': {
        const p = params as NotificationParams<'edge.forceDisconnect'>;
        notification.force_disconnect = hubedgeRpc.HubForceDisconnectParams.fromObject({
          reason: p.reason,
        });
        break;
      }
      case 'edge.peerJoined': {
        const p = params as HubPeerJoinedParamsTS;
        notification.peer_joined = hubedgeRpc.HubPeerJoinedParams.fromObject({
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
        notification.acl_response = hubedgeRpc.HubACLResponseParams.fromObject({
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
