import { logger } from '@munode/common';
import { MessageType } from '@munode/protocol';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';
import { HandlerFactory } from '../core/handler-factory.js';
import { ClientInfo } from '../types.js';

/**
 * 封禁处理器
 * 负责处理封禁列表查询、更新和管理
 */
export class BanHandler {
  private handlerFactory: HandlerFactory;

  constructor(handlerFactory: HandlerFactory) {
    this.handlerFactory = handlerFactory;
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

      logger.info(`Sent ban list to session ${session_id}: ${bans.length} bans`);
    } catch (error) {
      logger.error('Error handling ban list query:', error);
      this.handlerFactory.messageHandlers.sendPermissionDenied(session_id, 'ban', 'Internal error');
    }
  }

  /**
   * 处理封禁列表更新（添加/移除封禁）
   */
  async handleBanListUpdate(
     session_id: number,
    banEntries: Array<{
      address?: Buffer;
      mask?: number;
      hash?: string;
      name?: string;
      reason?: string;
      start?: number;
      duration?: number;
    }>
  ): Promise<void> {
    try {
      // 检查权限
      const client = this.handlerFactory.clientManager.getClient(session_id);
      if (!client || !this.checkAdminPermission(client)) {
        this.handlerFactory.messageHandlers.sendPermissionDenied(session_id, 'ban', 'Permission denied: admin required');
        return;
      }

      for (const entry of banEntries) {
        try {
          if (entry.address && entry.address.length > 0) {
            // IP 封禁
            const ipAddress = entry.address.toString();
            const banId = await this.handlerFactory.banManager.addBan({
              address: ipAddress,
              mask: entry.mask || 32,
              reason: entry.reason || 'Banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
            logger.info(`Admin ${client.username} banned IP ${ipAddress} (ID: ${banId})`);
          } else if (entry.hash) {
            // 证书封禁
            const banId = await this.handlerFactory.banManager.addBan({
              hash: entry.hash,
              reason: entry.reason || 'Certificate banned by admin',
              startDate: entry.start ? new Date(entry.start) : new Date(),
              duration: entry.duration || 0,
              createdBy: client.username,
            });
            logger.info(
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
            logger.info(`Admin ${client.username} banned user ${entry.name} (ID: ${banId})`);
          }
        } catch (error) {
          logger.error('Error processing ban entry:', error);
        }
      }

      // 重新发送更新后的封禁列表
      await this.handleBanListQuery(session_id);
    } catch (error) {
      logger.error('Error handling ban list update:', error);
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