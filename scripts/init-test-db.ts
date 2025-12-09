#!/usr/bin/env node

/**
 * 测试数据库初始化脚本
 * 用于在集成测试前初始化测试数据库
 */

import { HubDatabase } from '../packages/hub-server/src/database.js';
import { createLogger } from '@munode/common';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger({ service: 'test-db-init' });

async function initTestDatabase() {
  // 支持命令行参数或环境变量指定数据库路径
  const dbPath = process.argv[2] || process.env.DB_PATH || path.join(process.cwd(), 'data', 'hub-test.db');

  // 确保数据目录存在
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  try {
    // 初始化数据库
    const db = new HubDatabase({
      path: dbPath,
      backupDir: './data/backups',
      backupInterval: 3600000, // 1小时
    });

    // 设置测试环境变量以禁用备份
    process.env.NODE_ENV = 'test';
    await db.init();
    logger.info('Test database initialized successfully');

    // 初始化测试数据
    await initTestData(db);

    // 等待一下确保所有操作完成
    await new Promise(resolve => setTimeout(resolve, 100));

    // 强制清理并关闭数据库连接
    try {
      await db.close();
      logger.info('Test database initialization completed');
    } catch (closeError) {
      logger.warn('Error closing database, but continuing:', closeError);
      // 即使关闭失败也算成功，因为数据已经初始化了
      logger.info('Test database initialization completed (with close warning)');
    }

  } catch (error) {
    logger.error('Failed to initialize test database:', error);
    process.exit(1);
  }
}

async function initTestData(db: HubDatabase) {
  try {
    // 清理现有测试数据
    logger.info('Cleaning existing test data...');
    
    // 先删除所有频道组
    const allChannels = await db.getAllChannels();
    for (const channel of allChannels) {
      if (channel.id > 0) {
        await db.clearChannelGroups(channel.id);
        await db.clearChannelACLs(channel.id);
      }
    }
    
    // 删除测试频道（保留根频道）
    for (const channel of allChannels) {
      if (channel.id > 0 && (channel.name.startsWith('Test') || channel.name.startsWith('SubChannel') || ['Lobby', 'General', 'Private', 'Voice Chat', 'Gaming', 'Music'].includes(channel.name))) {
        await db.deleteChannel(channel.id);
      }
    }

    // 创建测试频道结构（与 tests/integration/fixtures.ts 中的 TEST_CHANNELS 保持一致）
    logger.info('Creating test channel structure...');

    // 确保按照固定的ID创建频道，以匹配测试fixtures
    const testChannels = [
      { name: 'Lobby', parent_id: 0, position: 0 },      // ID 应该是 1
      { name: 'General', parent_id: 0, position: 1 },    // ID 应该是 2
      { name: 'Private', parent_id: 0, position: 2 },    // ID 应该是 3
    ];

    const createdChannelIds: number[] = [];
    for (const channel of testChannels) {
      const channelId = await db.createChannel(channel);
      createdChannelIds.push(channelId);
      logger.info(`Created channel: ${channel.name} (ID: ${channelId})`);
    }

    // 验证创建的频道ID是否符合预期
    if (createdChannelIds[0] !== 1 || createdChannelIds[1] !== 2 || createdChannelIds[2] !== 3) {
      logger.warn('Warning: Created channel IDs do not match expected fixture IDs');
      logger.warn(`Expected: [1, 2, 3], Got: [${createdChannelIds.join(', ')}]`);
    }

    // 暂时跳过ACL和频道组创建，以避免外键约束问题
    logger.info('Skipping ACL and channel group creation for now');

    logger.info('Test data initialized successfully');

  } catch (error) {
    logger.error('Failed to initialize test data:', error);
    throw error;
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  initTestDatabase();
}

export { initTestDatabase };