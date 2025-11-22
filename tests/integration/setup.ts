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

// Counter for cache busting in dynamic imports
let importCounter = 0;

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
          let authReq: any;
          const contentType = req.headers['content-type'] || '';
          
          if (contentType.includes('application/x-www-form-urlencoded')) {
            // 解析 form-urlencoded 格式
            authReq = this.parseFormData(body);
          } else {
            // 解析 JSON 格式
            authReq = JSON.parse(body);
          }
          
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

  private parseFormData(body: string): any {
    const params = new URLSearchParams(body);
    const result: any = {};
    const arrays: Record<string, string[]> = {};
    
    for (const [key, value] of params.entries()) {
      if (key.endsWith('[]')) {
        const arrayKey = key.slice(0, -2);
        if (!arrays[arrayKey]) {
          arrays[arrayKey] = [];
        }
        if (value) { // 忽略空字符串
          arrays[arrayKey].push(value);
        }
      } else {
        result[key] = value;
      }
    }
    
    // 将数组添加到结果中
    for (const [key, values] of Object.entries(arrays)) {
      result[key] = values;
    }
    
    // 确保 tokens 数组存在
    if (!result.tokens) {
      result.tokens = [];
    }
    
    // 转换数字字段
    if (result.server_id) {
      result.server_id = parseInt(result.server_id, 10);
    }
    
    return result;
  }

  private authenticate(req: any): any {
    // Test user data
    const users: Record<string, { password: string; user_id: number; groups?: string[] }> = {
      'admin': { password: 'admin123', user_id: 1, groups: ['admin'] },
      'admin_password': { password: 'admin_password', user_id: 11, groups: ['admin'] },
      'admin_multi': { password: 'admin_password', user_id: 12, groups: ['admin'] },
      'admin_state': { password: 'admin_password', user_id: 13, groups: ['admin'] },
      'admin_no_ninja': { password: 'admin_password', user_id: 14, groups: ['admin'] },
      'user1': { password: 'password1', user_id: 2 },
      'user1_password': { password: 'user1_password', user_id: 21 },
      'user2': { password: 'password2', user_id: 3 },
      'user2_password': { password: 'user2_password', user_id: 22 },
      'guest': { password: 'guest123', user_id: 4 },
      'user_edge1': { password: 'user_password', user_id: 31 },
      'user_edge2': { password: 'user_password', user_id: 32 },
      'user_state': { password: 'user_password', user_id: 33 },
      'user_no_ninja': { password: 'user_password', user_id: 34 },
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
      groups: user.groups || ['user'],
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error) => {
        reject(error);
      };

      this.server.once('error', errorHandler);
      
      this.server.listen(this.port, () => {
        this.server.removeListener('error', errorHandler);
        console.log(`Test auth server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) {
          console.warn('Error closing auth server:', err.message);
        }
        resolve();
      });
      // 强制关闭所有连接
      this.server.closeAllConnections?.();
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
    startEdge2?: boolean; // Whether to start the second Edge server
    startAuth?: boolean;
    hubConfig?: Record<string, any>; // Custom Hub configuration
  } = { startHub: true, startEdge: true, startEdge2: true, startAuth: true }
): Promise<TestEnvironment> {
  console.log('Setting up test environment...');
  
  let authServer: TestAuthServer | undefined;
  let hubProcess: ChildProcess | undefined;
  let edgeProcess: ChildProcess | undefined;
  let edgeProcess2: ChildProcess | undefined;
  const hubPort = port + 1000;
  const edgePort = port + 2000;
  const edgePort2 = port + 2100; // Second Edge port

  // 1. Start auth server (if needed)
  if (options.startAuth !== false) {
    authServer = new TestAuthServer(port);
    await authServer.start();
    // Give auth server a bit of startup time
    await sleep(100);
  }

  // 2. Start Hub server (if needed)
  if (options.startHub !== false) {
    try {
      const hubConfigPath = join(PROJECT_ROOT, 'tests/config/hub-test.js');
      if (fs.existsSync(hubConfigPath)) {
        // Use dynamic ports to avoid conflicts
        const actualHubPort = port + 1000; // Hub uses 8080+1000=9080
        const controlPort = port + 3000; // Control port uses 8080+3000=11080
        
        // Load the JS config file
        const hubConfigModule = await import(`file://${hubConfigPath}?v=${++importCounter}`);
        const hubConfig = { ...(hubConfigModule.default || hubConfigModule) };
        
        hubConfig.port = actualHubPort;
        hubConfig.controlPort = controlPort; // Set dynamic control port
        hubConfig.webApi.port = port + 100; // Web API uses 8080+100=8180
        
        // Configure auth (pointing to test auth server)
        hubConfig.auth = hubConfig.auth || {};
        hubConfig.auth.apiUrl = `http://127.0.0.1:${port}/auth`;
        
        // Apply custom Hub config
        if (options.hubConfig) {
          Object.assign(hubConfig, options.hubConfig);
        }
        
        const tempHubConfigPath = join(PROJECT_ROOT, `tests/config/hub-test-${port}.js`);
        fs.writeFileSync(tempHubConfigPath, `export default ${JSON.stringify(hubConfig, null, 2)};`);
        
        // Delete test database file to ensure clean state
        const dbPath = join(PROJECT_ROOT, 'data/hub-test.db');
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
          console.log('Deleted existing test database file');
        }
        
        // Initialize test database
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
      const edgeConfigPath = join(PROJECT_ROOT, 'tests/config/edge-test.js');
      if (fs.existsSync(edgeConfigPath)) {
        // 使用动态端口避免冲突
        const actualEdgePort = port + 2000; // Edge使用8080+2000=10080
        const actualHubPort = port + 1000; // Hub端口
        const controlPort = port + 3000; // 控制端口
        
        // Load the JS config file
        const edgeConfigModule = await import(`file://${edgeConfigPath}?v=${++importCounter}`);
        const edgeConfig = { ...(edgeConfigModule.default || edgeConfigModule) };
        
        // 设置服务器 ID
        edgeConfig.server_id = 1;
        
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
        
        // 移除直接的认证 API 配置（现在通过 Hub 认证）
        edgeConfig.auth = edgeConfig.auth || {};
        delete edgeConfig.auth.apiUrl;
        
        const tempEdgeConfigPath = join(PROJECT_ROOT, `tests/config/edge-test-${port}.js`);
        fs.writeFileSync(tempEdgeConfigPath, `export default ${JSON.stringify(edgeConfig, null, 2)};`);
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
      const edgeConfigPath = join(PROJECT_ROOT, 'tests/config/edge-test.js');
      if (fs.existsSync(edgeConfigPath)) {
        // 使用动态端口避免冲突
        const actualEdgePort2 = port + 2100; // Edge2使用8080+2100=10180
        const actualHubPort = port + 1000; // Hub端口
        const controlPort = port + 3000; // 控制端口
        
        // Load the JS config file (use counter for cache busting)
        const edgeConfigModule2 = await import(`file://${edgeConfigPath}?v=${++importCounter}`);
        const edgeConfig2 = { ...(edgeConfigModule2.default || edgeConfigModule2) };
        
        // 设置服务器 ID
        edgeConfig2.server_id = 2;
        
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
        
        // 移除直接的认证 API 配置（现在通过 Hub 认证）
        edgeConfig2.auth = edgeConfig2.auth || {};
        delete edgeConfig2.auth.apiUrl;
        
        const tempEdgeConfigPath2 = join(PROJECT_ROOT, `tests/config/edge-test-${port}-2.js`);
        fs.writeFileSync(tempEdgeConfigPath2, `export default ${JSON.stringify(edgeConfig2, null, 2)};`);
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

    // 先关闭认证服务器，它不依赖其他服务
    if (authServer) {
      try {
        await authServer.stop();
      } catch (error) {
        console.warn('Error stopping auth server:', error);
      }
    }

    // 关闭 Edge 服务器
    const killProcess = async (process: ChildProcess | undefined, name: string) => {
      if (!process) return;
      
      try {
        process.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const exitHandler = () => {
            resolve();
          };
          process.once('exit', exitHandler);
          
          setTimeout(() => {
            process.removeListener('exit', exitHandler);
            try {
              process.kill('SIGKILL');
            } catch (e) {
              // 进程可能已退出
            }
            resolve();
          }, 2000);
        });
      } catch (error) {
        console.warn(`Error killing ${name}:`, error);
      }
    };

    await killProcess(edgeProcess2, 'Edge2');
    await killProcess(edgeProcess, 'Edge');
    await killProcess(hubProcess, 'Hub');
    
    // 等待端口释放
    await sleep(200);
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
