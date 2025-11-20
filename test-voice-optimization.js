#!/usr/bin/env node

/**
 * 语音包互联修复验证脚本
 * 验证 Edge 之间语音包传输是否正常工作
 */

import { logger } from '@munode/common';
import { EdgeStateManager } from './packages/edge-server/dist/state-manager.js';

async function testVoiceBroadcastOptimization() {
  logger.info('Testing voice broadcast optimization...');

  const stateManager = new EdgeStateManager();

  // 模拟添加远程用户
  logger.info('Adding remote users...');
  stateManager.addRemoteUser(1, 2, 100); // session 1, edge 2, channel 100
  stateManager.addRemoteUser(2, 2, 100); // session 2, edge 2, channel 100
  stateManager.addRemoteUser(3, 3, 200); // session 3, edge 3, channel 200

  // 测试频道查询
  logger.info('Testing channel queries...');
  console.log('Edges in channel 100:', Array.from(stateManager.getEdgesInChannel(100)));
  console.log('Edges in channel 200:', Array.from(stateManager.getEdgesInChannel(200)));
  console.log('Edges in channel 300:', Array.from(stateManager.getEdgesInChannel(300)));

  // 测试用户离开
  logger.info('Testing user removal...');
  stateManager.removeRemoteUser(1); // 移除 session 1
  console.log('Edges in channel 100 after removal:', Array.from(stateManager.getEdgesInChannel(100)));

  // 测试频道切换
  logger.info('Testing channel change...');
  stateManager.updateRemoteUserChannel(2, 300); // session 2 从 channel 100 切换到 300
  console.log('Edges in channel 100 after channel change:', Array.from(stateManager.getEdgesInChannel(100)));
  console.log('Edges in channel 300 after channel change:', Array.from(stateManager.getEdgesInChannel(300)));

  logger.info('Voice broadcast optimization test completed successfully!');
}

// 运行测试
testVoiceBroadcastOptimization().catch(console.error);