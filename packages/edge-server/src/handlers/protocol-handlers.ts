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
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';
import { MessageType } from '@munode/protocol';
import { Permission } from '@munode/protocol';
import type { ClientInfo } from '../types.js';
import type { HandlerFactory } from '../handler-factory.js';

export class ProtocolHandlers {
  constructor(private factory: HandlerFactory) {}

  private get clientManager() { return this.factory.clientManager; }
  private get channelManager() { return this.factory.channelManager; }
  private get messageHandler() { return this.factory.messageHandler; }
  private get voiceRouter() { return this.factory.voiceRouter; }
  private get userCache() { return this.factory.userCache; }

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
      this.clientManager.updateClient(session_id, {
        version: version.version ? version.version.toString(16) : undefined,
        client_name: version.release || undefined,
        os_name: version.os || undefined,
        os_version: version.os_version || undefined,
      });

      logger.debug(
        `Client ${session_id} version: ${version.release || 'unknown'} on ${version.os || 'unknown'}`
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
      const query = mumbleproto.QueryUsers.deserialize(data);

      const response = {
        ids: [] as number[],
        names: [] as string[],
      };

      // 根据ID查询用户
      if (query.ids && query.ids.length > 0 && this.userCache) {
        for (const id of query.ids) {
          const user = await this.userCache.getUserById(id);
          if (user) {
            response.ids.push(id);
            response.names.push(user.username);
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
  handleUserStats(session_id: number, data: Buffer, hasPermission: (client: ClientInfo, channel: any, perm: Permission) => boolean): void {
    try {
      const statsRequest = mumbleproto.UserStats.deserialize(data);

      if (!statsRequest.session) {
        logger.warn(`UserStats request without target session from ${session_id}`);
        return;
      }

      const actor = this.clientManager.getClient(session_id);
      const target = this.clientManager.getClient(statsRequest.session);

      if (!actor || !target) {
        logger.warn(`UserStats for invalid sessions: actor=${session_id}, target=${statsRequest.session}`);
        return;
      }

      // 权限检查
      const rootChannel = this.channelManager.getChannel(0);
      const extended = actor === target || (rootChannel && hasPermission(actor, rootChannel, Permission.Register));

      if (!extended) {
        const targetChannel = this.channelManager.getChannel(target.channel_id);
        if (!targetChannel || !hasPermission(actor, targetChannel, Permission.Enter)) {
          logger.warn(`Permission denied for UserStats: session ${session_id}`);
          return;
        }
      }

      // 构建响应
      const response: Partial<mumbleproto.UserStats> & { certificates: Buffer[]; celt_versions: number[] } = {
        session: target.session,
        onlinesecs: Math.floor((Date.now() - target.connected_at.getTime()) / 1000),
        idlesecs: Math.floor((Date.now() - target.last_active.getTime()) / 1000),
        certificates: [],
        celt_versions: [],
      };

      // 详细信息（extended权限）
      if (extended && !statsRequest.stats_only) {
        if (target.version || target.client_name || target.os_name) {
          response.version = new mumbleproto.Version({
            version: target.version ? parseInt(target.version, 16) : undefined,
            release: target.client_name || undefined,
            os: target.os_name || undefined,
            os_version: target.os_version || undefined,
          });
        }

        if (target.cert_hash) {
          response.strong_certificate = true;
        }

        response.address = target.ip_address
          ? Buffer.from(target.ip_address.split('.').map((n) => parseInt(n)))
          : undefined;
      }

      // 网络统计
      const local = extended || target.channel_id === actor.channel_id;
      if (local) {
        response.from_client = new mumbleproto.UserStats.Stats({
          good: 0,
          late: 0,
          lost: 0,
          resync: 0,
        });

        response.from_server = new mumbleproto.UserStats.Stats({
          good: 0,
          late: 0,
          lost: 0,
          resync: 0,
        });

        response.udp_packets = 0;
        response.tcp_packets = 0;
        response.udp_ping_avg = 0;
        response.udp_ping_var = 0;
        response.tcp_ping_avg = 0;
        response.tcp_ping_var = 0;
      }

      // 发送响应
      const responseMessage = new mumbleproto.UserStats(response).serialize();
      this.messageHandler.sendMessage(session_id, MessageType.UserStats, Buffer.from(responseMessage));

      logger.debug(`Sent UserStats for session ${target.session} to ${session_id}`);
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
        return;
      }

      // 保存voice target配置
      this.voiceRouter.setVoiceTarget(session_id, voiceTarget.id, voiceTarget.targets);

      logger.debug(`Set voice target ${voiceTarget.id} for session ${session_id}: ${voiceTarget.targets.length} targets`);
    } catch (error) {
      logger.error(`Error handling VoiceTarget for session ${session_id}:`, error);
    }
  }
}
