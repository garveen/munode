import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { hubedge } from '../generated/proto/HubEdge.js';
import { hubedge as hubedgeRpc } from '../generated/proto/HubEdgeRPC.js';

const { EdgeHubPacket, PacketType, RPCError: ProtoRPCError, Heartbeat, HeartbeatAck } = hubedge;

// Re-export the RPC types for external use
export { hubedgeRpc };

export interface PendingRequest {
  resolve: (result: hubedgeRpc.TypedRPCResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface Message {
  id?: string;
  type: string;
  method?: string;
  params?: hubedgeRpc.TypedRPCRequest;
  result?: hubedgeRpc.TypedRPCResponse;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
  timestamp: number;
}

/**
 * RPCChannel - Protobuf-based RPC communication channel
 * 
 * Uses typed protobuf messages for all communication - NO JSON serialization.
 */
export class RPCChannel extends EventEmitter {
  private ws: WebSocket;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestTimeout = 30000;
  private heartbeatSeq = 0;

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
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
  async call(method: string, request: hubedgeRpc.TypedRPCRequest, timeout?: number): Promise<hubedgeRpc.TypedRPCResponse> {
    const id = this.generateId();
    const effectiveTimeout = timeout || this.requestTimeout;

    // Set request metadata
    request.request_id = id;
    request.method = method;
    request.timeout_ms = effectiveTimeout;

    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: request,
    });

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
   */
  notify(method: string, notification: hubedgeRpc.TypedRPCNotification): void {
    notification.method = method;
    notification.timestamp = Date.now();

    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_RPC_NOTIFICATION,
      rpc_notification: notification,
    });

    this.sendPacket(packet);
  }

  /**
   * Send typed response
   */
  respond(id: string, method: string, response: hubedgeRpc.TypedRPCResponse, error?: { code: number; message: string; data?: string }): void {
    if (error) {
      const packet = new EdgeHubPacket({
        type: PacketType.PACKET_TYPE_RPC_ERROR,
        rpc_error: new ProtoRPCError({
          request_id: id,
          code: error.code,
          message: error.message,
          details: error.data,
        }),
      });
      this.sendPacket(packet);
    } else {
      response.request_id = id;
      response.method = method;

      const packet = new EdgeHubPacket({
        type: PacketType.PACKET_TYPE_RPC_RESPONSE,
        rpc_response: response,
      });
      this.sendPacket(packet);
    }
  }

  /**
   * Send heartbeat
   */
  ping(): void {
    const seq = ++this.heartbeatSeq;
    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_HEARTBEAT,
      heartbeat: new Heartbeat({
        edge_id: 0,
        sequence: seq,
      }),
    });
    this.sendPacket(packet);
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: Buffer): void {
    try {
      const packet = EdgeHubPacket.deserializeBinary(new Uint8Array(data));

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
          console.warn(`Unknown packet type: ${packet.type}`);
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleRPCRequest(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_rpc_request || !packet.rpc_request) {
      console.warn('Received RPC_REQUEST packet without rpc_request field');
      return;
    }

    const request = packet.rpc_request;
    const requestId = request.request_id;
    const method = request.method;

    // Emit request event with the typed request object
    this.emit('request', request, (response: hubedgeRpc.TypedRPCResponse, error?: { code: number; message: string; data?: string }) => {
      this.respond(requestId, method, response, error);
    });
  }

  private handleRPCResponse(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_rpc_response || !packet.rpc_response) {
      console.warn('Received RPC_RESPONSE packet without rpc_response field');
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

  private handleRPCError(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_rpc_error || !packet.rpc_error) {
      console.warn('Received RPC_ERROR packet without rpc_error field');
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

  private handleRPCNotification(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_rpc_notification || !packet.rpc_notification) {
      console.warn('Received RPC_NOTIFICATION packet without rpc_notification field');
      return;
    }

    // Emit notification event with the typed notification object
    this.emit('notification', packet.rpc_notification);
  }

  private handleHeartbeat(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_heartbeat || !packet.heartbeat) {
      return;
    }

    const { edge_id: edgeId, sequence } = packet.heartbeat;
    
    const ackPacket = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_HEARTBEAT_ACK,
      heartbeat_ack: new HeartbeatAck({
        edge_id: edgeId,
        sequence,
        hub_timestamp: Date.now(),
      }),
    });
    this.sendPacket(ackPacket);
    
    this.emit('ping', Date.now());
  }

  private handleHeartbeatAck(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_heartbeat_ack || !packet.heartbeat_ack) {
      return;
    }

    const { hub_timestamp: hubTimestamp } = packet.heartbeat_ack;
    const latency = Date.now() - Number(hubTimestamp);
    this.emit('pong', latency);
  }

  private handleClientRelay(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_relay || !packet.relay) {
      return;
    }
    this.emit('relay', packet.relay);
  }

  private handleSync(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_sync_data || !packet.sync_data) {
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

  private sendPacket(packet: hubedge.EdgeHubPacket): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(packet.serializeBinary());
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