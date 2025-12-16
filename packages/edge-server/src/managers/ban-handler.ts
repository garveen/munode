import type { Logger } from 'winston';
import { MessageType } from '@munode/protocol';
import { mumbleproto } from '@munode/protocol';
import { HandlerFactory } from '../core/handler-factory.js';
import { ClientInfo } from '../types.js';

/**
 * 将Buffer转换为IP地址字符串
 */
function bufferToIPAddress(buffer: Buffer | Uint8Array): string {
  // 确保是Buffer
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  
  if (buf.length === 4) {
    // IPv4
    return buf.join('.');
  } else if (buf.length === 16) {
    // IPv6 - 转换为冒号分隔的十六进制格式
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(buf.readUInt16BE(i).toString(16));
    }
    return parts.join(':');
  } else {
    throw new Error(`Invalid IP address buffer length: ${buf.length}`);
  }
}

/**
 * 封禁处理器
 * 负责处理封禁列表查询、更新和管理
 */
export class BanHandler {
  private handlerFactory: HandlerFactory;
  private logger: Logger;

  constructor(handlerFactory: HandlerFactory) {
    this.handlerFactory = handlerFactory;
    this.logger = handlerFactory.logger;
  }

  /**
   * 处理封禁列表查询
   */
  async handleBanListQuery(session_id: number): Promise<void> {
    try {
      // 检查权限 - 只有管理员可以查询封禁列表
      const client = this.handlerFactory.clientManager.getClient(session_id);
      if (!client || !this.checkAdminPermission(client)) {
        this.handlerFactory.messageHandlers.sendPermissionDenied(session_id, 'ban', 'Permission denied: admin required');
        return;
      }

      // 获取所有活跃封禁
      const bans = await this.handlerFactory.banManager.getAllActiveBans();

      // 转换为协议格式
      const banEntries = bans.map((ban) => new mumbleproto.BanList.BanEntry({
        address: ban.address ? Buffer.from(ban.address) : Buffer.alloc(0),
        mask: ban.mask || 32,
        name: ban.name || undefined,
        hash: ban.hash || undefined,
        reason: ban.reason || undefined,
        start: ban.startDate.toISOString(),
        duration: ban.duration || undefined,
      }));

      // 发送封禁列表
      const banListMessage = Buffer.from(new mumbleproto.BanList({ bans: banEntries }).serialize());
      this.handlerFactory.messageHandler.sendMessage(session_id, MessageType.BanList, banListMessage);

        this.logger.info(`Sent ban list to session ${session_id}: ${bans.length} bans`);
    } catch (error) {
        this.logger.error('Error handling ban list query:', error);
      this.handlerFactory.messageHandlers.sendPermissionDenied(session_id, 'ban', 'Internal error');
    }
  }

  /**
   * 处理封禁列表更新（替换整个封禁列表）
   * 
   * 根据 Mumble 协议，当客户端发送 BanList 消息时，应该替换整个封禁列表，而不是追加。
   * 空列表表示清除所有封禁。
   */
  async handleBanListUpdate(
    session_id: number,
    banEntries: mumbleproto.BanList.BanEntry[]
  ): Promise<void> {
    try {
      // 检查权限
      const client = this.handlerFactory.clientManager.getClient(session_id);
      if (!client || !this.checkAdminPermission(client)) {
        this.handlerFactory.messageHandlers.sendPermissionDenied(session_id, 'ban', 'Permission denied: admin required');
        return;
      }

      // 第一步：清除所有现有封禁
      const existingBans = await this.handlerFactory.banManager.getAllActiveBans();
      for (const ban of existingBans) {
        await this.handlerFactory.banManager.removeBan(ban.id);
      }
        this.logger.info(`Admin ${client.username} cleared ${existingBans.length} existing bans`);

      // 第二步：添加新的封禁列表
      for (const entry of banEntries) {
        try {
          if (entry.address && entry.address.length > 0) {
            // IP 封禁 - 将Buffer转换为IP地址字符串
            const ipAddress = bufferToIPAddress(entry.address);
            const banId = await this.handlerFactory.banManager.addBan({
              address: ipAddress,
              mask: entry.mask || 32,
              reason: entry.reason || 'Banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
        this.logger.info(`Admin ${client.username} banned IP ${ipAddress} (ID: ${banId})`);
          } else if (entry.hash) {
            // 证书封禁
            const banId = await this.handlerFactory.banManager.addBan({
              hash: entry.hash,
              reason: entry.reason || 'Certificate banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
        this.logger.info(
              `Admin ${client.username} banned certificate ${entry.hash.substring(0, 8)}... (ID: ${banId})`
            );
          } else if (entry.name) {
            // 用户封禁
            const banId = await this.handlerFactory.banManager.addBan({
              name: entry.name,
              reason: entry.reason || 'User banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
        this.logger.info(`Admin ${client.username} banned user ${entry.name} (ID: ${banId})`);
          }
        } catch (error) {
        this.logger.error('Error processing ban entry:', error);
        }
      }

      // 重新发送更新后的封禁列表
      await this.handleBanListQuery(session_id);
    } catch (error) {
        this.logger.error('Error handling ban list update:', error);
      this.handlerFactory.messageHandlers.sendPermissionDenied(session_id, 'ban', 'Internal error');
    }
  }

  /**
   * 检查管理员权限
   */
  private checkAdminPermission(client: ClientInfo): boolean {
    // 检查是否有管理员组
    return (
      client.groups && (client.groups.includes('admin') || client.groups.includes('superuser'))
    );
  }
}