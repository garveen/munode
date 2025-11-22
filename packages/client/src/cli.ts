#!/usr/bin/env node

/**
 * Headless Mumble Client CLI
 * 
 * 提供 HTTP API 和 WebSocket 接口的无头客户端
 */

import { program } from 'commander';
import { MumbleClient } from './core/mumble-client.js';
import { startHttpServer } from './api/http-server.js';
import { startWebSocketServer } from './api/websocket.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ConnectOptions } from './types/client-types.js';

interface CliConfig {
  server: {
    host: string;
    port: number;
    username: string;
    password?: string;
    tokens?: string[];
  };
  api: {
    http: {
      enabled: boolean;
      host: string;
      port: number;
      cors?: boolean;
      auth?: {
        enabled: boolean;
        token?: string;
      };
    };
    websocket: {
      enabled: boolean;
      port: number;
      auth?: {
        enabled: boolean;
        token?: string;
      };
    };
  };
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
  };
}

program
  .name('munode-client')
  .description('Headless Mumble client with HTTP API and WebSocket support')
  .version('1.0.0');

program
  .command('start')
  .description('Start the headless client with API servers')
  .option('-c, --config <path>', 'Path to configuration file', './config/client.json')
  .option('-h, --host <host>', 'Mumble server host')
  .option('-p, --port <port>', 'Mumble server port', '64738')
  .option('-u, --username <username>', 'Username to connect with')
  .option('--password <password>', 'Password for authentication')
  .option('--http-port <port>', 'HTTP API port', '3000')
  .option('--ws-port <port>', 'WebSocket port', '3001')
  .option('--no-http', 'Disable HTTP API')
  .option('--no-ws', 'Disable WebSocket')
  .action(async (options) => {
    try {
      console.log('Starting Headless Mumble Client...');

      // 加载配置文件
      let config: CliConfig;
      try {
        const configPath = resolve(options.config);
        const configData = readFileSync(configPath, 'utf-8');
        config = JSON.parse(configData);
        console.log(`Loaded configuration from ${configPath}`);
      } catch (error) {
        console.log('Using default configuration...');
        config = {
          server: {
            host: 'localhost',
            port: 64738,
            username: 'HeadlessClient',
          },
          api: {
            http: {
              enabled: true,
              host: '0.0.0.0',
              port: 3000,
              cors: true,
            },
            websocket: {
              enabled: true,
              port: 3001,
            },
          },
        };
      }

      // 应用命令行选项
      if (options.host) config.server.host = options.host;
      if (options.port) config.server.port = parseInt(options.port);
      if (options.username) config.server.username = options.username;
      if (options.password) config.server.password = options.password;
      if (options.httpPort) config.api.http.port = parseInt(options.httpPort);
      if (options.wsPort) config.api.websocket.port = parseInt(options.wsPort);
      if (options.http === false) config.api.http.enabled = false;
      if (options.ws === false) config.api.websocket.enabled = false;

      // 创建客户端实例
      const client = new MumbleClient();

      // 启动 HTTP API 服务器
      let httpServer;
      if (config.api.http.enabled) {
        httpServer = await startHttpServer(client, {
          host: config.api.http.host,
          port: config.api.http.port,
          cors: config.api.http.cors,
          authToken: config.api.http.auth?.token,
        });
        console.log(`HTTP API server started on ${config.api.http.host}:${config.api.http.port}`);
      }

      // 启动 WebSocket 服务器
      let wsServer;
      if (config.api.websocket.enabled) {
        wsServer = await startWebSocketServer(client, {
          port: config.api.websocket.port,
          authToken: config.api.websocket.auth?.token,
        });
        console.log(`WebSocket server started on port ${config.api.websocket.port}`);
      }

      // 连接到 Mumble 服务器
      console.log(`Connecting to Mumble server at ${config.server.host}:${config.server.port}...`);
      const connectOptions: ConnectOptions = {
        host: config.server.host,
        port: config.server.port,
        username: config.server.username,
        password: config.server.password,
        tokens: config.server.tokens,
      };
      await client.connect(connectOptions);

      console.log('✓ Headless client started successfully');
      console.log(`  - Connected as: ${config.server.username}`);
      if (config.api.http.enabled) {
        console.log(`  - HTTP API: http://${config.api.http.host}:${config.api.http.port}`);
      }
      if (config.api.websocket.enabled) {
        console.log(`  - WebSocket: ws://localhost:${config.api.websocket.port}`);
      }

      // 优雅关闭
      const shutdown = async () => {
        console.log('\nShutting down...');
        
        if (wsServer) {
          await wsServer.close();
        }
        if (httpServer) {
          await httpServer.stop();
        }
        await client.disconnect();
        
        console.log('Goodbye!');
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // 保持运行
      process.stdin.resume();
    } catch (error) {
      console.error('Failed to start client:', error);
      process.exit(1);
    }
  });

program
  .command('connect')
  .description('Quick connect to a Mumble server (no API)')
  .requiredOption('-h, --host <host>', 'Mumble server host')
  .option('-p, --port <port>', 'Mumble server port', '64738')
  .requiredOption('-u, --username <username>', 'Username to connect with')
  .option('--password <password>', 'Password for authentication')
  .option('-t, --tokens <tokens...>', 'Access tokens')
  .action(async (options) => {
    try {
      const client = new MumbleClient();

      console.log(`Connecting to ${options.host}:${options.port} as ${options.username}...`);
      
      const connectOptions: ConnectOptions = {
        host: options.host,
        port: parseInt(options.port),
        username: options.username,
        password: options.password,
        tokens: options.tokens,
      };
      await client.connect(connectOptions);

      console.log('✓ Connected successfully');
      console.log('Press Ctrl+C to disconnect');

      // 优雅关闭
      const shutdown = async () => {
        console.log('\nDisconnecting...');
        await client.disconnect();
        console.log('Goodbye!');
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // 保持运行
      process.stdin.resume();
    } catch (error) {
      console.error('Failed to connect:', error);
      process.exit(1);
    }
  });

program
  .command('generate-config')
  .description('Generate a default configuration file')
  .option('-o, --output <path>', 'Output path', './config/client.json')
  .action(async (options) => {
    try {
      const { writeFileSync, mkdirSync } = await import('fs');
      const { dirname } = await import('path');

      const defaultConfig: CliConfig = {
        server: {
          host: 'localhost',
          port: 64738,
          username: 'HeadlessClient',
          tokens: [],
        },
        api: {
          http: {
            enabled: true,
            host: '0.0.0.0',
            port: 3000,
            cors: true,
            auth: {
              enabled: false,
            },
          },
          websocket: {
            enabled: true,
            port: 3001,
            auth: {
              enabled: false,
            },
          },
        },
        logging: {
          level: 'info',
        },
      };

      const dir = dirname(options.output);
      mkdirSync(dir, { recursive: true });
      writeFileSync(options.output, JSON.stringify(defaultConfig, null, 2));
      
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
