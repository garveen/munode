/**
 * 集成测试环境设置
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import * as http from 'http';
import * as fs from 'fs';

export interface TestEnvironment {
  hubProcess?: ChildProcess;
  edgeProcess?: ChildProcess;
  authServer?: http.Server;
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
  const hubPath = join(__dirname, '../../packages/hub-server/dist/cli.js');
  const config = configPath || join(__dirname, '../../config/hub.json');

  // 确保构建产物存在
  if (!fs.existsSync(hubPath)) {
    throw new Error(`Hub server binary not found at ${hubPath}. Run 'pnpm build' first.`);
  }

  const hubProcess = spawn('node', [hubPath, '--config', config], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error', // 减少测试输出
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 等待服务器启动
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Hub server startup timeout'));
    }, 30000);

    hubProcess.stdout?.on('data', (data: Buffer) => {
      const message = data.toString();
      if (message.includes('started') || message.includes('listening') || message.includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });

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
export async function startEdgeServer(configPath?: string): Promise<ChildProcess> {
  const edgePath = join(__dirname, '../../packages/edge-server/dist/cli.js');
  const config = configPath || join(__dirname, '../../config/edge.example.json');

  // 确保构建产物存在
  if (!fs.existsSync(edgePath)) {
    throw new Error(`Edge server binary not found at ${edgePath}. Run 'pnpm build' first.`);
  }

  const edgeProcess = spawn('node', [edgePath, '--config', config], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error', // 减少测试输出
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 等待服务器启动
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Edge server startup timeout'));
    }, 30000);

    edgeProcess.stdout?.on('data', (data: Buffer) => {
      const message = data.toString();
      if (message.includes('started') || message.includes('listening') || message.includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });

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
export async function setupTestEnvironment(): Promise<TestEnvironment> {
  console.log('Setting up test environment...');
  
  // 1. 启动认证服务器
  const authServer = new TestAuthServer(8080);
  await authServer.start();
  
  // 给认证服务器一点启动时间
  await sleep(500);

  // 2. 启动 Hub 服务器
  // 注意：由于没有配置文件，这里暂时跳过实际启动
  // 在实际使用中，需要先创建配置文件
  let hubProcess: ChildProcess | undefined;
  let edgeProcess: ChildProcess | undefined;

  try {
    // 如果配置文件存在，则启动服务器
    const hubConfigPath = join(__dirname, '../../config/hub-test.json');
    if (fs.existsSync(hubConfigPath)) {
      hubProcess = await startHubServer(hubConfigPath);
      await sleep(2000); // 等待 Hub 完全启动
    }

    const edgeConfigPath = join(__dirname, '../../config/edge-test.json');
    if (fs.existsSync(edgeConfigPath)) {
      edgeProcess = await startEdgeServer(edgeConfigPath);
      await sleep(2000); // 等待 Edge 完全启动
    }
  } catch (error) {
    console.warn('Failed to start servers (this is expected if config files are missing):', error);
  }

  const cleanup = async () => {
    console.log('Cleaning up test environment...');

    if (edgeProcess) {
      edgeProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        edgeProcess!.on('exit', () => resolve());
        setTimeout(() => {
          edgeProcess!.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    }

    if (hubProcess) {
      hubProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        hubProcess!.on('exit', () => resolve());
        setTimeout(() => {
          hubProcess!.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    }

    await authServer.stop();
    await sleep(500); // 确保所有资源释放
  };

  return { 
    hubProcess, 
    edgeProcess, 
    authServer: authServer.getServer(),
    cleanup 
  };
}

/**
 * 等待指定时间
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
