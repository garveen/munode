#!/usr/bin/env node
/**
 * 手动集成测试入口文件（适配集成测试基础设施）
 *
 * 启动组件：
 * - 1 个 Auth Server（内置于 setup.ts）
 * - 1 个 Hub Server（TS 进程内 或 Rust 二进制，通过 MUNODE_USE_RUST=1 切换）
 * - 3 个 Edge Server
 *
 * 运行方式:
 *   npx tsx tests/integration/test-integration.ts
 *   或
 *   LOG_LEVEL=debug npx tsx tests/integration/test-integration.ts
 *   或
 *   MUNODE_USE_RUST=1 npx tsx tests/integration/test-integration.ts
 */

// 必须在导入任何模块之前设置环境变量
const logLevel = process.env.LOG_LEVEL ?? 'info';
process.env.LOG_LEVEL = logLevel;

import { setupTestEnvironment, USE_RUST, sleep, type TestEnvironment } from './setup.js';
import { testUserPasswords } from './test-users.js';
import { createLogger, setGlobalLogLevel } from '@munode/common';

// 确保所有 logger 都使用指定的日志级别
setGlobalLogLevel(logLevel);

const logger = createLogger({ service: 'integration-test' });

logger.info(`Log level set to: ${logLevel}`);
logger.info(`Mode: ${USE_RUST ? 'Rust binary' : 'TypeScript in-process'}`);

// ==================
// 测试场景
// ==================

/**
 * 运行基本测试场景
 */
async function runTestScenarios(testEnv: TestEnvironment): Promise<void> {
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('Running Test Scenarios');
  logger.info('='.repeat(60));

  // 等待所有服务器稳定
  await sleep(3000);

  // 场景 1: 检查服务器状态
  logger.info('\n[Scenario 1] Checking server status...');

  if (USE_RUST) {
    logger.info(`Hub process:   running=${testEnv.hubProcess?.isRunning() ?? false}, pid=${testEnv.hubProcess?.pid ?? 'N/A'}`);
    logger.info(`Edge 1 process: running=${testEnv.edgeProcess?.isRunning() ?? false}, pid=${testEnv.edgeProcess?.pid ?? 'N/A'}`);
    logger.info(`Edge 2 process: running=${testEnv.edgeProcess2?.isRunning() ?? false}, pid=${testEnv.edgeProcess2?.pid ?? 'N/A'}`);
    logger.info(`Edge 3 process: running=${testEnv.edgeProcess3?.isRunning() ?? false}, pid=${testEnv.edgeProcess3?.pid ?? 'N/A'}`);
  } else {
    const hubStatus = testEnv.hubServer?.getStatus();
    logger.info(`Hub Server: ${JSON.stringify(hubStatus, null, 2)}`);

    const edges = [testEnv.edgeServer, testEnv.edgeServer2, testEnv.edgeServer3].filter(Boolean);
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]!;
      const edgeStatus = {
        server_id: edge.getConfig().server_id,
        name: edge.getConfig().name,
        port: edge.getConfig().network.port,
        uptime: edge.getUptime(),
        running: edge.isServerRunning(),
      };
      logger.info(`Edge Server ${i + 1}: ${JSON.stringify(edgeStatus, null, 2)}`);
    }
  }

  // 端口信息（动态分配，不再硬编码）
  logger.info('\nPort assignments:');
  logger.info(`  Auth Server:    http://localhost:${testEnv.authPort}`);
  logger.info(`  Hub Control:    ws://localhost:${testEnv.controlPort}`);
  logger.info(`  Hub Web API:    http://localhost:${testEnv.webApiPort}`);
  logger.info(`  Edge 1 Client:  mumble://localhost:${testEnv.edgePort}`);
  if (testEnv.edgePort2 > 0) {
    logger.info(`  Edge 2 Client:  mumble://localhost:${testEnv.edgePort2}`);
  }
  if (testEnv.edgePort3 > 0) {
    logger.info(`  Edge 3 Client:  mumble://localhost:${testEnv.edgePort3}`);
  }

  // 场景 2: 显示可用测试用户
  logger.info('\n[Scenario 2] Available test users...');
  const userEntries = Object.entries(testUserPasswords);
  for (const [username, info] of userEntries) {
    const groups = info.groups?.join(', ') ?? 'user';
    logger.info(`  ${username} (id=${info.user_id}, password=${info.password}, groups=[${groups}])`);
  }
  const total = userEntries.length;
  logger.info(`Total: ${total} users`);
}

// ==================
// 主程序
// ==================

async function main(): Promise<void> {
  logger.info('Starting Integration Test Environment...');
  logger.info(`Mode: ${USE_RUST ? 'Rust binary' : 'TypeScript in-process'}`);
  logger.info('');

  try {
    // 使用集成测试基础设施启动：Auth + Hub + Edge1 + Edge2 + Edge3
    logger.info('Setting up environment via setupTestEnvironment (Auth + Hub + Edge1 + Edge2 + Edge3)...');
    const testEnv = await setupTestEnvironment(8080, {
      startHub:   true,
      startEdge:  true,
      startEdge2: true,
      startEdge3: true,
      startEdge4: false,
      startAuth:  true,
      reuse:      false,
      silent:     false,  // 手动测试始终转发 Rust 进程的 stdout/stderr
    });

    logger.info('');
    logger.info('✓ All servers started successfully!');
    logger.info('');

    // 运行测试场景
    await runTestScenarios(testEnv);

    // 保持运行，等待手动终止
    // setup.ts 已注册 SIGINT/SIGTERM 处理器负责清理
    logger.info('\nEnvironment is running. Press Ctrl+C to stop.');
    await new Promise<never>(() => { /* keep alive */ });

  } catch (error) {
    logger.error('Failed to start servers:', { error });
    process.exit(1);
  }
}

// 启动
main().catch(error => {
  logger.error('Fatal error:', { error });
  process.exit(1);
});
