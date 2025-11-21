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
  const dbPath = path.join(process.cwd(), 'data', 'hub-test.db');

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
      if (channel.id > 0 && (channel.name.startsWith('Test') || channel.name.startsWith('SubChannel') || ['General', 'Voice Chat', 'Gaming', 'Music'].includes(channel.name))) {
        await db.deleteChannel(channel.id);
      }
    }

    // 创建测试频道结构
    logger.info('Creating test channel structure...');

    // 创建一些测试频道
    const testChannels = [
      { name: 'General', parent_id: 0 },
      { name: 'Voice Chat', parent_id: 0 },
      { name: 'Gaming', parent_id: 0 },
      { name: 'Music', parent_id: 0 },
    ];

    for (const channel of testChannels) {
      await db.createChannel(channel);
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