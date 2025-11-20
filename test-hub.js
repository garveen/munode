#!/usr/bin/env node

import { HubServer } from './packages/hub-server/dist/index.js';

async function testHubServer() {
  console.log('Testing Hub Server startup...');

  try {
    const config = {
      serverId: 1,
      name: 'Test Hub Server',
      host: '127.0.0.1',
      port: 50052, // 使用不同端口避免冲突
      tls: {
        requireClientCert: false, // 禁用客户端证书要求以简化测试
        ca: './certs/ca.pem',
        cert: './certs/server.pem',
        key: './certs/server.key'
      },
      registry: {
        heartbeatInterval: 30000,
        timeout: 90000,
        maxEdges: 10
      },
      database: {
        path: ':memory:', // 使用内存数据库
        backupDir: './data/backups',
        backupInterval: 86400000
      },
      webApi: {
        enabled: false,
        port: 8080,
        cors: false
      },
      logLevel: 'info'
    };

    const server = new HubServer(config);
    await server.start();

    console.log('✅ Hub Server started successfully!');

    // 等待几秒钟
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 获取状态
    const status = server.getStatus();
    console.log('Server status:', status);

    // 停止服务器
    await server.stop();
    console.log('✅ Hub Server stopped successfully!');

  } catch (error) {
    console.error('❌ Hub Server test failed:', error);
    process.exit(1);
  }
}

testHubServer();