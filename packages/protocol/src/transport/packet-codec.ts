/**
 * Packet Codec - EdgeHubPacket 的编解码器
 * 
 * 负责 EdgeHubPacket 的序列化和反序列化
 */

import { hubedge } from '../generated/proto/HubEdge';

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
      rpcRequest?: hubedge.RPCRequest;
      rpcResponse?: hubedge.RPCResponse;
      rpcError?: hubedge.RPCError;
      relay?: hubedge.ClientMessageRelay;
      syncData?: any;
      heartbeat?: hubedge.Heartbeat;
      heartbeatAck?: hubedge.HeartbeatAck;
    }
  ): hubedge.EdgeHubPacket {
    return new hubedge.EdgeHubPacket({
      type,
      ...payload,
    });
  }

  /**
   * 创建 RPC 请求包
   */
  static createRPCRequest(
    requestId: string,
    method: string,
    params: Uint8Array,
    timeoutMs?: number
  ): hubedge.EdgeHubPacket {
    const request = new hubedge.RPCRequest({
      request_id: requestId,
      method,
      params,
      timeout_ms: timeoutMs,
    });

    return new hubedge.EdgeHubPacket({
      type: hubedge.PacketType.PACKET_TYPE_RPC_REQUEST,
      rpc_request: request,
    });
  }

  /**
   * 创建 RPC 响应包
   */
  static createRPCResponse(
    requestId: string,
    result: Uint8Array,
    processingTimeMs?: number
  ): hubedge.EdgeHubPacket {
    const response = new hubedge.RPCResponse({
      request_id: requestId,
      result,
      processing_time_ms: processingTimeMs,
    });

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
    details?: Uint8Array
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
