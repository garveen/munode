/**
 * Packet Codec - EdgeHubPacket 的编解码器
 * 
 * 负责 EdgeHubPacket 的序列化和反序列化
 */

import { hubedge } from '../generated/proto/HubEdge.js';
import { hubedge as hubedgeRpc } from '../generated/proto/HubEdgeRPC.js';

export class PacketCodec {
  /**
   * 将 EdgeHubPacket 编码为二进制数据
   */
  static encode(packet: hubedge.EdgeHubPacket): Uint8Array {
    return packet.serializeBinary();
  }

  /**
   * 从二进制数据解码 EdgeHubPacket
   */
  static decode(data: Uint8Array): hubedge.EdgeHubPacket {
    return hubedge.EdgeHubPacket.deserializeBinary(data);
  }

  /**
   * 创建一个新的 EdgeHubPacket
   */
  static createPacket(
    type: hubedge.PacketType,
    payload: {
      rpcRequest?: hubedgeRpc.TypedRPCRequest;
      rpcResponse?: hubedgeRpc.TypedRPCResponse;
      rpcError?: hubedge.RPCError;
      rpcNotification?: hubedgeRpc.TypedRPCNotification;
      relay?: hubedge.ClientMessageRelay;
      syncData?: hubedge.SyncData;
      heartbeat?: hubedge.Heartbeat;
      heartbeatAck?: hubedge.HeartbeatAck;
    }
  ): hubedge.EdgeHubPacket {
    return new hubedge.EdgeHubPacket({
      type,
      rpc_request: payload.rpcRequest,
      rpc_response: payload.rpcResponse,
      rpc_error: payload.rpcError,
      rpc_notification: payload.rpcNotification,
      relay: payload.relay,
      sync_data: payload.syncData,
      heartbeat: payload.heartbeat,
      heartbeat_ack: payload.heartbeatAck,
    });
  }

  /**
   * 创建 RPC 请求包
   */
  static createRPCRequest(
    request: hubedgeRpc.TypedRPCRequest
  ): hubedge.EdgeHubPacket {
    return new hubedge.EdgeHubPacket({
      type: hubedge.PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: request,
    });
  }

  /**
   * 创建 RPC 响应包
   */
  static createRPCResponse(
    response: hubedgeRpc.TypedRPCResponse
  ): hubedge.EdgeHubPacket {
    return new hubedge.EdgeHubPacket({
      type: hubedge.PacketType.PACKET_TYPE_RPC_RESPONSE,
      rpc_response: response,
    });
  }

  /**
   * 创建 RPC 错误包
   */
  static createRPCError(
    requestId: string,
    code: number,
    message: string,
    details?: string
  ): hubedge.EdgeHubPacket {
    const error = new hubedge.RPCError({
      request_id: requestId,
      code,
      message,
      details,
    });

    return new hubedge.EdgeHubPacket({
      type: hubedge.PacketType.PACKET_TYPE_RPC_ERROR,
      rpc_error: error,
    });
  }

  /**
   * 创建 RPC 通知包
   */
  static createRPCNotification(
    notification: hubedgeRpc.TypedRPCNotification
  ): hubedge.EdgeHubPacket {
    return new hubedge.EdgeHubPacket({
      type: hubedge.PacketType.PACKET_TYPE_RPC_NOTIFICATION,
      rpc_notification: notification,
    });
  }

  /**
   * 创建心跳包
   */
  static createHeartbeat(
    edgeId: number,
    heartbeatSeq: number,
    stats?: hubedge.ServerStats
  ): hubedge.EdgeHubPacket {
    const heartbeat = new hubedge.Heartbeat({
      edge_id: edgeId,
      sequence: heartbeatSeq,
      stats,
    });

    return new hubedge.EdgeHubPacket({
      type: hubedge.PacketType.PACKET_TYPE_HEARTBEAT,
      heartbeat,
    });
  }

  /**
   * 创建心跳确认包
   */
  static createHeartbeatAck(
    edgeId: number,
    heartbeatSeq: number,
    configUpdate?: hubedge.ConfigUpdate
  ): hubedge.EdgeHubPacket {
    const ack = new hubedge.HeartbeatAck({
      edge_id: edgeId,
      sequence: heartbeatSeq,
      hub_timestamp: Date.now(),
      config_update: configUpdate,
    });

    return new hubedge.EdgeHubPacket({
      type: hubedge.PacketType.PACKET_TYPE_HEARTBEAT_ACK,
      heartbeat_ack: ack,
    });
  }
}
