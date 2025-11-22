#!/usr/bin/env node

import { EdgeServer, loadEdgeConfig } from './index.js';
import { program } from 'commander';
// import { readFileSync } from 'fs';

program
  .name('edge-server')
  .description('Mumble Edge Server - Distributed voice server edge node')
  .version('1.0.0');

program
  .command('start')
  .description('Start the Edge Server')
  .option('-c, --config <path>', 'Path to configuration file', './config/edge-server.js')
  .option('-p, --port <port>', 'Server port', '64738')
  .option('-h, --host <host>', 'Server host', '0.0.0.0')
  .option('--hub-host <host>', 'Hub server host')
  .option('--hub-port <port>', 'Hub server port', '64739')
  .action(async (options) => {
    try {
      console.log('Starting Mumble Edge Server...');

      // 加载配置
      let config;
      try {
        config = await loadEdgeConfig(options.config);
      } catch (error) {
        console.log('Using default configuration...');
        config = await loadEdgeConfig();
      }

      // 应用命令行选项
      if (options.port) config.network.port = parseInt(options.port);
      if (options.host) config.network.host = options.host;
      if (options.hubHost) config.hubServer!.host = options.hubHost;
      if (options.hubPort) config.hubServer!.port = parseInt(options.hubPort);

      // 创建并启动服务器
      const server = new EdgeServer(config);

      // 设置信号处理器
      process.on('SIGINT', async () => {
        console.log('\nShutting down Edge Server...');
        await server.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        console.log('\nShutting down Edge Server...');
        await server.stop();
        process.exit(0);
      });

      // 启动服务器
      await server.start();

      console.log(
        `Edge Server started successfully on ${config.network.host}:${config.network.port}`
      );

      // 保持运行
      process.stdin.resume();
    } catch (error) {
      console.error('Failed to start Edge Server:', error);
      process.exit(1);
    }
  });

program
  .command('validate-config')
  .description('Validate configuration file')
  .option('-c, --config <path>', 'Path to configuration file', './config/edge-server.js')
  .action(async (options) => {
    try {
      const config = await loadEdgeConfig(options.config);
      const { validateConfig } = await import('./config.js');
      const errors = validateConfig(config);

      if (errors.length === 0) {
        console.log('Configuration is valid');
      } else {
        console.error('Configuration validation failed:');
        errors.forEach((error) => console.error(`  - ${error}`));
        process.exit(1);
      }
    } catch (error) {
      console.error('Failed to validate configuration:', error);
      process.exit(1);
    }
  });

program
  .command('generate-config')
  .description('Generate default configuration file')
  .option('-o, --output <path>', 'Output path', './config/edge-server.js')
  .option('-f, --format <format>', 'Output format (js or json)', 'js')
  .action(async (options) => {
    try {
      const config = await loadEdgeConfig();
      const fs = await import('fs');
      const path = await import('path');

      // 确保目录存在
      const dir = path.dirname(options.output);
      await fs.promises.mkdir(dir, { recursive: true });

      // 根据格式输出配置文件
      if (options.format === 'json') {
        await fs.promises.writeFile(options.output, JSON.stringify(config, null, 2));
      } else {
        // 输出 JS 格式
        const jsContent = `/**
 * Edge Server Configuration
 * @type {import('../packages/edge-server/src/types.js').EdgeConfig}
 */
export default ${JSON.stringify(config, null, 2)};
`;
        await fs.promises.writeFile(options.output, jsContent);
      }
      console.log(`Default configuration written to ${options.output}`);
    } catch (error) {
      console.error('Failed to generate configuration:', error);
      process.exit(1);
    }
  });

// 如果没有提供命令，显示帮助
if (process.argv.length === 2) {
  program.help();
}

program.parse();
