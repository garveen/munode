import { createLogger } from '@munode/common';
import type { HubDatabase } from './database.js';

const logger = createLogger({ service: 'sync-broadcaster' });

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */

/**
 * 同步广播器 - 暂时简化实现
 * TODO: 重新实现基于MessagePack + WebSocket的同步机制
 */
export class SyncBroadcaster {
  // @ts-expect-error - stub implementation
  private db: HubDatabase;
  // @ts-expect-error - stub implementation
  private initialized = false;

  constructor(db: HubDatabase) {
    this.db = db;
  }

  async init(): Promise<void> {
    // TODO: 初始化同步广播器
    logger.info('SyncBroadcaster initialized (stub)');
    this.initialized = true;
  }

  // 临时stub方法
  broadcastChannelCreate(channel: any): void {
    logger.debug('broadcastChannelCreate (stub)', channel);
  }

  broadcastChannelUpdate(channel: any): void {
    logger.debug('broadcastChannelUpdate (stub)', channel);
  }

  broadcastChannelDelete( channel_id: number): void {
    logger.debug('broadcastChannelDelete (stub)', channel_id);
  }

  broadcastChannelLink( channel_id: number,  target_id: number): void {
    logger.debug('broadcastChannelLink (stub)', { channel_id, target_id });
  }

  broadcastChannelUnlink( channel_id: number,  target_id: number): void {
    logger.debug('broadcastChannelUnlink (stub)', { channel_id, target_id });
  }

  broadcastACLUpdate( channel_id: number, acls: any[]): void {
    logger.debug('broadcastACLUpdate (stub)', { channel_id, acls });
  }

  broadcastACLDelete(aclId: number): void {
    logger.debug('broadcastACLDelete (stub)', aclId);
  }

  broadcastChannelGroupUpdate( channel_id: number, channelGroups: any[]): void {
    logger.debug('broadcastChannelGroupUpdate (stub)', { channel_id, channelGroups });
  }

  broadcastChannelGroupDelete( channel_id: number, channelGroupName: string): void {
    logger.debug('broadcastChannelGroupDelete (stub)', { channel_id, channelGroupName });
  }

  broadcastBanAdd(ban: any): void {
    logger.debug('broadcastBanAdd (stub)', ban);
  }

  broadcastBanRemove(banId: number): void {
    logger.debug('broadcastBanRemove (stub)', banId);
  }

  broadcastConfigUpdate(key: string, value: any): void {
    logger.debug('broadcastConfigUpdate (stub)', { key, value });
  }
}
