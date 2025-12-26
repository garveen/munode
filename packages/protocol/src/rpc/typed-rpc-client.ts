/**
 * Type-Safe RPC Client
 * 为 RPCChannel 提供类型安全的包装器
 * 
 * Note: This module bridges between TypeScript types and Protobuf types.
 * The RPC channel now uses TypedRPCRequest/TypedRPCResponse protobuf messages.
 */

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
import type {
  TypedRPCRequest,
  TypedRPCResponse,
  TypedRPCNotification,
} from '../generated/proto/HubEdgeRPC.js';

import type { IRPCChannel } from './rpc-channel.js';

/**
 * 类型安全的 RPC 客户端
 */
export class TypedRPCClient {
  constructor(private channel: IRPCChannel) {}

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
    const request: TypedRPCRequest = {
      request_id: '',
      method,
    };

    // Set the appropriate params field based on method
    // Each case narrows params to the specific type and converts to protobuf format
    switch (method) {
      case 'edge.register': {
        const p = params as RPCParams<'edge.register'>;
        request.edge_register = {
          server_id: p.server_id,
          name: p.name,
          host: p.host,
          port: p.port,
          region: p.region,
          capacity: p.capacity,
          certificate: p.certificate,
          challenge: p.challenge,
          challenge_response: p.challenge_response,
        };
        break;
      }
      case 'edge.heartbeat': {
        const p = params as RPCParams<'edge.heartbeat'>;
        request.edge_heartbeat = {
          server_id: p.server_id,
          stats: p.stats ? {
            user_count: p.stats.user_count,
            channel_count: p.stats.channel_count,
            cpu_usage: p.stats.cpu_usage,
            memory_usage_mb: p.stats.memory_usage,
            bandwidth_in: p.stats.bandwidth?.in,
            bandwidth_out: p.stats.bandwidth?.out,
          } : undefined,
        };
        break;
      }
      case 'edge.allocateSessionId': {
        const p = params as RPCParams<'edge.allocateSessionId'>;
        request.edge_allocate_session_id = {
          edge_id: p.edge_id,
        };
        break;
      }
      case 'edge.authenticateUser': {
        const p = params as RPCParams<'edge.authenticateUser'>;
        request.edge_authenticate_user = {
          session_id: p.session_id,
          server_id: p.server_id,
          username: p.username,
          password: p.password,
          tokens: p.tokens,
          client_info: p.client_info ? {
            ip_address: p.client_info.ip_address,
            ip_version: p.client_info.ip_version,
            release: p.client_info.release,
            version: p.client_info.version,
            os: p.client_info.os,
            os_version: p.client_info.os_version,
            certificate_hash: p.client_info.certificate_hash,
          } : undefined,
          // PreConnect state
          mute: p.mute,
          deaf: p.deaf,
          suppress: p.suppress,
          self_mute: p.self_mute,
          self_deaf: p.self_deaf,
          priority_speaker: p.priority_speaker,
          recording: p.recording,
        };
        break;
      }
      case 'edge.syncVoiceTarget': {
        const p = params as RPCParams<'edge.syncVoiceTarget'>;
        request.edge_sync_voice_target = {
          edge_id: p.edge_id,
          client_session: p.client_session,
          target_id: p.target_id,
          config: p.config ? {
            sessions: p.config.targets?.flatMap(t => 
              (t.session && Array.isArray(t.session)) ? t.session.map(s => ({ session: s })) : []
            ) || [],
            channels: p.config.targets?.filter(t => t.channel_id !== undefined).map(t => ({
              channel_id: t.channel_id!,
              children: t.children,
              links: t.links,
              group: t.group,
            })) || [],
          } : undefined,
        };
        break;
      }
      case 'edge.getVoiceTargets': {
        const p = params as RPCParams<'edge.getVoiceTargets'>;
        request.edge_get_voice_targets = {
          edge_id: p.edge_id,
        };
        break;
      }
      case 'edge.relayVoiceViaTcp': {
        const p = params as RPCParams<'edge.relayVoiceViaTcp'>;
        request.edge_relay_voice_via_tcp = {
          from_edge_id: p.from_edge_id,
          target_edge_id: p.target_edge_id,
          voice_packet: p.voice_packet,
          timestamp: p.timestamp,
        };
        break;
      }
      case 'edge.adminOperation': {
        const p = params as RPCParams<'edge.adminOperation'>;
        request.edge_admin_operation = {
          operation: p.operation,
          data: p.data ? Buffer.from(JSON.stringify(p.data)) : undefined,
        };
        break;
      }
      case 'edge.exchangeCertificates': {
        const p = params as RPCParams<'edge.exchangeCertificates'>;
        request.edge_exchange_certificates = {
          server_id: p.server_id,
          certificate: p.certificate,
        };
        break;
      }
      case 'edge.fullSync': {
        const p = params as RPCParams<'edge.fullSync'>;
        request.edge_full_sync = {
          for_user_id: p.for_user_id,
          for_user_groups: p.for_user_groups,
          for_user_channel_id: p.for_user_channel_id,
          for_user_cert_hash: p.for_user_cert_hash,
        };
        break;
      }
      case 'edge.getChannels': {
        request.edge_get_channels = {};
        break;
      }
      case 'edge.getACLs': {
        const p = params as RPCParams<'edge.getACLs'>;
        request.edge_get_acls = {
          channel_id: p.channel_id,
        };
        break;
      }
      case 'edge.saveChannel': {
        const p = params as RPCParams<'edge.saveChannel'>;
        request.edge_save_channel = {
          id: p.channel?.id,
          name: p.channel?.name,
          position: p.channel?.position,
          max_users: p.channel?.max_users,
          parent_id: p.channel?.parent_id,
          inherit_acl: p.channel?.inherit_acl,
          description: p.channel?.description,
          description_blob: p.channel?.description_blob,
        };
        break;
      }
      case 'edge.saveACL': {
        const p = params as RPCParams<'edge.saveACL'>;
        request.edge_save_acl = {
          channel_id: p.channel_id,
          acls: p.acls?.map(a => ({
            id: a.id,
            channel_id: a.channel_id,
            user_id: a.user_id,
            group: a.group,
            apply_here: a.apply_here,
            apply_subs: a.apply_subs,
            allow: a.allow,
            deny: a.deny,
          })),
        };
        break;
      }
      case 'edge.join': {
        const p = params as RPCParams<'edge.join'>;
        request.edge_join = {
          server_id: p.server_id,
          name: p.name,
          host: p.host,
          port: p.port,
          voice_port: p.voicePort,
          capacity: p.capacity,
        };
        break;
      }
      case 'edge.joinComplete': {
        const p = params as RPCParams<'edge.joinComplete'>;
        request.edge_join_complete = {
          server_id: p.server_id,
          token: p.token,
          connected_peers: p.connectedPeers,
        };
        break;
      }
      case 'edge.handleACL': {
        const p = params as RPCParams<'edge.handleACL'>;
        request.edge_handle_acl = {
          edge_id: p.edge_id,
          actor_session: p.actor_session,
          actor_user_id: p.actor_user_id,
          actor_username: p.actor_username,
          channel_id: p.channel_id,
          query: p.query,
          raw_data: Buffer.from(p.raw_data, 'base64'),
        };
        break;
      }
      case 'edge.handlePermissionQuery': {
        const p = params as RPCParams<'edge.handlePermissionQuery'>;
        request.edge_handle_permission_query = {
          edge_id: p.edge_id,
          actor_session: p.actor_session,
          actor_user_id: p.actor_user_id,
          actor_username: p.actor_username,
          channel_id: p.channel_id,
        };
        break;
      }
      case 'edge.reportPeerDisconnect': {
        const p = params as RPCParams<'edge.reportPeerDisconnect'>;
        request.edge_report_peer_disconnect = {
          local_edge_id: p.localEdgeId,
          remote_edge_id: p.remoteEdgeId,
          local_client_count: p.localClientCount,
        };
        break;
      }
      case 'edge.reportQuality': {
        const p = params as RPCParams<'edge.reportQuality'>;
        request.edge_report_quality = {
          edge_id: p.edge_id,
          target_edge_id: p.target_edge_id,
          quality: p.quality ? {
            rtt: p.quality.rtt,
            packet_loss: p.quality.packetLoss,
            jitter: p.quality.jitter,
            samples: p.quality.samples,
          } : undefined,
        };
        break;
      }
      case 'cluster.getStatus': {
        request.cluster_get_status = {};
        break;
      }
      case 'blob.put': {
        const p = params as RPCParams<'blob.put'>;
        request.blob_put = {
          data: p.data,
        };
        break;
      }
      case 'blob.get': {
        const p = params as RPCParams<'blob.get'>;
        request.blob_get = {
          hash: p.hash,
        };
        break;
      }
      case 'blob.getUserTexture': {
        const p = params as RPCParams<'blob.getUserTexture'>;
        request.blob_get_user_texture = {
          user_id: p.user_id,
        };
        break;
      }
      case 'blob.getUserComment': {
        const p = params as RPCParams<'blob.getUserComment'>;
        request.blob_get_user_comment = {
          user_id: p.user_id,
        };
        break;
      }
      case 'blob.setUserTexture': {
        const p = params as RPCParams<'blob.setUserTexture'>;
        request.blob_set_user_texture = {
          user_id: p.user_id,
          data: p.data,
        };
        break;
      }
      case 'blob.setUserComment': {
        const p = params as RPCParams<'blob.setUserComment'>;
        request.blob_set_user_comment = {
          user_id: p.user_id,
          data: p.data,
        };
        break;
      }
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
        return response.edge_register as RPCResult<M>;
      case 'edge.heartbeat':
        return response.edge_heartbeat as RPCResult<M>;
      case 'edge.allocateSessionId':
        return response.edge_allocate_session_id as RPCResult<M>;
      case 'edge.authenticateUser':
        return response.edge_authenticate_user as RPCResult<M>;
      case 'edge.syncVoiceTarget':
        return response.edge_sync_voice_target as RPCResult<M>;
      case 'edge.getVoiceTargets':
        return response.edge_get_voice_targets as RPCResult<M>;
      case 'edge.relayVoiceViaTcp':
        return response.edge_relay_voice_via_tcp as RPCResult<M>;
      case 'edge.adminOperation':
        return response.edge_admin_operation as RPCResult<M>;
      case 'edge.exchangeCertificates':
        return response.edge_exchange_certificates as RPCResult<M>;
      case 'edge.fullSync':
        return response.edge_full_sync as RPCResult<M>;
      case 'edge.getChannels':
        return response.edge_get_channels as RPCResult<M>;
      case 'edge.getACLs':
        return response.edge_get_acls as RPCResult<M>;
      case 'edge.saveChannel':
        return response.edge_save_channel as RPCResult<M>;
      case 'edge.saveACL':
        return response.edge_save_acl as RPCResult<M>;
      case 'edge.join':
        return response.edge_join as RPCResult<M>;
      case 'edge.joinComplete':
        return response.edge_join_complete as RPCResult<M>;
      case 'edge.handleACL':
        return response.edge_handle_acl as RPCResult<M>;
      case 'edge.handlePermissionQuery':
        return response.edge_handle_permission_query as RPCResult<M>;
      case 'edge.reportPeerDisconnect':
        return response.edge_report_peer_disconnect as RPCResult<M>;
      case 'edge.reportQuality':
        return response.edge_report_quality as RPCResult<M>;
      case 'cluster.getStatus':
        return response.cluster_get_status as RPCResult<M>;
      case 'blob.put':
        return response.blob_put as RPCResult<M>;
      case 'blob.get':
        return response.blob_get as RPCResult<M>;
      case 'blob.getUserTexture':
        return response.blob_get_user_texture as RPCResult<M>;
      case 'blob.getUserComment':
        return response.blob_get_user_comment as RPCResult<M>;
      case 'blob.setUserTexture':
        return response.blob_set_user_texture as RPCResult<M>;
      case 'blob.setUserComment':
        return response.blob_set_user_comment as RPCResult<M>;
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
    const notification: TypedRPCNotification = {
      method,
      timestamp: Date.now(),
    };

    switch (method) {
      case 'voice.data': {
        const p = params as NotificationParams<'voice.data'>;
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
        const p = params as NotificationParams<'edge.peerJoined'>;
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
        const p = params as NotificationParams<'hub.aclResponse'>;
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
   * 获取底层 RPCChannel
   */
  getChannel(): IRPCChannel {
    return this.channel;
  }
}

/**
 * 创建类型安全的 RPC 客户端
 */
export function createTypedRPCClient(channel: IRPCChannel): TypedRPCClient {
  return new TypedRPCClient(channel);
}
