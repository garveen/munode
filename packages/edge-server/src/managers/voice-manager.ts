import type { Logger } from 'winston';
import { VoiceUDPTransport, type VoicePacketHeader as ProtocolVoicePacketHeader } from '@munode/protocol';
import { HandlerFactory } from '../core/handler-factory.js';
import { EdgeConfig, RouteType, RouteEntry, EdgeConnectionQuality, VoiceBroadcast } from '../types.js';
import { VoiceRoutingManager } from '../voice/voice-routing-manager.js';
import type { RemoteInfo } from 'dgram';

// 使用 protocol 包中的 VoicePacketHeader 类型
type VoicePacketHeader = ProtocolVoicePacketHeader;

/**
 * TCP 降级状态跟踪
 */
interface TcpFallbackState {
  edgeId: number;
  activeSince: number;
  packetsSent: number;
  lastCheck: number;
}

/**
 * 语音管理器
 * 负责处理语音数据路由、UDP传输和相关逻辑
 */
export class VoiceManager {
  private config: EdgeConfig;
  private handlerFactory: HandlerFactory;
  private voiceTransport?: VoiceUDPTransport;
  private voiceRoutingManager: VoiceRoutingManager;
  private logger: Logger;
  
  // TCP 降级状态跟踪
  private tcpFallbackStates: Map<number, TcpFallbackState> = new Map();
  private tcpRecoveryTimer?: NodeJS.Timeout;

  constructor(config: EdgeConfig, handlerFactory: HandlerFactory, voiceTransport?: VoiceUDPTransport) {
    this.config = config;
    this.handlerFactory = handlerFactory;
    this.voiceTransport = voiceTransport;
    this.logger = handlerFactory.logger;
    
    // 初始化语音路由管理器
    this.voiceRoutingManager = new VoiceRoutingManager(config, this.logger);
    this.setupRoutingManagerEvents();
    
    // 启动 TCP 恢复检查
    this.startTcpRecoveryCheck();
  }

  /**
   * 设置语音路由管理器事件处理
   */
  private setupRoutingManagerEvents(): void {
    // 监听路由变更事件
    this.voiceRoutingManager.on('route-changed', (targetEdgeId: number, newRoute: RouteEntry, oldRoute: RouteEntry | null) => {
        this.logger.info(`Voice route changed for Edge ${targetEdgeId}: ${oldRoute?.type || 'none'} -> ${newRoute.type}`);
      
      // 如果从 FALLBACK 切换回 UDP 模式，清除降级状态
      if (oldRoute?.type === RouteType.FALLBACK && newRoute.type !== RouteType.FALLBACK) {
        this.clearTcpFallbackState(targetEdgeId);
      }
    });

    // 监听质量降级事件
    this.voiceRoutingManager.on('quality-degraded', (edgeId: number, quality: EdgeConnectionQuality) => {
        this.logger.warn(`Voice quality degraded for Edge ${edgeId}: RTT=${quality.rtt}ms, loss=${(quality.packetLoss * 100).toFixed(1)}%`);
    });

    // 监听质量更新事件，报告给Hub
    this.voiceRoutingManager.on('quality-updated', async (edgeId: number, quality: EdgeConnectionQuality) => {
      try {
        await this.handlerFactory.hubClient.reportQuality(edgeId, {
          rtt: quality.rtt,
          packetLoss: quality.packetLoss,
          jitter: quality.jitter,
          samples: quality.samples,
        });
        this.logger.debug(`Reported connection quality to Edge ${edgeId} to Hub`);
      } catch (error) {
        this.logger.error(`Failed to report quality to Edge ${edgeId}:`, error);
      }
    });
  }

  /**
   * 获取语音路由管理器
   */
  getVoiceRoutingManager(): VoiceRoutingManager {
    return this.voiceRoutingManager;
  }

  /**
   * 启动语音路由管理器
   */
  async startRoutingManager(): Promise<void> {
    await this.voiceRoutingManager.start();
  }

  /**
   * 停止语音路由管理器
   */
  async stopRoutingManager(): Promise<void> {
    await this.voiceRoutingManager.stop();
    
    // 停止 TCP 恢复检查
    if (this.tcpRecoveryTimer) {
      clearInterval(this.tcpRecoveryTimer);
      this.tcpRecoveryTimer = undefined;
    }
  }
  
  /**
   * 启动 TCP 恢复检查
   * 定期检查是否可以从 TCP 降级恢复到 UDP
   */
  private startTcpRecoveryCheck(): void {
    const checkInterval = this.config.voiceRouting?.fallback?.udpRecoveryCheckInterval ?? 30000;
    
    this.tcpRecoveryTimer = setInterval(() => {
      this.checkTcpRecovery();
    }, checkInterval);
  }
  
  /**
   * 检查 TCP 降级状态，尝试恢复 UDP
   */
  private checkTcpRecovery(): void {
    for (const [edgeId, state] of this.tcpFallbackStates) {
      const now = Date.now();
      const fallbackDuration = now - state.activeSince;
      
      // 如果降级超过一定时间，尝试恢复 UDP
      if (fallbackDuration > 60000) { // 1 分钟后尝试恢复
        this.logger.info(`Attempting to recover UDP for Edge ${edgeId} after ${fallbackDuration}ms of TCP fallback`);
        
        // 通过质量重置触发重新评估路由
        this.voiceRoutingManager.emit('quality-updated', edgeId, {
          rtt: 0,
          packetLoss: 0,
          jitter: 0,
          lastUpdate: now,
          samples: 0,
        });
      }
    }
  }
  
  /**
   * 设置 TCP 降级状态
   */
  private setTcpFallbackState(edgeId: number): void {
    if (!this.tcpFallbackStates.has(edgeId)) {
      this.tcpFallbackStates.set(edgeId, {
        edgeId,
        activeSince: Date.now(),
        packetsSent: 0,
        lastCheck: Date.now(),
      });
        this.logger.info(`TCP fallback activated for Edge ${edgeId}`);
    }
  }
  
  /**
   * 清除 TCP 降级状态
   */
  private clearTcpFallbackState(edgeId: number): void {
    if (this.tcpFallbackStates.has(edgeId)) {
      const state = this.tcpFallbackStates.get(edgeId);
      const duration = Date.now() - state.activeSince;
        this.logger.info(`TCP fallback deactivated for Edge ${edgeId} after ${duration}ms, ${state.packetsSent} packets sent`);
      this.tcpFallbackStates.delete(edgeId);
    }
  }

  /**
   * 获取语音传输实例
   */
  getVoiceTransport(): VoiceUDPTransport | undefined {
    return this.voiceTransport;
  }
  
  /**
   * 更新语音UDP传输的加密密钥
   */
  updateEncryptionKey(algorithm: string, keyBase64: string, version: number): void {
    if (!this.voiceTransport) {
      this.logger.warn('Voice transport not available, cannot update encryption key');
      return;
    }
    
    try {
      const key = Buffer.from(keyBase64, 'base64');
      this.voiceTransport.updateEncryptionKey(key, algorithm);
      this.logger.info(`Updated voice encryption key (version ${version}, algorithm: ${algorithm})`);
    } catch (error) {
      this.logger.error('Failed to update voice encryption key:', error);
    }
  }

  /**
   * 处理来自Hub的语音数据路由
   */
  handleVoiceDataFromHub(
    data: { packetData: Buffer; targetEdgeId: number },
    respond: (result?: { success: boolean }, error?: { code: number; message: string }) => void
  ): void {
    try {
      // TODO: 实现VoiceRouter.handleVoiceDataFromHub方法
      // 处理来自Hub的语音数据，路由到本地客户端
      // this.handlerFactory.voiceRouter.handleVoiceDataFromHub(data);
        this.logger.debug('Received voice data from Hub:', data);
      respond({ success: true });
    } catch (error) {
        this.logger.error('Error handling voice data from Hub:', error);
      respond(undefined, { code: -32603, message: 'Internal error' });
    }
  }

  /**
   * 设置语音UDP传输处理器
   * 监听VoiceRouter的广播事件，通过UDP转发到其他Edge
   */
  setupVoiceTransportHandlers(): void {
    if (!this.voiceTransport) {
        this.logger.debug('Voice transport not available, skipping setup');
      return;
    }

        this.logger.debug(`Setting up voice transport handlers for server ${this.config.server_id}`);

    // 监听VoiceRouter的统一广播事件
    this.handlerFactory.voiceRouter.on('broadcastVoicePacket', (broadcast: VoiceBroadcast) => {
        this.logger.debug(`Received broadcastVoicePacket event: sender=${broadcast.sender_id}, target=${broadcast.target}`);

      // 从 Mumble 语音包中提取 codec
      const header = broadcast.packet.readUInt8(0);
      const codec = (header >> 5) & 0x07;
      const target = header & 0x1f;

      // 构造完整的 VoicePacketHeader
      const voicePacket: VoicePacketHeader = {
        version: 1,
        senderId: broadcast.sender_id,
        targetId: target,
        sequence: 0, // TODO: 实现序列号跟踪
        codec: codec,
      };

      // 获取所有已注册的Edge端点（从VoiceUDPTransport获取，而不是从StateManager获取）
      // 这确保即使Edge还没有用户，只要voice endpoint已注册，就会收到语音包
      const allEdges = this.voiceTransport?.getRegisteredEdgeIds() || [];
      
      // 广播到所有其他Edge，使用路由决策
      let sentCount = 0;
      for (const edgeId of allEdges) {
        // 跳过本地Edge（本地用户已经在routeVoicePacket中处理了）
        if (edgeId !== this.config.server_id) {
          this.sendVoiceToEdge(edgeId, voicePacket, broadcast.packet);
          sentCount++;
        } else {
        this.logger.debug(`Skipping local edge ${edgeId}`);
        }
      }

        this.logger.debug(
        `Broadcasted voice to ${sentCount} edges: ` +
        `sender=${broadcast.sender_id}, target=${target}, codec=${codec}, packet_size=${broadcast.packet.length}`
      );
    });

    // 监听接收到的UDP语音包（来自其他Edge）
    this.voiceTransport.on('voice-packet', (packet, _rinfo: RemoteInfo) => {
      // packet 是 VoicePacket 类型
        this.logger.debug(
        `[VOICE-REMOTE] Received voice packet: ` +
        `sender_edge=${packet.senderId}, target=${packet.targetId}, ` +
        `codec=${packet.codec}, data_size=${packet.data.length}`
      );

      // 记录收到的包用于网络质量统计（被动探测）
      if (this.voiceRoutingManager.isEnabled()) {
        this.voiceRoutingManager.recordReceivedPacket(
          packet.senderId,
          packet.sequence || 0,
          Date.now() // 使用当前时间戳
        );
      }

      // packet.data 是完整的Mumble语音包（header+session+sequence+voice_data）
      // targetId 是 Mumble 原始 target 值：0=PTT, 1-30=whisper, 31=loopback
      
      // 忽略loopback包（远程用户的loopback不应该到达这里）
      if (packet.targetId === 31) {
        this.logger.debug(`[VOICE-REMOTE] Ignoring remote loopback packet`);
        return;
      }

      // 统一处理所有远程语音包
      this.handleRemoteVoicePacket(packet.data, packet.targetId);
    });

    this.voiceTransport.on('error', (error: Error) => {
        this.logger.error('Voice UDP transport error:', error);
    });
    
    // 监听Edge连接事件
    this.voiceTransport.on('edge-connected', (edgeId: number) => {
      this.logger.info(`UDP connection established with Edge ${edgeId}`);
    });
    
    // 监听Edge连接失败事件
    this.voiceTransport.on('handshake-failed', async (edgeId: number) => {
      this.logger.warn(`UDP handshake failed with Edge ${edgeId}`);
      
      // 通知Hub连接失败
      try {
        await this.handlerFactory.hubClient.notifyConnectionFailure(edgeId);
        this.logger.debug(`Notified Hub about connection failure with Edge ${edgeId}`);
      } catch (error) {
        this.logger.error(`Failed to notify Hub about connection failure:`, error);
      }
    });
    
    // 监听Edge断开连接事件
    this.voiceTransport.on('edge-disconnected', (edgeId: number) => {
      this.logger.warn(`Edge ${edgeId} disconnected (heartbeat timeout)`);
    });
    
    // 监听重连失败事件（双向都失败时需要Hub决定）
    this.voiceTransport.on('reconnect-failed', async (edgeId: number) => {
      this.logger.error(`Reconnect failed with Edge ${edgeId}, notifying Hub for arbitration`);
      
      try {
        await this.handlerFactory.hubClient.notifyReconnectFailure(edgeId);
        this.logger.debug(`Notified Hub about reconnect failure with Edge ${edgeId}`);
      } catch (error) {
        this.logger.error(`Failed to notify Hub about reconnect failure:`, error);
      }
    });

        this.logger.debug('Voice transport handlers setup complete');
  }

  /**
   * 处理来自其他Edge的语音包
   */
  private handleRemoteVoicePacket(voiceData: Buffer, targetId: number): void {
    try {
        this.logger.debug(`[VOICE-REMOTE] Processing remote voice packet, target=${targetId}, size=${voiceData.length}`);
      
      // 解析发送者session
      const senderSession = this.parseSessionFromVoicePacket(voiceData);
      if (senderSession === null) {
        this.logger.warn('[VOICE-REMOTE] Failed to parse session from remote voice packet');
        return;
      }

      // 检查 session 是否有效（必须 > 0）
      if (senderSession === 0) {
        this.logger.warn(`[VOICE-REMOTE] Invalid sender session 0 in remote voice packet`);
        return;
      }

      // 解析codec（从Mumble包头）
      const header = voiceData.readUInt8(0);
      const codec = (header >> 5) & 0x07;

      // 对于PTT需要发送者频道信息来计算链接频道
      let senderChannelId = 0;
      
      if (targetId === 0) {
        const remoteUser = this.handlerFactory.stateManager.getRemoteUserInfo(senderSession);
        if (!remoteUser) {
        this.logger.warn(
            `[VOICE-REMOTE] PTT packet from unknown remote user ${senderSession}, ` +
            `cannot determine sender channel`
          );
          return;
        }
        senderChannelId = remoteUser.channel_id;
      }

        this.logger.debug(
        `[VOICE-REMOTE] Routing remote voice: ` +
        `session=${senderSession}, target=${targetId}, channel=${senderChannelId}, codec=${codec}`
      );

      // 构造VoicePacket对象
      const voicePacket = {
        sender_session: senderSession,
        target: targetId,
        sequence: 0,
        codec,
        data: Buffer.alloc(0), // 不需要，因为我们传递了serializedData
        timestamp: Date.now(),
      };

      // 让VoiceRouter使用统一的路由逻辑处理
      // 传递voiceData作为已序列化的数据，避免重复序列化
      this.handlerFactory.voiceRouter.routeRemoteVoicePacket(
        voicePacket,
        senderChannelId,
        voiceData
      );
    } catch (error) {
        this.logger.error('[VOICE-REMOTE] Error handling remote voice packet:', error);
    }
  }

  /**
   * 从语音包中解析session ID
   */
  private parseSessionFromVoicePacket(data: Buffer): number | null {
    if (data.length < 2) {
      return null;
    }

    // 跳过header（1字节）
    let offset = 1;

    // 解析varint格式的session ID
    const v = data.readUInt8(offset);

    if ((v & 0x80) === 0x00) {
      // 单字节
      return v & 0x7f;
    } else if ((v & 0xc0) === 0x80) {
      // 双字节
      if (offset + 1 >= data.length) return null;
      return ((v & 0x3f) << 8) | data.readUInt8(offset + 1);
    } else if ((v & 0xf0) === 0xf0) {
      // 完整32位整数
      if (offset + 4 >= data.length) return null;
      return (
        (data.readUInt8(offset + 1) << 24) |
        (data.readUInt8(offset + 2) << 16) |
        (data.readUInt8(offset + 3) << 8) |
        data.readUInt8(offset + 4)
      ) >>> 0;
    } else if ((v & 0xe0) === 0xc0) {
      // 3字节
      if (offset + 2 >= data.length) return null;
      return ((v & 0x1f) << 16) | (data.readUInt8(offset + 1) << 8) | data.readUInt8(offset + 2);
    }

    return null;
  }

  /**
   * 发送语音包到目标 Edge，使用路由决策
   * 
   * 路由类型：
   * - DIRECT: 直接发送到目标 Edge
   * - RELAY: 通过中转 Edge 发送
   * - FALLBACK: 通过 TCP/WebSocket 降级发送
   */
  private sendVoiceToEdge(targetEdgeId: number, voicePacket: VoicePacketHeader, packetData: Buffer): void {
    if (!this.voiceTransport) {
        this.logger.warn(`Cannot send voice to Edge ${targetEdgeId}: no voice transport`);
      return;
    }

    try {
      // 如果语音路由功能启用，使用路由决策
      if (this.voiceRoutingManager.isEnabled()) {
        const route = this.voiceRoutingManager.getRoute(targetEdgeId);
        
        if (route) {
          switch (route.type) {
            case RouteType.DIRECT:
              // 直连模式
        this.logger.debug(`Sending voice to Edge ${targetEdgeId} via direct route`);
              this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, packetData);
              break;
              
            case RouteType.RELAY:
              // 中转模式：发送到中转 Edge
              if (route.nextHop) {
        this.logger.debug(`Sending voice to Edge ${targetEdgeId} via relay Edge ${route.nextHop}`);
                // TODO: 实现中转包装协议，传递 finalTarget 信息
                // 暂时直接转发，假设中转节点会根据内容自行路由
                this.voiceTransport.sendToEdge(route.nextHop, voicePacket, packetData);
                // 记录中转，传递目标节点 ID 用于调试
                this.voiceRoutingManager.recordRelayedPacket(packetData.length, targetEdgeId);
              } else {
                // 没有中转节点，降级到直连
        this.logger.warn(`No relay hop for Edge ${targetEdgeId}, falling back to direct`);
                this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, packetData);
              }
              break;
              
            case RouteType.FALLBACK:
              // TCP 降级模式：通过 Hub 控制通道转发
              this.sendVoiceViaTcpFallback(targetEdgeId, voicePacket, packetData);
              break;
              
            default:
              // 未知路由类型，使用直连
              this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, packetData);
          }
        } else {
          // 没有路由信息，使用直连
        this.logger.debug(`No route for Edge ${targetEdgeId}, using direct`);
          this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, packetData);
        }
      } else {
        // 路由功能未启用，直接发送
        this.logger.debug(`Sending voice to edge ${targetEdgeId}`);
        this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, packetData);
      }
    } catch (error) {
        this.logger.error(`Failed to send voice to edge ${targetEdgeId}:`, error);
    }
  }

  /**
   * 处理中转语音包（作为中转节点时）
   */
  handleRelayVoicePacket(
    packet: VoicePacketHeader,
    voiceData: Buffer,
    finalTargetEdgeId: number
  ): void {
    if (!this.voiceTransport) {
        this.logger.warn('Cannot relay voice: no voice transport');
      return;
    }

    try {
      // 检查是否可以接受中转请求
      if (!this.voiceRoutingManager.canAcceptRelay()) {
        this.logger.warn(`Relay capacity exceeded, dropping packet for Edge ${finalTargetEdgeId}`);
        return;
      }

      // 转发到最终目标（保持原始包头信息）
      this.voiceTransport.sendToEdge(finalTargetEdgeId, packet, voiceData);
      // 记录中转，传递目标 Edge ID 用于调试
      this.voiceRoutingManager.recordRelayedPacket(voiceData.length, finalTargetEdgeId);
      
        this.logger.debug(`Relayed voice packet to Edge ${finalTargetEdgeId}`);
    } catch (error) {
        this.logger.error(`Failed to relay voice to Edge ${finalTargetEdgeId}:`, error);
    }
  }

  /**
   * 通过 TCP 降级发送语音包
   * 使用 Hub 控制通道作为备用传输路径
   */
  private sendVoiceViaTcpFallback(
    targetEdgeId: number,
    voicePacket: VoicePacketHeader,
    packetData: Buffer
  ): void {
    try {
      // 设置 TCP 降级状态
      this.setTcpFallbackState(targetEdgeId);
      
      // 更新统计
      const state = this.tcpFallbackStates.get(targetEdgeId);
      if (state) {
        state.packetsSent++;
      }
      
      // 通过 Hub 控制通道发送语音数据
      const hubClient = this.handlerFactory.hubClient;
      if (!hubClient || !hubClient.isConnected()) {
        this.logger.warn(`Cannot use TCP fallback: Hub client not connected`);
        return;
      }
      
      // TCP 降级：将语音包通过控制通道转发
      // 注意：这会增加延迟，但在 UDP 完全不可用时提供保底传输
      // TODO: 实现专用的 Hub TCP 中转接口
      // 目前仅记录日志，不实际发送
      // 完整实现需要：
      // 1. Hub 侧添加 edge.tcpRelayVoice RPC 处理
      // 2. Hub 将语音数据转发给目标 Edge
      // 3. 目标 Edge 解包并路由给本地客户端
      
        this.logger.debug(`TCP fallback packet queued for Edge ${targetEdgeId}, size=${packetData.length}`);
      
      // 临时实现：直接尝试 UDP 发送（即使可能失败）
      // 这样至少不会完全丢失语音
      if (this.voiceTransport) {
        try {
          this.voiceTransport.sendToEdge(targetEdgeId, voicePacket, packetData);
        } catch (_e) {
          // 忽略 UDP 发送失败
        }
      }
    } catch (error) {
        this.logger.error(`Error in TCP fallback for Edge ${targetEdgeId}:`, error);
    }
  }
}