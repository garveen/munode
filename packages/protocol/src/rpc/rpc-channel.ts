import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { EdgeHubPacket, PacketType, RPCError as ProtoRPCError, Heartbeat, HeartbeatAck } from '../generated/proto/HubEdge.js';
import { 
  TypedRPCRequest, 
  TypedRPCResponse, 
  TypedRPCNotification,
  HubVoiceDataParams,
  HubForceDisconnectParams,
  HubPeerJoinedParams,
  HubACLResponseParams,
  HubUserJoinedParams,
  HubUserMovedParams,
  HubChannelCreatedParams,
  HubChannelRemovedParams,
  HubChannelUpdatedParams,
  HubSyncVoiceTargetParams,
} from '../generated/proto/HubEdgeRPC.js';
import type { Logger } from '@munode/common';

// ============================================================================
// Notification Parameter Types
// ============================================================================

// Import notification types from rpc-types
import type {
  HubToEdgeNotifications,
  EdgeToHubNotifications,
} from './rpc-types.js';

// Import ChannelData from hub-edge-types
import type { ChannelData } from '../hub-edge-types.js';

// Internal parameter types for notification creation (used by createNotification)
// These match the camelCase style used in protobuf definitions
interface VoiceDataParams {
  fromSessionId: number;
  targetSessionId: number;
  voiceData: Uint8Array;
  timestamp: number;
}

interface ForceDisconnectParams {
  reason: string;
}

interface PeerJoinedParams {
  id: number;
  name: string;
  host: string;
  port: number;
  voicePort: number;
}

interface ACLResponseParams {
  edge_id: number;
  actor_session: number;
  success: boolean;
  channel_id?: number;
  raw_data?: string;
  error?: string;
  permission_denied?: boolean;
}

interface UserJoinedParams {
  session_id: number;
  edge_id: number;
  user_id?: number;
  username: string;
  channel_id: number;
  groups?: string[];
  cert_hash?: string;
  mute?: boolean;
  deaf?: boolean;
  suppress?: boolean;
  self_mute?: boolean;
  self_deaf?: boolean;
  priority_speaker?: boolean;
  recording?: boolean;
}

interface UserMovedParams {
  session_id: number;
  edge_id: number;
  channel_id: number;
  actor_session?: number;
}

interface ChannelCreatedParams {
  channel: ChannelData;
}

interface ChannelRemovedParams {
  channel_id: number;
}

interface ChannelUpdatedParams {
  channel: ChannelData;
}

interface SyncVoiceTargetParams {
  edge_id: number;
  client_session: number;
  target_id: number;
  config: unknown;
  timestamp: number;
}

// Union type of internal params used by createNotification
type InternalNotificationParams =
  | VoiceDataParams
  | ForceDisconnectParams
  | PeerJoinedParams
  | ACLResponseParams
  | UserJoinedParams
  | UserMovedParams
  | ChannelCreatedParams
  | ChannelRemovedParams
  | ChannelUpdatedParams
  | SyncVoiceTargetParams;

// Union type for all notification parameters
// This is the public type combining all Hub->Edge and Edge->Hub notification params
export type NotificationParams =
  | HubToEdgeNotifications['params']
  | EdgeToHubNotifications['params']
  | InternalNotificationParams;

// Internal type for notification data construction
interface NotificationDataType {
  method: string;
  timestamp: number;
  voice_data?: HubVoiceDataParams;
  force_disconnect?: HubForceDisconnectParams;
  peer_joined?: HubPeerJoinedParams;
  acl_response?: HubACLResponseParams;
  user_joined?: HubUserJoinedParams;
  user_moved?: HubUserMovedParams;
  channel_created?: HubChannelCreatedParams;
  channel_removed?: HubChannelRemovedParams;
  channel_updated?: HubChannelUpdatedParams;
  sync_voice_target?: HubSyncVoiceTargetParams;
  unknown_params_json?: string;
}

// ============================================================================
// Core Types
// ============================================================================

export interface PendingRequest {
  resolve: (result: TypedRPCResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface Message {
  id?: string;
  type: string;
  method?: string;
  params?: TypedRPCRequest;
  result?: TypedRPCResponse;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
  timestamp: number;
}

/**
 * IRPCChannel - Interface for RPC communication channel
 */
export interface IRPCChannel {
  call(method: string, request: TypedRPCRequest, timeout?: number): Promise<TypedRPCResponse>;
  notify(method: string, params: TypedRPCNotification | NotificationParams): void;
  isConnected(): boolean;
}

/**
 * RPCChannel - Protobuf-based RPC communication channel
 * 
 * Uses typed protobuf messages for all communication - NO JSON serialization.
 */
export class RPCChannel extends EventEmitter implements IRPCChannel {
  private ws: WebSocket;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestTimeout = 30000;
  private heartbeatSeq = 0;
  private logger?: Logger;

  constructor(ws: WebSocket, logger?: Logger) {
    super();
    this.ws = ws;
    this.logger = logger;
    this.setupWebSocket();
  }

  private setupWebSocket(): void {
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('close', this.handleClose.bind(this));
    this.ws.on('error', this.handleError.bind(this));
  }

  /**
   * Send typed RPC request
   */
  async call(method: string, request: TypedRPCRequest, timeout?: number): Promise<TypedRPCResponse> {
    const id = this.generateId();
    const effectiveTimeout = timeout || this.requestTimeout;

    // Set request metadata
    request.request_id = id;
    request.method = method;
    request.timeout_ms = effectiveTimeout;

    const packet: EdgeHubPacket = {
      type: PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: request,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, effectiveTimeout);

      this.pendingRequests.set(id, { 
        resolve,
        reject, 
        timer,
        method,
      });
      this.sendPacket(packet);
    });
  }

  /**
   * Send typed notification (no response expected)
   * Accepts either a TypedRPCNotification directly or plain object params
   */
  notify(method: string, params: TypedRPCNotification | NotificationParams): void {
    let notification: TypedRPCNotification;
    
    // If params is already a TypedRPCNotification, use it directly
    if (typeof params === 'object' && 'timestamp' in params && typeof params.timestamp === 'number') {
      notification = params as TypedRPCNotification;
      notification.method = method;
      notification.timestamp = Date.now();
    } else {
      // Create TypedRPCNotification from plain object based on method
      notification = this.createNotification(method, params as NotificationParams);
    }
    
    const packet: EdgeHubPacket = {
      type: PacketType.PACKET_TYPE_RPC_NOTIFICATION,
      rpc_notification: notification,
    };

    this.sendPacket(packet);
  }

  /**
   * Create TypedRPCNotification from method and params
   * Handles known internal param types directly, falls back to JSON serialization for others
   */
  private createNotification(method: string, params: NotificationParams): TypedRPCNotification {
    const notificationData: NotificationDataType = {
      method,
      timestamp: Date.now(),
    };

    switch (method) {
      case 'hub.voiceData': {
        const p = params as VoiceDataParams;
        notificationData.voice_data = {
          from_session_id: p.fromSessionId,
          target_session_id: p.targetSessionId,
          voice_data: p.voiceData,
          timestamp: p.timestamp,
        };
        break;
      }
      case 'edge.forceDisconnect': {
        const p = params as ForceDisconnectParams;
        notificationData.force_disconnect = {
          reason: p.reason,
        };
        break;
      }
      case 'edge.peerJoined': {
        const p = params as PeerJoinedParams;
        notificationData.peer_joined = {
          id: p.id,
          name: p.name,
          host: p.host,
          port: p.port,
          voice_port: p.voicePort,
        };
        break;
      }
      case 'hub.aclResponse': {
        const p = params as ACLResponseParams;
        notificationData.acl_response = { 
          edge_id: p.edge_id,
          actor_session: p.actor_session,
          success: p.success,
          channel_id: p.channel_id,
          raw_data: p.raw_data ? new TextEncoder().encode(p.raw_data) : undefined,
          error: p.error,
          permission_denied: p.permission_denied,
        };
        break;
      }
      case 'hub.userJoined': {
        const p = params as UserJoinedParams;
        notificationData.user_joined = { 
          session_id: p.session_id,
          edge_id: p.edge_id,
          user_id: p.user_id ?? 0,
          username: p.username,
          channel_id: p.channel_id,
          groups: p.groups ?? [],
          cert_hash: p.cert_hash,
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
      case 'hub.userMoved': {
        const p = params as UserMovedParams;
        notificationData.user_moved = { 
          session_id: p.session_id,
          edge_id: p.edge_id,
          channel_id: p.channel_id,
          actor_session: p.actor_session,
        };
        break;
      }
      case 'hub.channelCreated': {
        const p = params as ChannelCreatedParams;
        notificationData.channel_created = { 
          channel: { 
            channel_id: p.channel.channel_id,
            name: p.channel.name ?? '', // Required field in protobuf
            parent_id: p.channel.parent_id,
            description: p.channel.description,
            position: p.channel.position,
            max_users: p.channel.max_users,
            temporary: p.channel.temporary,
            inherit_acl: p.channel.inherit_acl,
            links: p.channel.links ?? [],
          },
        };
        break;
      }
      case 'hub.channelRemoved': {
        const p = params as ChannelRemovedParams;
        notificationData.channel_removed = { 
          channel_id: p.channel_id,
        };
        break;
      }
      case 'hub.channelUpdated': {
        const p = params as ChannelUpdatedParams;
        notificationData.channel_updated = { 
          channel: { 
            channel_id: p.channel.channel_id,
            name: p.channel.name ?? '', // Required field in protobuf
            parent_id: p.channel.parent_id,
            description: p.channel.description,
            position: p.channel.position,
            max_users: p.channel.max_users,
            temporary: p.channel.temporary,
            inherit_acl: p.channel.inherit_acl,
            links: p.channel.links ?? [],
          },
        };
        break;
      }
      case 'hub.syncVoiceTarget': {
        const p = params as SyncVoiceTargetParams;
        notificationData.sync_voice_target = { 
          edge_id: p.edge_id,
          client_session: p.client_session,
          target_id: p.target_id,
          config_json: typeof p.config === 'string' ? p.config : JSON.stringify(p.config),
          timestamp: p.timestamp,
        };
        break;
      }
      default:
        // For unknown methods, store params as JSON
        notificationData.unknown_params_json = JSON.stringify(params);
        break;
    }

    return notificationData as TypedRPCNotification;
  }

  /**
   * Send typed response
   */
  respond(id: string, method: string, response: TypedRPCResponse, error?: { code: number; message: string; data?: string }): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      // Connection is closed, silently ignore the response
      return;
    }

    if (error) {
      this.logger?.error(`RPC Error response for ${method}:`, error);
      const packet: EdgeHubPacket = {
        type: PacketType.PACKET_TYPE_RPC_ERROR,
        rpc_error: {
          request_id: id,
          code: error.code,
          message: error.message,
          details: error.data,
        },
      };
      this.sendPacket(packet);
    } else {
      response.request_id = id;
      response.method = method;

      const packet: EdgeHubPacket = {
        type: PacketType.PACKET_TYPE_RPC_RESPONSE,
        rpc_response: response,
      };
      this.sendPacket(packet);
    }
  }

  /**
   * Send heartbeat
   */
  ping(): void {
    const seq = ++this.heartbeatSeq;
    const packet: EdgeHubPacket = {
      type: PacketType.PACKET_TYPE_HEARTBEAT,
      heartbeat: {
        edge_id: 0,
        sequence: seq,
      },
    };
    this.sendPacket(packet);
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: Buffer): void {
    try {
      const packet = EdgeHubPacket.decode(new Uint8Array(data));

      switch (packet.type) {
        case PacketType.PACKET_TYPE_RPC_REQUEST:
          this.handleRPCRequest(packet);
          break;

        case PacketType.PACKET_TYPE_RPC_RESPONSE:
          this.handleRPCResponse(packet);
          break;

        case PacketType.PACKET_TYPE_RPC_ERROR:
          this.handleRPCError(packet);
          break;

        case PacketType.PACKET_TYPE_RPC_NOTIFICATION:
          this.handleRPCNotification(packet);
          break;

        case PacketType.PACKET_TYPE_HEARTBEAT:
          this.handleHeartbeat(packet);
          break;

        case PacketType.PACKET_TYPE_HEARTBEAT_ACK:
          this.handleHeartbeatAck(packet);
          break;

        case PacketType.PACKET_TYPE_CLIENT_RELAY:
          this.handleClientRelay(packet);
          break;

        case PacketType.PACKET_TYPE_SYNC:
          this.handleSync(packet);
          break;

        default:
          this.logger.error(`Unknown packet type: ${packet.type}`);
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleRPCRequest(packet: EdgeHubPacket): void {
    if (!packet.rpc_request !== undefined || !packet.rpc_request) {
      this.logger.warn('Received RPC_REQUEST packet without rpc_request field');
      return;
    }

    const request = packet.rpc_request;
    const requestId = request.request_id;
    const method = request.method;

    // Wrap in Message for compatibility with control-server
    const message: Message = {
      id: requestId,
      type: 'request',
      method: method,
      params: request,
      timestamp: Date.now(),
    };

    // Emit request event with Message object for control-server compatibility
    this.emit('request', message, (response: TypedRPCResponse, error?: { code: number; message: string; data?: string }) => {
      this.respond(requestId, method, response, error);
    });
  }

  private handleRPCResponse(packet: EdgeHubPacket): void {
    if (!packet.rpc_response !== undefined || !packet.rpc_response) {
      this.logger.warn('Received RPC_RESPONSE packet without rpc_response field');
      return;
    }

    const response = packet.rpc_response;
    const requestId = response.request_id;
    const pending = this.pendingRequests.get(requestId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.resolve(response);
    }
  }

  private handleRPCError(packet: EdgeHubPacket): void {
    if (!packet.rpc_error !== undefined || !packet.rpc_error) {
      this.logger.warn('Received RPC_ERROR packet without rpc_error field');
      return;
    }

    const { request_id: requestId, code, message } = packet.rpc_error;
    const pending = this.pendingRequests.get(requestId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(`RPC Error (${code}): ${message}`));
    }
  }

  private handleRPCNotification(packet: EdgeHubPacket): void {
    if (!packet.rpc_notification !== undefined || !packet.rpc_notification) {
      this.logger.warn('Received RPC_NOTIFICATION packet without rpc_notification field');
      return;
    }

    // Convert typed notification to simple format for backward compatibility
    const notification = this.convertNotificationToSimple(packet.rpc_notification);
    
    // Emit notification event with the converted object
    this.emit('notification', notification);
  }

  /**
   * Convert TypedRPCNotification to simple format with method and params
   */
  private convertNotificationToSimple(typedNotification: TypedRPCNotification): { method: string; params?: unknown } {
    const result: { method: string; params?: unknown } = {
      method: typedNotification.method,
    };

    // Extract params from the appropriate field based on method
    switch (typedNotification.method) {
      case 'hub.voiceData':
        if (typedNotification.voice_data) {
          result.params = {
            fromSessionId: typedNotification.voice_data.from_session_id,
            targetSessionId: typedNotification.voice_data.target_session_id,
            voiceData: typedNotification.voice_data.voice_data,
            timestamp: typedNotification.voice_data.timestamp,
          };
        }
        break;
      case 'edge.forceDisconnect':
        if (typedNotification.force_disconnect) {
          result.params = {
            reason: typedNotification.force_disconnect.reason,
          };
        }
        break;
      case 'edge.peerJoined':
        if (typedNotification.peer_joined) {
          result.params = {
            id: typedNotification.peer_joined.id,
            name: typedNotification.peer_joined.name,
            host: typedNotification.peer_joined.host,
            port: typedNotification.peer_joined.port,
            voicePort: typedNotification.peer_joined.voice_port,
          };
        }
        break;
      case 'hub.aclResponse':
        if (typedNotification.acl_response) {
          result.params = {
            edge_id: typedNotification.acl_response.edge_id,
            actor_session: typedNotification.acl_response.actor_session,
            success: typedNotification.acl_response.success,
            channel_id: typedNotification.acl_response.channel_id,
            raw_data: typedNotification.acl_response.raw_data ? new TextDecoder().decode(typedNotification.acl_response.raw_data) : undefined,
            error: typedNotification.acl_response.error,
            permission_denied: typedNotification.acl_response.permission_denied,
          };
        }
        break;
      case 'hub.userJoined':
        if (typedNotification.user_joined) {
          result.params = {
            session_id: typedNotification.user_joined.session_id,
            edge_id: typedNotification.user_joined.edge_id,
            user_id: typedNotification.user_joined.user_id,
            username: typedNotification.user_joined.username,
            channel_id: typedNotification.user_joined.channel_id,
            groups: typedNotification.user_joined.groups,
            cert_hash: typedNotification.user_joined.cert_hash,
            mute: typedNotification.user_joined.mute,
            deaf: typedNotification.user_joined.deaf,
            suppress: typedNotification.user_joined.suppress,
            self_mute: typedNotification.user_joined.self_mute,
            self_deaf: typedNotification.user_joined.self_deaf,
            priority_speaker: typedNotification.user_joined.priority_speaker,
            recording: typedNotification.user_joined.recording,
          };
        }
        break;
      case 'hub.userMoved':
        if (typedNotification.user_moved) {
          result.params = {
            session_id: typedNotification.user_moved.session_id,
            edge_id: typedNotification.user_moved.edge_id,
            channel_id: typedNotification.user_moved.channel_id,
            actor_session: typedNotification.user_moved.actor_session,
          };
        }
        break;
      case 'hub.channelCreated':
        if (typedNotification.channel_created && typedNotification.channel_created.channel) {
          result.params = {
            channel: typedNotification.channel_created.channel,
          };
        }
        break;
      case 'hub.channelRemoved':
        if (typedNotification.channel_removed) {
          result.params = {
            channel_id: typedNotification.channel_removed.channel_id,
          };
        }
        break;
      case 'hub.channelUpdated':
        if (typedNotification.channel_updated && typedNotification.channel_updated.channel) {
          result.params = {
            channel: typedNotification.channel_updated.channel,
          };
        }
        break;
      case 'hub.syncVoiceTarget':
        if (typedNotification.sync_voice_target) {
          // Parse config_json back to object if it's a string
          let config = typedNotification.sync_voice_target.config_json;
          if (typeof config === 'string') {
            try {
              config = JSON.parse(config);
            } catch (error) {
              this.logger.error('Failed to parse config_json:', error);
              config = null;
            }
          }
          
          result.params = {
            edge_id: typedNotification.sync_voice_target.edge_id,
            client_session: typedNotification.sync_voice_target.client_session,
            target_id: typedNotification.sync_voice_target.target_id,
            config: config,
            timestamp: typedNotification.sync_voice_target.timestamp,
          };
        }
        break;
      default:
        // For unknown methods, try to parse from unknown_params_json
        if (typedNotification.unknown_params_json) {
          try {
            result.params = JSON.parse(typedNotification.unknown_params_json);
          } catch (error) {
            this.logger.warn(`Failed to parse unknown_params_json for method ${typedNotification.method}:`, error);
          }
        }
        break;
    }

    return result;
  }

  private handleHeartbeat(packet: EdgeHubPacket): void {
    if (!packet.heartbeat) {
      return;
    }

    const { edge_id: edgeId, sequence } = packet.heartbeat;
    
    const ackPacket: EdgeHubPacket = {
      type: PacketType.PACKET_TYPE_HEARTBEAT_ACK,
      heartbeat_ack: {
        edge_id: edgeId,
        sequence,
        hub_timestamp: Date.now(),
      },
    };
    this.sendPacket(ackPacket);
    
    this.emit('ping', Date.now());
  }

  private handleHeartbeatAck(packet: EdgeHubPacket): void {
    if (!packet.heartbeat_ack) {
      return;
    }

    const { hub_timestamp: hubTimestamp } = packet.heartbeat_ack;
    const latency = Date.now() - Number(hubTimestamp);
    this.emit('pong', latency);
  }

  private handleClientRelay(packet: EdgeHubPacket): void {
    if (!packet.relay) {
      return;
    }
    this.emit('relay', packet.relay);
  }

  private handleSync(packet: EdgeHubPacket): void {
    if (!packet.sync_data) {
      return;
    }
    this.emit('sync', packet.sync_data);
  }

  private handleClose(code: number, reason: Buffer): void {
    this.emit('close', code, reason);
    this.cleanup();
  }

  private handleError(error: Error): void {
    this.emit('error', error);
  }

  private sendPacket(packet: EdgeHubPacket): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const bytes = EdgeHubPacket.encode(packet).finish();
      this.ws.send(bytes);
    } else {
      throw new Error('WebSocket not open');
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private cleanup(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  close(): void {
    this.cleanup();
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  isConnected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}