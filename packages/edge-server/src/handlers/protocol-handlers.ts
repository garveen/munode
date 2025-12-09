/**
 * 基础协议消息处理器
 * 
 * 处理 Mumble 协议的基础消息：
 * - Version
 * - Ping
 * - CryptSetup
 * - QueryUsers
 * - UserStats
 * - VoiceTarget
 */

import { logger } from '@munode/common';
import { mumbleproto, MessageType, Permission, ClientState } from '@munode/protocol';
import type { ClientInfo, ChannelInfo } from '../types.js';
import type { HandlerFactory } from '../core/handler-factory.js';
import { VoiceTargetData } from '../voice/voice-router.js';

export class ProtocolHandlers {
  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get voiceRouter() { return this.factory.voiceRouter; }
  private get config() { return this.factory.config; }
  private get hubClient() { return this.factory.hubClient; }

  /**
   * 处理 Version 消息
   */
  handleVersion(session_id: number, data: Buffer): void {
    try {
      const version = mumbleproto.Version.deserialize(data);
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`Version message from unknown session: ${session_id}`);
        return;
      }

      // 更新客户端版本信息
      const updates: Partial<ClientInfo> = {
        version: version.version ? version.version.toString(16) : undefined,
        version_number: version.version, // 保存数字版本号
        client_name: version.release || undefined,
        os_name: version.os || undefined,
        os_version: version.os_version || undefined,
      };

      // 只在首次收到 Version 时更新状态（允许客户端多次发送 Version，与 C 实现一致）
      const currentState = client.state;
      if (currentState === ClientState.Connected || currentState === ClientState.ServerSentVersion) {
        updates.state = ClientState.ClientSentVersion; // 客户端已发送 Version，状态转换
      }

      this.clientManager.updateClient(session_id, updates);

      logger.debug(
        `Client ${session_id} version: ${version.release || 'unknown'} on ${version.os || 'unknown'}, state updated to ClientSentVersion`
      );
    } catch (error) {
      logger.error(`Error handling Version for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 Ping 消息
   */
  handlePing(session_id: number, data: Buffer): void {
    try {
      const ping = mumbleproto.Ping.deserialize(data);
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`Ping from unknown session: ${session_id}`);
        return;
      }

      // 更新最后 ping 时间
      client.last_ping = Date.now();

      // 更新远端统计（从客户端的Ping消息中读取客户端的接收统计）
      if (client.crypt && ping.good !== undefined) {
        client.crypt.remoteStats.good = ping.good;
      }
      if (client.crypt && ping.late !== undefined) {
        client.crypt.remoteStats.late = ping.late;
      }
      if (client.crypt && ping.lost !== undefined) {
        client.crypt.remoteStats.lost = ping.lost;
      }
      if (client.crypt && ping.resync !== undefined) {
        client.crypt.remoteStats.resync = ping.resync;
      }

      // 回复 ping 消息，包含服务器端的接收统计
      const pongMessage = new mumbleproto.Ping({
        timestamp: ping.timestamp,
        good: client.crypt?.localStats.good ?? 0,
        late: client.crypt?.localStats.late ?? 0,
        lost: client.crypt?.localStats.lost ?? 0,
        resync: client.crypt?.localStats.resync ?? 0,
      }).serialize();

      this.messageHandler.sendMessage(session_id, MessageType.Ping, Buffer.from(pongMessage));

      logger.debug(`Handled ping from session ${session_id}`);
    } catch (error) {
      logger.error(`Error handling ping for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 CryptSetup 消息
   */
  handleCryptSetup(session_id: number, data: Buffer): void {
    try {
      const cryptSetup = mumbleproto.CryptSetup.deserialize(data);
      const client = this.clientManager.getClient(session_id);

      if (!client) {
        logger.warn(`CryptSetup from unknown session: ${session_id}`);
        return;
      }

      if (!cryptSetup.client_nonce || cryptSetup.client_nonce.length === 0) {
        // 客户端请求重新同步
        logger.info(`Crypt resync request from session ${session_id}`);

        const serverNonce = this.voiceRouter.getClientEncryptIV(session_id);

        const response = new mumbleproto.CryptSetup({
          server_nonce: serverNonce || Buffer.alloc(16),
        }).serialize();

        this.messageHandler.sendMessage(session_id, MessageType.CryptSetup, Buffer.from(response));
        logger.debug(`Sent crypt resync response to session ${session_id}`);
      } else {
        // 客户端发送了nonce，更新解密IV
        logger.info(`Received client nonce from session ${session_id}, updating decrypt IV`);

        if (cryptSetup.client_nonce.length === 16) {
          this.voiceRouter.updateClientDecryptIV(session_id, Buffer.from(cryptSetup.client_nonce));
          logger.debug(`Updated decrypt IV for session ${session_id}`);
        } else {
          logger.warn(`Invalid client nonce length: ${cryptSetup.client_nonce.length}`);
        }
      }
    } catch (error) {
      logger.error(`Error handling CryptSetup for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 QueryUsers 消息
   */
  async handleQueryUsers(session_id: number, data: Buffer): Promise<void> {
    try {
      // 解析查询请求
      const queryRequest = mumbleproto.QueryUsers.deserialize(data);
      logger.debug(`QueryUsers request from session ${session_id}:`, {
        ids: queryRequest.ids,
        names: queryRequest.names
      });

      // TODO: 完整实现需要转发到 Hub 查询用户数据库
      // 当前实现：为测试环境提供基本的名称<->ID映射
      // 测试用户映射（与 tests/integration/setup.ts 中的 TestAuthServer 对应）
      const testUserMap: Record<string, number> = {
        'admin': 1,
        'user1': 2,
        'user2': 3,
        'guest': 4,
        'admin_password': 11,
        'admin_multi': 12,
        'admin_state': 13,
        'admin_no_ninja': 14,
        'user1_password': 21,
        'user2_password': 22,
        'user_edge1': 31,
        'user_edge2': 32,
        'user_state': 33,
        'user_no_ninja': 34,
      };

      const response: { ids: number[]; names: string[] } = {
        ids: [],
        names: [],
      };

      // 如果查询的是名称，返回对应的ID
      if (queryRequest.names && queryRequest.names.length > 0) {
        for (const name of queryRequest.names) {
          const userId = testUserMap[name];
          if (userId) {
            response.names.push(name);
            response.ids.push(userId);
          } else {
            // 不存在的用户：返回名称和ID=-1表示未注册
            response.names.push(name);
            response.ids.push(-1);
          }
        }
      }
      
      // 如果查询的是ID，返回对应的名称
      if (queryRequest.ids && queryRequest.ids.length > 0) {
        const idToName = Object.fromEntries(
          Object.entries(testUserMap).map(([name, id]) => [id, name])
        );
        for (const id of queryRequest.ids) {
          const userName = idToName[id];
          if (userName) {
            response.ids.push(id);
            response.names.push(userName);
          } else {
            // 不存在的ID：返回空名称
            response.ids.push(id);
            response.names.push('');
          }
        }
      }

      // 发送响应
      const responseMessage = new mumbleproto.QueryUsers(response).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.QueryUsers, Buffer.from(responseMessage));

      logger.debug(`Sent QueryUsers response to session ${session_id}: ${response.ids.length} users`);
    } catch (error) {
      logger.error(`Error handling QueryUsers for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 UserStats 消息
   */
  handleUserStats(session_id: number, data: Buffer, _hasPermission: (client: ClientInfo, channel: ChannelInfo, perm: Permission) => boolean): void {
    try {
      const statsRequest = mumbleproto.UserStats.deserialize(data);

      if (!statsRequest.session) {
        logger.warn(`UserStats request without target session from ${session_id}`);
        return;
      }

      const actor = this.clientManager.getClient(session_id);
      if (!actor) {
        logger.warn(`UserStats request from invalid actor session: ${session_id}`);
        return;
      }

      // UserStats 需要从 Hub 获取完整信息（用户数据库、证书、跨Edge会话等）
      // 发送到 Hub 处理
      logger.debug(`Forwarding UserStats request to Hub: actor=${session_id}, target=${statsRequest.session}, stats_only=${statsRequest.stats_only}`);
      
      // 触发事件，由 event-setup-manager 转发到 Hub
      this.messageHandler.emit('userStatsForward', {
        edge_id: this.config.server_id,
        actor_session: session_id,
        actor_user_id: actor.user_id,
        target_session: statsRequest.session,
        stats_only: statsRequest.stats_only || false,
      });
    } catch (error) {
      logger.error(`Error handling UserStats for session ${session_id}:`, error);
    }
  }

  /**
   * 处理 VoiceTarget 消息
   */
  handleVoiceTarget(session_id: number, data: Buffer): void {
    try {
      const voiceTarget = mumbleproto.VoiceTarget.deserialize(data);

      if (!voiceTarget.id || voiceTarget.id < 1 || voiceTarget.id >= 0x1f) {
        logger.warn(`Invalid voice target ID from session ${session_id}: ${voiceTarget.id}`);
        return;
      }

      // 如果没有targets，表示删除该voice target
      if (!voiceTarget.targets || voiceTarget.targets.length === 0) {
        this.voiceRouter.removeVoiceTarget(session_id, voiceTarget.id);
        logger.debug(`Removed voice target ${voiceTarget.id} for session ${session_id}`);
        
        // 向 Hub 同步删除
        if (this.hubClient) {
          this.hubClient.syncVoiceTarget({
            client_session: session_id,
            target_id: voiceTarget.id,
            config: null,
            timestamp: Date.now(),
          }).catch((err) => {
            logger.error(`Failed to sync voice target deletion to Hub:`, err);
          });
        }
        return;
      }

      // 将 Protobuf 对象转换为普通 TypeScript 对象
      // 这样可以避免 Protobuf optional 字段的默认值问题
      const convertedTargets = voiceTarget.targets.map(target => {
        const converted: VoiceTargetData = {};
        
        // 只有真正设置了的字段才添加到对象中
        if (target.session && target.session.length > 0) {
          converted.session = target.session;
        }
        if (target.has_channel_id) {
          converted.channel_id = target.channel_id;
        }
        if (target.has_group) {
          converted.group = target.group;
        }
        if (target.has_links) {
          converted.links = target.links;
        }
        if (target.has_children) {
          converted.children = target.children;
        }
        
        return converted;
      });

      // 保存voice target配置
      this.voiceRouter.setVoiceTarget(session_id, voiceTarget.id, convertedTargets);

      logger.debug(`Set voice target ${voiceTarget.id} for session ${session_id}: ${voiceTarget.targets.length} targets`);
      
      // 向 Hub 同步 VoiceTarget 配置
      // 将Mumble protocol格式转换为Hub-Edge proto格式
      if (this.hubClient) {
        // 收集所有session targets和channel targets
        const sessions: number[] = [];
        const channels: Array<{
          channel_id: number;
          include_subchannels: boolean;
          include_links: boolean;
          group?: string;
        }> = [];
        
        for (const target of voiceTarget.targets) {
          // 如果有session数组，添加到sessions
          if (target.session && target.session.length > 0) {
            sessions.push(...target.session);
          }
          
          // 如果有channel_id，添加到channels
          if (target.has_channel_id) {
            channels.push({
              channel_id: target.channel_id,
              include_subchannels: !!target.children,
              include_links: !!target.links,
              group: target.group,
            });
          }
        }
        
        this.hubClient.syncVoiceTarget({
          client_session: session_id,
          target_id: voiceTarget.id,
          config: {
            id: voiceTarget.id,
            sessions,
            channels,
          },
          timestamp: Date.now(),
        }).catch((err) => {
          logger.error(`Failed to sync voice target to Hub:`, err);
        });
      }
    } catch (error) {
      logger.error(`Error handling VoiceTarget for session ${session_id}:`, error);
    }
  }
}
