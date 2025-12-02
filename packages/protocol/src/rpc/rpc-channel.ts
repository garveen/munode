import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { hubedge } from '../generated/proto/HubEdge.js';

const { EdgeHubPacket, PacketType, RPCRequest, RPCResponse, RPCError: ProtoRPCError, Heartbeat, HeartbeatAck } = hubedge;

/**
 * Custom JSON replacer that handles Buffer serialization
 * Buffers are converted to { __buffer__: true, data: <base64> }
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { __buffer__: true, data: value.toString('base64') };
  }
  if (value instanceof Uint8Array) {
    return { __buffer__: true, data: Buffer.from(value).toString('base64') };
  }
  return value;
}

/**
 * Custom JSON reviver that handles Buffer deserialization
 */
function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && 
      '__buffer__' in value && (value as { __buffer__: boolean; data: string }).__buffer__ === true &&
      'data' in value && typeof (value as { data: string }).data === 'string') {
    return Buffer.from((value as { data: string }).data, 'base64');
  }
  // Also handle the standard { type: 'Buffer', data: [...] } format from JSON.stringify(Buffer)
  if (value && typeof value === 'object' &&
      'type' in value && (value as { type: string }).type === 'Buffer' &&
      'data' in value && Array.isArray((value as { data: number[] }).data)) {
    return Buffer.from((value as { data: number[] }).data);
  }
  return value;
}

/**
 * Serialize params to JSON with Buffer support
 */
function serializeParams(params: unknown): string {
  return JSON.stringify(params ?? {}, jsonReplacer);
}

/**
 * Parse JSON with Buffer support
 */
function parseParams(json: string): unknown {
  return JSON.parse(json, jsonReviver);
}

export interface Message {
  id?: string;           // 请求ID（响应时必填，通知时可选）
  type: string;          // 消息类型
  method?: string;       // RPC 方法名（请求时必填）
  params?: unknown;      // 参数
  result?: unknown;      // 结果（响应时使用）
  error?: {              // 错误（响应时使用）
    code: number;
    message: string;
    data?: unknown;
  };
  timestamp: number;     // 时间戳
}

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * RPCChannel - Protobuf-based RPC communication channel
 * 
 * Uses protobuf EdgeHubPacket format for all communication.
 * Maintains API compatibility with the old MsgPack-based implementation.
 */
export class RPCChannel extends EventEmitter {
  private ws: WebSocket;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestTimeout = 30000; // 30秒
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
   * 发送 RPC 请求
   */
  async call(method: string, params?: unknown, timeout?: number): Promise<unknown> {
    const id = this.generateId();
    const effectiveTimeout = timeout || this.requestTimeout;

    // Create protobuf RPC request packet
    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: new RPCRequest({
        request_id: id,
        method,
        params: Buffer.from(serializeParams(params)),
        timeout_ms: effectiveTimeout,
      }),
    });

    return new Promise((resolve, reject) => {
      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, effectiveTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendPacket(packet);
    });
  }

  /**
   * 发送通知（无需响应）
   * Note: Notifications are implemented as RPC requests without waiting for response
   */
  notify(method: string, params?: unknown): void {
    const id = this.generateId();
    
    // Create protobuf RPC request packet (used for notification)
    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: new RPCRequest({
        request_id: id,
        method,
        params: Buffer.from(serializeParams(params)),
        timeout_ms: 0, // 0 indicates notification (no response expected)
      }),
    });

    this.sendPacket(packet);
  }

  /**
   * 发送响应
   */
  respond(id: string, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    if (error) {
      // Send error response
      const errorData: {
        request_id: string;
        code: number;
        message: string;
        details?: Uint8Array;
      } = {
        request_id: id,
        code: error.code,
        message: error.message,
      };
      
      if (error.data !== undefined) {
        errorData.details = Buffer.from(serializeParams(error.data));
      }
      
      const packet = new EdgeHubPacket({
        type: PacketType.PACKET_TYPE_RPC_ERROR,
        rpc_error: new ProtoRPCError(errorData),
      });
      this.sendPacket(packet);
    } else {
      // Send success response
      const packet = new EdgeHubPacket({
        type: PacketType.PACKET_TYPE_RPC_RESPONSE,
        rpc_response: new RPCResponse({
          request_id: id,
          result: Buffer.from(serializeParams(result)),
        }),
      });
      this.sendPacket(packet);
    }
  }

  /**
   * 发送心跳
   */
  ping(): void {
    const seq = ++this.heartbeatSeq;
    const packet = new EdgeHubPacket({
      type: PacketType.PACKET_TYPE_HEARTBEAT,
      heartbeat: new Heartbeat({
        edge_id: 0, // Will be set by the actual Edge
        sequence: seq,
      }),
    });
    this.sendPacket(packet);
  }

  /**
   * 处理接收到的消息
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

    const { request_id: requestId, method, params: paramsBuffer, timeout_ms: timeoutMs } = packet.rpc_request;
    
    // Parse params with Buffer support
    let params: unknown;
    try {
      params = parseParams(Buffer.from(paramsBuffer).toString());
    } catch {
      params = {};
    }

    // Convert to Message format for backward compatibility
    const message: Message = {
      id: requestId,
      type: timeoutMs === 0 ? 'notification' : 'request',
      method,
      params,
      timestamp: Date.now(),
    };

    if (timeoutMs === 0) {
      // This is a notification, no response expected
      this.emit('notification', message);
    } else {
      // This is a request, expect response
      this.emit('request', message, (result?: unknown, error?: { code: number; message: string; data?: unknown }) => {
        this.respond(requestId, result, error);
      });
    }
  }

  private handleRPCResponse(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_rpc_response || !packet.rpc_response) {
      console.warn('Received RPC_RESPONSE packet without rpc_response field');
      return;
    }

    const { request_id: requestId, result: resultBuffer } = packet.rpc_response;
    const pending = this.pendingRequests.get(requestId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);

      // Parse result with Buffer support
      let result: unknown;
      try {
        result = parseParams(Buffer.from(resultBuffer).toString());
      } catch {
        result = {};
      }

      pending.resolve(result);
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

  private handleHeartbeat(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_heartbeat || !packet.heartbeat) {
      return;
    }

    const { edge_id: edgeId, sequence } = packet.heartbeat;
    
    // Send heartbeat ack
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

    // Emit relay event for handling by upper layers
    this.emit('relay', packet.relay);
  }

  private handleSync(packet: hubedge.EdgeHubPacket): void {
    if (!packet.has_sync_data || !packet.sync_data) {
      return;
    }

    // Emit sync event for handling by upper layers
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
    // 清理所有待处理的请求
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.cleanup();
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  /**
   * 检查连接是否打开
   */
  isConnected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}