/**
 * 集成测试环境设置
 */

import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import * as http from 'http';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 获取项目根目录（从 tests/integration 向上两级）
const PROJECT_ROOT = join(__dirname, '../..');

export interface TestEnvironment {
  hubProcess?: ChildProcess;
  edgeProcess?: ChildProcess;
  edgeProcess2?: ChildProcess; // 第二个 Edge 服务器用于跨 Edge 测试
  authServer?: http.Server;
  hubPort: number;
  edgePort: number;
  edgePort2: number; // 第二个 Edge 服务器端口
  cleanup: () => Promise<void>;
}

/**
 * 简单的认证服务器用于测试
 */
class TestAuthServer {
  private server: http.Server;
  private port: number;

  constructor(port: number = 8080) {
    this.port = port;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === '/auth' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const authReq = JSON.parse(body);
          const result = this.authenticate(authReq);
          res.writeHead(result.success ? 200 : 401);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, message: 'Invalid request' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private authenticate(req: any): any {
    // 测试用户数据
    const users: Record<string, { password: string; user_id: number }> = {
      'admin': { password: 'admin123', user_id: 1 },
      'user1': { password: 'password1', user_id: 2 },
      'user2': { password: 'password2', user_id: 3 },
      'guest': { password: 'guest123', user_id: 4 },
    };

    const user = users[req.username];
    if (!user || user.password !== req.password) {
      return { success: false, reason: 'Invalid credentials' };
    }

    return {
      success: true,
      user_id: user.user_id,
      username: req.username,
      displayName: req.username,
      groups: req.username === 'admin' ? ['admin'] : ['user'],
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        console.log(`Test auth server listening on port ${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  getServer(): http.Server {
    return this.server;
  }
}

/**
 * 启动 Hub 服务器用于测试
 */
export async function startHubServer(configPath?: string): Promise<ChildProcess> {
  const hubPath = join(PROJECT_ROOT, 'packages/hub-server/dist/cli.js');
  const config = configPath || join(PROJECT_ROOT, 'config/hub.json');

  // 确保构建产物存在
  if (!fs.existsSync(hubPath)) {
    throw new Error(`Hub server binary not found at ${hubPath}. Run 'pnpm build' first.`);
  }

  const hubProcess = spawn('node', [hubPath, config], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info', // 需要看到启动消息
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 等待服务器启动
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Hub server startup timeout'));
    }, 10000); // 减少到10秒

    let startupDetected = false;
    
    const checkStartup = (data: Buffer) => {
      const message = data.toString();
      if (message.includes('Hub Server started successfully') || 
          message.includes('listening') || 
          message.includes('ready')) {
        if (!startupDetected) {
          startupDetected = true;
          clearTimeout(timeout);
          resolve();
        }
      }
    };

    hubProcess.stdout?.on('data', checkStartup);
    hubProcess.stderr?.on('data', checkStartup);

    hubProcess.stderr?.on('data', (data: Buffer) => {
      console.error('Hub stderr:', data.toString());
    });

    hubProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    hubProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Hub process exited with code ${code}`));
      }
    });
  });

  return hubProcess;
}

/**
 * 启动 Edge 服务器用于测试
 */
export async function startEdgeServer(configPath?: string, port?: number): Promise<ChildProcess> {
  const edgePath = join(PROJECT_ROOT, 'packages/edge-server/dist/cli.js');
  const config = configPath || join(PROJECT_ROOT, 'config/edge.example.json');

  // 确保构建产物存在
  if (!fs.existsSync(edgePath)) {
    throw new Error(`Edge server binary not found at ${edgePath}. Run 'pnpm build' first.`);
  }

  const args = [edgePath, 'start', '-c', configPath || config];
  if (port) {
    args.push('-p', port.toString());
  }
  const edgeProcess = spawn('node', args, {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info', // 需要看到启动消息
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 等待服务器启动
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Edge server startup timeout'));
    }, 10000); // 减少到10秒

    let startupDetected = false;
    
    const checkStartup = (data: Buffer) => {
      const message = data.toString();
      console.log('Edge stdout:', message);
      if (message.includes('Edge Server started successfully') || 
          message.includes('listening') || 
          message.includes('ready')) {
        if (!startupDetected) {
          startupDetected = true;
          clearTimeout(timeout);
          resolve();
        }
      }
    };

    edgeProcess.stdout?.on('data', checkStartup);
    edgeProcess.stderr?.on('data', checkStartup);

    edgeProcess.stderr?.on('data', (data: Buffer) => {
      console.error('Edge stderr:', data.toString());
    });

    edgeProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    edgeProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Edge process exited with code ${code}`));
      }
    });
  });

  return edgeProcess;
}

/**
 * 设置完整的测试环境 (Auth Server + Hub + Edge)
 */
export async function setupTestEnvironment(
  port: number = 8080,
  options: {
    startHub?: boolean;
    startEdge?: boolean;
    startEdge2?: boolean; // 是否启动第二个 Edge 服务器
    startAuth?: boolean;
  } = { startHub: true, startEdge: true, startEdge2: true, startAuth: true }
): Promise<TestEnvironment> {
  console.log('Setting up test environment...');
  
  let authServer: TestAuthServer | undefined;
  let hubProcess: ChildProcess | undefined;
  let edgeProcess: ChildProcess | undefined;
  let edgeProcess2: ChildProcess | undefined;
  const hubPort = port + 1000;
  const edgePort = port + 2000;
  const edgePort2 = port + 2100; // 第二个 Edge 端口

  // 1. 启动认证服务器（如果需要）
  if (options.startAuth !== false) {
    authServer = new TestAuthServer(port);
    await authServer.start();
    // 给认证服务器一点启动时间
    await sleep(100);
  }

  // 2. 启动 Hub 服务器（如果需要）
  if (options.startHub !== false) {
    try {
      const hubConfigPath = join(PROJECT_ROOT, 'config/hub-test.json');
      if (fs.existsSync(hubConfigPath)) {
        // 使用动态端口避免冲突
        const actualHubPort = port + 1000; // Hub使用8080+1000=9080
        const controlPort = port + 3000; // 控制端口使用8080+3000=11080
        const hubConfig = JSON.parse(fs.readFileSync(hubConfigPath, 'utf8'));
        hubConfig.port = actualHubPort;
        hubConfig.controlPort = controlPort; // 设置动态控制端口
        hubConfig.webApi.port = port + 100; // Web API使用8080+100=8180
        
        const tempHubConfigPath = join(PROJECT_ROOT, `config/hub-test-${port}.json`);
        fs.writeFileSync(tempHubConfigPath, JSON.stringify(hubConfig, null, 2));
        
        // 删除测试数据库文件以确保干净的状态
        const dbPath = join(PROJECT_ROOT, 'data/hub-test.db');
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
          console.log('Deleted existing test database file');
        }
        
        // 初始化测试数据库
        console.log('Initializing test database...');
        const initScript = join(PROJECT_ROOT, 'scripts/init-test-db.ts');
        if (fs.existsSync(initScript)) {
          const { spawn } = require('child_process');
          const initProcess = spawn('tsx', [initScript], {
            stdio: 'inherit',
            cwd: PROJECT_ROOT,
          });
          
          await new Promise<void>((resolve, reject) => {
            initProcess.on('exit', (code: number) => {
              if (code === 0) {
                console.log('Test database initialized successfully');
                resolve();
              } else {
                reject(new Error(`Database initialization failed with code ${code}`));
              }
            });
            initProcess.on('error', reject);
          });
        }
        
        // 等待数据库完全释放
        await sleep(1000);
        
        hubProcess = await startHubServer(tempHubConfigPath);
        await sleep(500); // 减少等待时间
        
        // 清理临时配置文件
        setTimeout(() => {
          try {
            fs.unlinkSync(tempHubConfigPath);
          } catch (error) {
            // 忽略清理错误
          }
        }, 1000);
      }
    } catch (error) {
      console.warn('Failed to start Hub server:', error);
    }
  }

  // 3. 启动第一个 Edge 服务器（如果需要）
  if (options.startEdge !== false) {
    try {
      const edgeConfigPath = join(PROJECT_ROOT, 'config/edge-test.json');
      if (fs.existsSync(edgeConfigPath)) {
        // 使用动态端口避免冲突
        const actualEdgePort = port + 2000; // Edge使用8080+2000=10080
        const actualHubPort = port + 1000; // Hub端口
        const controlPort = port + 3000; // 控制端口
        const edgeConfig = JSON.parse(fs.readFileSync(edgeConfigPath, 'utf8'));
        
        // 设置网络端口
        edgeConfig.network = edgeConfig.network || {};
        edgeConfig.network.port = actualEdgePort;
        edgeConfig.server = edgeConfig.server || {};
        edgeConfig.server.name = 'MuNode Edge Server 1 (Test)';
        edgeConfig.server.serverId = 1;
        
        // 配置 TLS 证书
        const certsDir = join(__dirname, 'certs');
        edgeConfig.tls = {
          cert: join(certsDir, 'server.pem'),
          key: join(certsDir, 'server.key'),
          ca: join(certsDir, 'ca.pem'),
          requireClientCert: false,
          rejectUnauthorized: false
        };
        
        // 配置 Hub 连接
        edgeConfig.hubServer = edgeConfig.hubServer || {};
        edgeConfig.hubServer.host = '127.0.0.1';
        edgeConfig.hubServer.port = actualHubPort;
        edgeConfig.hubServer.controlPort = controlPort;
        
        // 配置认证
        edgeConfig.auth = edgeConfig.auth || {};
        edgeConfig.auth.apiUrl = `http://127.0.0.1:${port}/auth`;
        
        const tempEdgeConfigPath = join(PROJECT_ROOT, `config/edge-test-${port}.json`);
        fs.writeFileSync(tempEdgeConfigPath, JSON.stringify(edgeConfig, null, 2));
        console.log(`Created temp edge config at ${tempEdgeConfigPath} with port ${actualEdgePort}`);
        
        edgeProcess = await startEdgeServer(tempEdgeConfigPath, actualEdgePort);
        await sleep(500); // 减少等待时间
        
        // 清理临时配置文件
        setTimeout(() => {
          try {
            fs.unlinkSync(tempEdgeConfigPath);
          } catch (error) {
            // 忽略清理错误
          }
        }, 2000);
      }
    } catch (error) {
      console.warn('Failed to start Edge server:', error);
    }
  }

  // 4. 启动第二个 Edge 服务器（如果需要，用于跨 Edge 测试）
  if (options.startEdge2 !== false) {
    try {
      const edgeConfigPath = join(PROJECT_ROOT, 'config/edge-test.json');
      if (fs.existsSync(edgeConfigPath)) {
        // 使用动态端口避免冲突
        const actualEdgePort2 = port + 2100; // Edge2使用8080+2100=10180
        const actualHubPort = port + 1000; // Hub端口
        const controlPort = port + 3000; // 控制端口
        const edgeConfig2 = JSON.parse(fs.readFileSync(edgeConfigPath, 'utf8'));
        
        // 设置网络端口
        edgeConfig2.network = edgeConfig2.network || {};
        edgeConfig2.network.port = actualEdgePort2;
        edgeConfig2.server = edgeConfig2.server || {};
        edgeConfig2.server.name = 'MuNode Edge Server 2 (Test)';
        edgeConfig2.server.serverId = 2;
        
        // 配置 TLS 证书
        const certsDir = join(__dirname, 'certs');
        edgeConfig2.tls = {
          cert: join(certsDir, 'server.pem'),
          key: join(certsDir, 'server.key'),
          ca: join(certsDir, 'ca.pem'),
          requireClientCert: false,
          rejectUnauthorized: false
        };
        
        // 配置 Hub 连接
        edgeConfig2.hubServer = edgeConfig2.hubServer || {};
        edgeConfig2.hubServer.host = '127.0.0.1';
        edgeConfig2.hubServer.port = actualHubPort;
        edgeConfig2.hubServer.controlPort = controlPort;
        
        // 配置认证
        edgeConfig2.auth = edgeConfig2.auth || {};
        edgeConfig2.auth.apiUrl = `http://127.0.0.1:${port}/auth`;
        
        const tempEdgeConfigPath2 = join(PROJECT_ROOT, `config/edge-test-${port}-2.json`);
        fs.writeFileSync(tempEdgeConfigPath2, JSON.stringify(edgeConfig2, null, 2));
        console.log(`Created temp edge config 2 at ${tempEdgeConfigPath2} with port ${actualEdgePort2}`);
        
        edgeProcess2 = await startEdgeServer(tempEdgeConfigPath2, actualEdgePort2);
        await sleep(500); // 减少等待时间
        
        // 清理临时配置文件
        setTimeout(() => {
          try {
            fs.unlinkSync(tempEdgeConfigPath2);
          } catch (error) {
            // 忽略清理错误
          }
        }, 2000);
      }
    } catch (error) {
      console.warn('Failed to start Edge server 2:', error);
    }
  }

  const cleanup = async () => {
    console.log('Cleaning up test environment...');

    if (edgeProcess2) {
      edgeProcess2.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        edgeProcess2!.on('exit', () => resolve());
        setTimeout(() => {
          edgeProcess2!.kill('SIGKILL');
          resolve();
        }, 2000); // 减少清理等待时间
      });
    }

    if (edgeProcess) {
      edgeProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        edgeProcess!.on('exit', () => resolve());
        setTimeout(() => {
          edgeProcess!.kill('SIGKILL');
          resolve();
        }, 2000); // 减少清理等待时间
      });
    }

    if (hubProcess) {
      hubProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        hubProcess!.on('exit', () => resolve());
        setTimeout(() => {
          hubProcess!.kill('SIGKILL');
          resolve();
        }, 2000); // 减少清理等待时间
      });
    }

    if (authServer) {
      await authServer.stop();
    }
    
    await sleep(100); // 减少最终清理等待时间
  };

  return { 
    hubProcess, 
    edgeProcess,
    edgeProcess2, 
    authServer: authServer?.getServer(),
    hubPort,
    edgePort,
    edgePort2,
    cleanup 
  };
}

/**
 * 等待指定时间
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
