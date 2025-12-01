/**
 * 集成测试环境设置
 */

import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import * as http from 'http';
import * as fs from 'fs';
import * as net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 获取项目根目录（从 tests/integration 向上两级）
const PROJECT_ROOT = join(__dirname, '../..');

// 测试调试日志控制
const TEST_DEBUG = process.env.TEST_DEBUG === '1' || process.env.TEST_VERBOSE === '1';

/**
 * 测试调试日志函数 - 只在 TEST_DEBUG=1 时输出
 */
export function debugLog(...args: any[]): void {
  if (TEST_DEBUG) {
    console.log('[TEST-DEBUG]', ...args);
  }
}

// Counter for cache busting in dynamic imports
let importCounter = 0;

// Global test environment for sharing across parallel tests
let globalTestEnvironment: TestEnvironment | null = null;
let refCount = 0;

/**
 * 检查端口是否可用
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

/**
 * 查找可用端口，从指定端口开始递增
 */
export async function findAvailablePort(startPort: number = 8080, maxAttempts: number = 100): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports found starting from ${startPort}`);
}

export interface TestEnvironment {
  hubProcess?: ChildProcess;
  edgeProcess?: ChildProcess;
  edgeProcess2?: ChildProcess; // 第二个 Edge 服务器用于跨 Edge 测试
  authServer?: http.Server;
  authPort: number;
  hubPort: number;
  edgePort: number;
  edgeUdpPort: number; // Edge1 的 UDP 端口
  edgePort2: number; // 第二个 Edge 服务器端口
  edgeUdpPort2: number; // Edge2 的 UDP 端口
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
      // Ninja group users - have access to ninja channels
      'ninja_user1': { password: 'ninja_password', user_id: 15, groups: ['ninja'] },
      'ninja_user2': { password: 'ninja_password', user_id: 16, groups: ['ninja'] },
      'ninja_cross': { password: 'ninja_password', user_id: 17, groups: ['ninja'] },
      'user1': { password: 'password1', user_id: 2 },
      'user1_password': { password: 'user1_password', user_id: 21 },
      'user2': { password: 'password2', user_id: 3 },
      'user2_password': { password: 'user2_password', user_id: 22 },
      'user3': { password: 'password3', user_id: 5 },
      'guest': { password: 'guest123', user_id: 4 },
      'user_edge1': { password: 'user_password', user_id: 31 },
      'user_edge2': { password: 'user_password', user_id: 32 },
      'user_state': { password: 'user_password', user_id: 33 },
      'user_no_ninja': { password: 'user_password', user_id: 34 },
      // Cross-edge ninja test users
      'user_cross1': { password: 'user_password', user_id: 35 },
      'user_cross2': { password: 'user_password', user_id: 36 },
      'mixed_tcp1': { password: 'password1', user_id: 41 },
      'mixed_tcp2': { password: 'password2', user_id: 42 },
      'mixed_udp': { password: 'password3', user_id: 43 },
      'whisper_nontarget': { password: 'password3', user_id: 44 },
      'cross_edge_tcp1': { password: 'password1', user_id: 51 },
      'cross_edge_tcp2': { password: 'password2', user_id: 52 },
      'fallback_user': { password: 'fallback_pass', user_id: 53 },
      'large_packet_user': { password: 'large_pass', user_id: 54 },
      'packet_format_user': { password: 'packet_pass', user_id: 55 },
      'perf_test_user': { password: 'perf_pass', user_id: 56 },
      'random_payload_user': { password: 'random_pass', user_id: 57 },
      'tcp_receiver': { password: 'tcp_receiver_pass', user_id: 58 },
      'tcp_sender': { password: 'tcp_sender_pass', user_id: 59 },
      'tcp_to_udp_receiver': { password: 'receiver_pass', user_id: 60 },
      'tcp_to_udp_sender': { password: 'sender_pass', user_id: 61 },
      'tcp_user': { password: 'tcp_pass', user_id: 62 },
      'udp_to_tcp_receiver': { password: 'receiver_pass', user_id: 63 },
      'udp_to_tcp_sender': { password: 'sender_pass', user_id: 64 },
      'banned_user': { password: 'password1', user_id: 71 },
      'codec_receiver': { password: 'password1', user_id: 72 },
      'codec_sender': { password: 'password1', user_id: 73 },
      'random_receiver': { password: 'password1', user_id: 74 },
      'random_sender': { password: 'password1', user_id: 75 },
      'receiver1': { password: 'password1', user_id: 76 },
      'receiver1_e1': { password: 'password1', user_id: 77 },
      'receiver1_e2': { password: 'password1', user_id: 78 },
      'receiver2': { password: 'password2', user_id: 79 },
      'receiver_edge1': { password: 'password1', user_id: 80 },
      'receiver_edge2': { password: 'password1', user_id: 81 },
      'routing_sender': { password: 'password1', user_id: 82 },
      'same_channel': { password: 'password1', user_id: 83 },
      'sender1': { password: 'password1', user_id: 84 },
      'sender1_e1': { password: 'password1', user_id: 85 },
      'sender1_e2': { password: 'password1', user_id: 86 },
      'sender2': { password: 'password2', user_id: 87 },
      'sender_edge1': { password: 'password1', user_id: 88 },
      'sender_edge2': { password: 'password1', user_id: 89 },
      'whisper_sender': { password: 'password1', user_id: 90 },
      'whisper_target': { password: 'password2', user_id: 91 },
      'moderator': { password: 'mod123', user_id: 92, groups: ['moderator'] },
      // Voice test users
      'voice_sender': { password: 'pass1', user_id: 101 },
      'voice_recv_e1_same': { password: 'pass2', user_id: 102 },
      'voice_recv_e2_same': { password: 'pass3', user_id: 103 },
      'voice_recv_e1_other': { password: 'pass4', user_id: 104 },
      'voice_recv_e2_other': { password: 'pass5', user_id: 105 },
      'voice_sender2': { password: 'pass1', user_id: 106 },
      'voice_deaf_e1': { password: 'pass2', user_id: 107 },
      'voice_deaf_e2': { password: 'pass3', user_id: 108 },
      'voice_normal_e1': { password: 'pass4', user_id: 109 },
      'voice_sender3': { password: 'pass1', user_id: 110 },
      'voice_recv_e1_ch0': { password: 'pass2', user_id: 111 },
      'voice_recv_e2_ch0': { password: 'pass3', user_id: 112 },
      'voice_recv_e1_ch1': { password: 'pass4', user_id: 113 },
      'voice_recv_e2_ch1': { password: 'pass5', user_id: 114 },
      'voice_recv_e1_ch2': { password: 'pass6', user_id: 115 },
      'voice_whisper_sender': { password: 'pass1', user_id: 116 },
      'voice_target1_e1': { password: 'pass2', user_id: 117 },
      'voice_target1_e2': { password: 'pass3', user_id: 118 },
      'voice_non_target_e1': { password: 'pass4', user_id: 119 },
      'voice_non_target_e2': { password: 'pass5', user_id: 120 },
      'voice_ch_target_sender': { password: 'pass1', user_id: 121 },
      'voice_recv_e1_tch1': { password: 'pass2', user_id: 122 },
      'voice_recv_e2_tch1': { password: 'pass3', user_id: 123 },
      'voice_recv_e1_tch0': { password: 'pass4', user_id: 124 },
      'voice_recv_e1_tch2': { password: 'pass5', user_id: 125 },
      'voice_loopback_sender': { password: 'pass1', user_id: 126 },
      'voice_loopback_other': { password: 'pass2', user_id: 127 },
      'voice_multi_sender': { password: 'pass1', user_id: 128 },
      'voice_multi_recv_e1': { password: 'pass2', user_id: 129 },
      'voice_multi_recv_e2': { password: 'pass3', user_id: 130 },
      'voice_complex_sender': { password: 'pass1', user_id: 131 },
      'voice_complex_e1_ch0': { password: 'pass2', user_id: 132 },
      'voice_complex_e2_ch1': { password: 'pass3', user_id: 133 },
      'voice_whisper_tgt_e2': { password: 'pass4', user_id: 134 },
      'voice_deaf_e1_ch0': { password: 'pass5', user_id: 135 },
      'voice_normal_e1_ch2': { password: 'pass6', user_id: 136 },
      // UDP connection test users
      'udp_test_user1': { password: 'password123', user_id: 201 },
      'udp_sender': { password: 'password123', user_id: 202 },
      'udp_receiver': { password: 'password123', user_id: 203 },
      'tcp_fallback_user': { password: 'password123', user_id: 204 },
      'udp_ping_test': { password: 'password123', user_id: 205 },
      'udp_multi_sender': { password: 'password123', user_id: 206 },
      'udp_multi_receiver': { password: 'password123', user_id: 207 },
      // Voice routing test users
      'routing_config_test': { password: 'pass1', user_id: 301 },
      'rtt_sender': { password: 'pass1', user_id: 302 },
      'rtt_receiver': { password: 'pass2', user_id: 303 },
      'loss_sender': { password: 'pass1', user_id: 304 },
      'loss_receiver': { password: 'pass2', user_id: 305 },
      'direct_sender': { password: 'pass1', user_id: 306 },
      'direct_receiver': { password: 'pass2', user_id: 307 },
      'tcp_fallback_sender': { password: 'pass1', user_id: 308 },
      'tcp_fallback_receiver': { password: 'pass2', user_id: 309 },
      'route_table_test': { password: 'pass1', user_id: 310 },
      'cross_edge_sender': { password: 'pass1', user_id: 311 },
      'cross_edge_receiver': { password: 'pass2', user_id: 312 },
      'deaf_test_sender': { password: 'pass1', user_id: 313 },
      'deaf_test_deaf': { password: 'pass2', user_id: 314 },
      'deaf_test_normal': { password: 'pass3', user_id: 315 },
      'hub_bypass_sender': { password: 'pass1', user_id: 316 },
      'hub_bypass_receiver': { password: 'pass2', user_id: 317 },
      'stress_sender': { password: 'pass1', user_id: 318 },
      'stress_receiver': { password: 'pass2', user_id: 319 },
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
export async function startHubServer(configPath?: string, maxRetries: number = 3, silent: boolean = true): Promise<ChildProcess> {
  const hubPath = join(PROJECT_ROOT, 'packages/hub-server/dist/cli.js');
  const config = configPath || join(PROJECT_ROOT, 'config/hub.json');

  // 确保构建产物存在
  if (!fs.existsSync(hubPath)) {
    throw new Error(`Hub server binary not found at ${hubPath}. Run 'pnpm build' first.`);
  }

  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const hubProcess = spawn('node', [hubPath, config], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'info', // 设置为 info 级别以查看关键日志
        },
        stdio: silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], // 始终使用 pipe 以捕获启动信息
      });

      // 等待服务器启动
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Hub server startup timeout'));
        }, 10000); // 减少到10秒

        let startupDetected = false;
        
        const checkStartup = (data: Buffer) => {
          const message = data.toString();
          // 只在非 silent 模式下输出日志
          if (!silent) {
            process.stdout.write(data); // 转发到控制台
          }
          if (message.includes('Hub Server started successfully') || 
              message.includes('Control channel server listening')) {
            if (!startupDetected) {
              startupDetected = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        };

        hubProcess.stdout?.on('data', checkStartup);
        hubProcess.stderr?.on('data', checkStartup);

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
    } catch (error) {
      lastError = error as Error;
      console.warn(`Hub server start attempt ${attempt} failed:`, error);
      if (attempt < maxRetries) {
        await sleep(1000); // 等待1秒后重试
      }
    }
  }
  
  throw new Error(`Failed to start Hub server after ${maxRetries} attempts. Last error: ${lastError?.message}`);
}

/**
 * 启动 Edge 服务器用于测试
 */
export async function startEdgeServer(configPath?: string, port?: number, maxRetries: number = 3, silent: boolean = true): Promise<ChildProcess> {
  const edgePath = join(PROJECT_ROOT, 'packages/edge-server/dist/cli.js');
  const config = configPath || join(PROJECT_ROOT, 'config/edge.example.json');

  // 确保构建产物存在
  if (!fs.existsSync(edgePath)) {
    throw new Error(`Edge server binary not found at ${edgePath}. Run 'pnpm build' first.`);
  }

  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const args = [edgePath, 'start', '-c', configPath || config];
      if (port) {
        args.push('-p', port.toString());
      }
      const edgeProcess = spawn('node', args, {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'info', // 设置为 info 级别以查看关键日志
        },
        stdio: silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], // 始终使用 pipe 以捕获启动信息
      });

      // 等待服务器启动
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Edge server startup timeout'));
        }, 10000); // 减少到10秒

        let startupDetected = false;
        
        const checkStartup = (data: Buffer) => {
          const message = data.toString();
          // 只在非 silent 模式下输出日志
          if (!silent) {
            process.stdout.write(data); // 转发到控制台
          }
          if (message.includes('Edge Server started successfully') || 
              message.includes('TLS Server listening') || 
              message.includes('UDP Server listening')) {
            if (!startupDetected) {
              startupDetected = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        };

        edgeProcess.stdout?.on('data', checkStartup);
        edgeProcess.stderr?.on('data', checkStartup);

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
    } catch (error) {
      lastError = error as Error;
      console.warn(`Edge server start attempt ${attempt} failed:`, error);
      if (attempt < maxRetries) {
        await sleep(1000); // 等待1秒后重试
      }
    }
  }
  
  throw new Error(`Failed to start Edge server after ${maxRetries} attempts. Last error: ${lastError?.message}`);
}/**
 * 设置完整的测试环境 (Auth Server + Hub + Edge)
 */
export async function setupTestEnvironment(
  basePort: number = 8080,
  options: {
    startHub?: boolean;
    startEdge?: boolean;
    startEdge2?: boolean; // Whether to start the second Edge server
    startAuth?: boolean;
    hubConfig?: Record<string, any>; // Custom Hub configuration
    reuse?: boolean; // Whether to reuse existing global test environment
    silent?: boolean; // Whether to suppress server output logs (default: true for speed)
  } = { startHub: true, startEdge: true, startEdge2: true, startAuth: true, reuse: true, silent: true }
): Promise<TestEnvironment> {
  // Check if we should reuse the global test environment
  if (globalTestEnvironment && options.reuse !== false) {
    refCount++;
    console.log(`Reusing existing test environment (refCount: ${refCount})`);
    return globalTestEnvironment;
  }

  // 从环境变量读取 silent 选项，默认为 true（静默）
  const silent = options.silent ?? (process.env.TEST_VERBOSE !== '1');

  console.log('Setting up test environment...');
  
  let authServer: TestAuthServer | undefined;
  let hubProcess: ChildProcess | undefined;
  let edgeProcess: ChildProcess | undefined;
  let edgeProcess2: ChildProcess | undefined;
  
  // 动态分配端口 - 每个 Edge 需要两个连续端口 (TLS + UDP)
  const authPort = options.startAuth !== false ? await findAvailablePort(basePort) : 0;
  const hubPort = options.startHub !== false ? await findAvailablePort(authPort + 1) : 0;
  const controlPort = options.startHub !== false ? await findAvailablePort(hubPort + 1) : 0;
  const webApiPort = options.startHub !== false ? await findAvailablePort(controlPort + 1) : 0;
  const hubVoicePort = options.startHub !== false ? await findAvailablePort(webApiPort + 1) : 0;
  
  // Edge1: TLS port and UDP port (consecutive)
  const edgeBasePort = Math.max(hubVoicePort, basePort - 1);
  const edgePort = options.startEdge !== false ? await findAvailablePort(edgeBasePort + 1) : 0;
  const edgeUdpPort = edgePort > 0 ? edgePort + 1 : 0;
  
  // Edge2: TLS port and UDP port (consecutive, after Edge1)
  const edgePort2 = (options.startEdge2 === true && edgePort > 0) ? await findAvailablePort(edgeUdpPort + 1) : 0;
  const edgeUdpPort2 = edgePort2 > 0 ? edgePort2 + 1 : 0;
  
  console.log(`Allocated ports - Auth: ${authPort}, Hub: ${hubPort}(TCP)/${hubVoicePort}(UDP), Control: ${controlPort}, WebAPI: ${webApiPort}, Edge1: ${edgePort}(TLS)/${edgeUdpPort}(UDP), Edge2: ${edgePort2}(TLS)/${edgeUdpPort2}(UDP)`);

  // 1. Start auth server (if needed)
  if (options.startAuth !== false) {
    authServer = new TestAuthServer(authPort);
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
        const actualHubPort = hubPort; // Hub uses dynamic port
        const actualControlPort = controlPort; // Control port uses dynamic port
        
        // Load the JS config file
        const hubConfigModule = await import(`file://${hubConfigPath}?v=${++importCounter}`);
        const hubConfig = { ...(hubConfigModule.default || hubConfigModule) };
        
        hubConfig.port = actualHubPort;
        hubConfig.controlPort = actualControlPort; // Set dynamic control port
        hubConfig.webApi.port = webApiPort; // Web API uses dynamic port
        hubConfig.voicePort = hubVoicePort; // Set dynamic voice port
        
        // Configure auth (pointing to test auth server)
        hubConfig.auth = hubConfig.auth || {};
        hubConfig.auth.apiUrl = `http://127.0.0.1:${authPort}/auth`;
        
        // Apply custom Hub config
        if (options.hubConfig) {
          Object.assign(hubConfig, options.hubConfig);
        }
        
        const tempHubConfigPath = join(PROJECT_ROOT, `tests/config/hub-test-${basePort}.js`);
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
        
        hubProcess = await startHubServer(tempHubConfigPath, 3, silent);
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
        const actualEdgePort = edgePort; // Edge使用动态端口
        const actualHubPort = hubPort; // Hub端口
        const actualControlPort = controlPort; // 控制端口
        
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
        
        const tempEdgeConfigPath = join(PROJECT_ROOT, `tests/config/edge-test-${basePort}.js`);
        fs.writeFileSync(tempEdgeConfigPath, `export default ${JSON.stringify(edgeConfig, null, 2)};`);
        console.log(`Created temp edge config at ${tempEdgeConfigPath} with port ${actualEdgePort}`);
        
        edgeProcess = await startEdgeServer(tempEdgeConfigPath, actualEdgePort, 3, silent);
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
        const actualEdgePort2 = edgePort2; // Edge2使用动态端口
        const actualHubPort = hubPort; // Hub端口
        const actualControlPort = controlPort; // 控制端口
        
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
        
        const tempEdgeConfigPath2 = join(PROJECT_ROOT, `tests/config/edge-test-${basePort}-2.js`);
        fs.writeFileSync(tempEdgeConfigPath2, `export default ${JSON.stringify(edgeConfig2, null, 2)};`);
        console.log(`Created temp edge config 2 at ${tempEdgeConfigPath2} with port ${actualEdgePort2}`);
        
        edgeProcess2 = await startEdgeServer(tempEdgeConfigPath2, actualEdgePort2, 3, silent);
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

  const realCleanup = async () => {
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
    
    // 等待端口释放 - 增加等待时间确保端口完全释放
    await sleep(500);
    
    // 验证端口是否已释放（可选，用于调试）
    const portsToCheck = [authPort, hubPort, edgePort, edgePort2, controlPort, webApiPort].filter(p => p > 0);
    for (const port of portsToCheck) {
      let attempts = 0;
      while (attempts < 10 && !(await isPortAvailable(port))) {
        await sleep(100);
        attempts++;
      }
      if (!(await isPortAvailable(port))) {
        console.warn(`Warning: Port ${port} may still be in use after cleanup`);
      }
    }
  };

  // Set up the global environment
  refCount = 1;
  globalTestEnvironment = { 
    hubProcess, 
    edgeProcess,
    edgeProcess2, 
    authServer: authServer?.getServer(),
    authPort,
    hubPort,
    edgePort,
    edgeUdpPort,
    edgePort2,
    edgeUdpPort2,
    cleanup: async () => {
      refCount--;
      console.log(`Test environment cleanup called (refCount: ${refCount})`);
      if (refCount === 0) {
        await realCleanup();
        globalTestEnvironment = null;
      }
    }
  };

  return globalTestEnvironment;
}

/**
 * 等待指定时间
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Global cleanup handlers to ensure servers are stopped on process exit
process.on('beforeExit', async () => {
  if (globalTestEnvironment && refCount > 0) {
    console.log('Process beforeExit: Cleaning up test environment...');
    refCount = 0;
    try {
      // Perform real cleanup directly
      const env = globalTestEnvironment;
      globalTestEnvironment = null;
      
      if (env.authServer) {
        try {
          await (env.authServer as any).stop?.();
        } catch (error) {
          console.warn('Error stopping auth server on exit:', error);
        }
      }

      const killProcess = async (process: ChildProcess | undefined, name: string) => {
        if (!process) return;
        try {
          process.kill('SIGTERM');
          await new Promise<void>((resolve) => {
            process.once('exit', () => resolve());
            setTimeout(() => {
              try {
                process.kill('SIGKILL');
              } catch (e) {
                // Process may have already exited
              }
              resolve();
            }, 2000);
          });
        } catch (error) {
          console.warn(`Error killing ${name} on exit:`, error);
        }
      };

      await killProcess(env.edgeProcess2, 'Edge2');
      await killProcess(env.edgeProcess, 'Edge');
      await killProcess(env.hubProcess, 'Hub');
      
      await sleep(500); // Wait for ports to be released
    } catch (error) {
      console.warn('Error during global cleanup:', error);
    }
  }
});
