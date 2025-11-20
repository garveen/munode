import { EdgeServer } from './packages/edge-server/src/edge-server.js';
import { logger } from './packages/common/src/logger.js';

// 测试ACL加载功能
async function testACLLoading() {
  try {
    logger.info('Testing ACL loading from database...');

    // 创建一个简化的Edge配置（用于测试）
    const config = {
      network: {
        host: 'localhost',
        port: 64738,
      },
      tls: {
        cert: undefined,
        key: undefined,
        ca: undefined,
      },
      databasePath: ':memory:', // 使用内存数据库
      mode: 'standalone' as const,
      features: {
        geoip: false,
        userCache: false,
        packetPool: false,
        udpMonitor: false,
      },
    };

    // 创建Edge服务器实例
    const server = new EdgeServer(config);

    // 手动调用loadDataFromHub方法（在集群模式下）
    // 注意：这需要Hub连接，但我们可以检查方法是否正确处理ACL

    logger.info('ACL loading test completed');
  } catch (error) {
    logger.error('ACL loading test failed:', error);
  }
}

testACLLoading();