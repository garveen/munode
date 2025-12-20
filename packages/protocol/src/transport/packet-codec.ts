/**
 * Packet Codec - EdgeHubPacket 的编解码器
 * 
 * 负责 EdgeHubPacket 的序列化和反序列化
 */

import { EdgeHubPacket, PacketType, RPCError, Heartbeat, HeartbeatAck, ServerStats, ConfigUpdate, ClientMessageRelay } from '../generated/proto/HubEdge.js';
import { SyncData } from '../generated/proto/HubEdgeSync.js';
import { TypedRPCRequest, TypedRPCResponse, TypedRPCNotification } from '../generated/proto/HubEdgeRPC.js';

export class PacketCodec {
  /**
   * 将 EdgeHubPacket 编码为二进制数据
   */
  static encode(packet: EdgeHubPacket): Uint8Array {
    return EdgeHubPacket.encode(packet).finish();
  }

  /**
   * 从二进制数据解码 EdgeHubPacket
   */
  static decode(data: Uint8Array): EdgeHubPacket {
    return EdgeHubPacket.decode(data);
  }

  /**
   * 创建一个新的 EdgeHubPacket
   */
  static createPacket(
    type: PacketType,
    payload: {
      rpcRequest?: TypedRPCRequest;
      rpcResponse?: TypedRPCResponse;
      rpcError?: RPCError;
      rpcNotification?: TypedRPCNotification;
      relay?: ClientMessageRelay;
      syncData?: SyncData;
      heartbeat?: Heartbeat;
      heartbeatAck?: HeartbeatAck;
    }
  ): EdgeHubPacket {
    return {
      type,
      rpc_request: payload.rpcRequest,
      rpc_response: payload.rpcResponse,
      rpc_error: payload.rpcError,
      rpc_notification: payload.rpcNotification,
      relay: payload.relay,
      sync_data: payload.syncData,
      heartbeat: payload.heartbeat,
      heartbeat_ack: payload.heartbeatAck,
    };
  }

  /**
   * 创建 RPC 请求包
   */
  static createRPCRequest(
    request: TypedRPCRequest
  ): EdgeHubPacket {
    return {
      type: PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: request,
    };
  }

  /**
   * 创建 RPC 响应包
   */
  static createRPCResponse(
    response: TypedRPCResponse
  ): EdgeHubPacket {
    return {
      type: PacketType.PACKET_TYPE_RPC_RESPONSE,
      rpc_response: response,
    };
  }

  /**
   * 创建 RPC 错误包
   */
  static createRPCError(
    requestId: string,
    code: number,
    message: string,
    details?: string
  ): EdgeHubPacket {
    const error: RPCError = {
      request_id: requestId,
      code,
      message,
      details,
    };

    return {
      type: PacketType.PACKET_TYPE_RPC_ERROR,
      rpc_error: error,
    };
  }

  /**
   * 创建 RPC 通知包
   */
  static createRPCNotification(
    notification: TypedRPCNotification
  ): EdgeHubPacket {
    return {
      type: PacketType.PACKET_TYPE_RPC_NOTIFICATION,
      rpc_notification: notification,
    };
  }

  /**
   * 创建心跳包
   */
  static createHeartbeat(
    edgeId: number,
    heartbeatSeq: number,
    stats?: ServerStats
  ): EdgeHubPacket {
    const heartbeat: Heartbeat = {
      edge_id: edgeId,
      sequence: heartbeatSeq,
      stats,
    };

    return {
      type: PacketType.PACKET_TYPE_HEARTBEAT,
      heartbeat,
    };
  }

  /**
   * 创建心跳确认包
   */
  static createHeartbeatAck(
    edgeId: number,
    heartbeatSeq: number,
    configUpdate?: ConfigUpdate
  ): EdgeHubPacket {
    const ack: HeartbeatAck = {
      edge_id: edgeId,
      sequence: heartbeatSeq,
      hub_timestamp: Date.now(),
      config_update: configUpdate,
    };

    return {
      type: PacketType.PACKET_TYPE_HEARTBEAT_ACK,
      heartbeat_ack: ack,
    };
  }
}
