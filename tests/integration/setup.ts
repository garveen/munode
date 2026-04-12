/**
 * 集成测试环境设置 - 单进程模式
 */

import { join, dirname } from 'path';
import * as http from 'http';
import * as fs from 'fs';
import * as net from 'net';
import { fileURLToPath } from 'url';
import { EdgeServer } from '../../packages/edge-server/src/index.js';
import { HubServer } from '../../packages/hub-server/src/index.js';
import type { EdgeConfig } from '../../packages/edge-server/src/types.js';
import type { HubConfig } from '../../packages/hub-server/src/types.js';
import { MumbleClient } from '../../packages/client/src/index.js';
import { testUserPasswords } from './test-users.js';
import { spawn, ChildProcess } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

// ── Rust Edge config types ────────────────────────────────────────────────────

/** Hub server connection configuration section used in Rust Edge config files. */
interface RustHubServerConfig {
  host: string;
  control_port: number;
  hmac_secret: string;
  reconnect_interval?: number;
  heartbeat_interval?: number;
  pool_size?: number;
  relay_port?: number;
  static_peers?: Array<{ host: string; relay_port: number }>;
}

/** Subset of the Rust Edge server JSON config that is relevant to test setup. */
interface RustEdgeConfig {
  server_id: number;
  name: string;
  network: {
    host: string;
    port: number;
    edge_port: number;
    external_host: string;
  };
  tls: {
    cert: string;
    key: string;
    ca: string;
  };
  hub_server: RustHubServerConfig;
  server: {
    capacity: number;
    max_bandwidth: number;
  };
  log_level: string;
  [key: string]: unknown; // allow extra fields from extraConfig
}

/** Extra config fields that may be merged into the generated RustEdgeConfig. */
export interface RustEdgeExtraConfig {
  hub_server?: Partial<RustHubServerConfig>;
  [key: string]: unknown;
}

// 测试调试日志控制
const TEST_DEBUG = process.env.TEST_DEBUG === '1' || process.env.TEST_VERBOSE === '1';

/**
 * 是否使用 Rust 实现（默认启用；通过环境变量 MUNODE_USE_TS=1 切换回 TypeScript 实现）
 */
export const USE_RUST = process.env.MUNODE_USE_TS !== '1';

if (!USE_RUST) {
  console.log('[TS MODE] Using TypeScript in-process servers (set MUNODE_USE_TS=1)');
} else {
  console.log('[RUST MODE] Using Rust binaries for Hub and Edge servers (default)');
}

/**
 * 查找 Rust 二进制文件路径
 */
function findRustBinary(name: string): string {
  const debugPath = join(PROJECT_ROOT, `rust/target/debug/${name}`);
  const releasePath = join(PROJECT_ROOT, `rust/target/release/${name}`);
  if (fs.existsSync(debugPath)) return debugPath;
  if (fs.existsSync(releasePath)) return releasePath;
  throw new Error(
    `Rust binary '${name}' not found. Run 'cargo build' in the rust/ directory first.\n` +
    `Checked: ${releasePath}\n        ${debugPath}`
  );
}

/**
 * Rust 服务进程封装，提供 stop/restart 接口
 */
export class RustServerProcess {
  private proc: ChildProcess | null = null;
  private readonly bin: string;
  private readonly configPath: string;
  private readonly label: string;
  private readonly silent: boolean;

  constructor(bin: string, configPath: string, label: string, silent: boolean = true) {
    this.bin = bin;
    this.configPath = configPath;
    this.label = label;
    this.silent = silent;
  }

  /** 启动进程（若已运行则先停止） */
  async start(): Promise<void> {
    if (this.proc) await this.stop();
    this.proc = spawn(this.bin, [this.configPath], {
      stdio: this.silent ? 'ignore' : 'inherit',
    });
    this.proc.on('error', (err) => {
      console.error(`[RUST] ${this.label} process error:`, err);
    });
    debugLog(`[RUST] Started ${this.label} (pid=${this.proc.pid})`);
  }

  /** 停止进程 */
  async stop(): Promise<void> {
    if (!this.proc) return;
    const pid = this.proc.pid;
    return new Promise<void>((resolve) => {
      if (!this.proc) { resolve(); return; }
      this.proc.once('exit', () => {
        this.proc = null;
        debugLog(`[RUST] ${this.label} (pid=${pid}) stopped`);
        resolve();
      });
      try {
        this.proc.kill('SIGTERM');
      } catch {
        this.proc = null;
        resolve();
      }
      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.proc) {
          try { this.proc.kill('SIGKILL'); } catch {}
          this.proc = null;
          resolve();
        }
      }, 5000);
    });
  }

  /** 重启进程 */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}

/**
 * 生成 Rust Hub JSON 配置
 */
function generateRustHubConfig(params: {
  controlPort: number;
  webApiPort: number;
  dbPath: string;
  blobStorePath: string;
  authHttpUrl: string;
  hmacSecret: string;
  logLevel: string;
  /** Optional overrides merged into the generated config */
  extraConfig?: Record<string, unknown>;
}): object {
  const base: Record<string, unknown> = {
    network: {
      host: '127.0.0.1',
      control_port: params.controlPort,
    },
    database: {
      path: params.dbPath,
    },
    blob_store: {
      path: params.blobStorePath,
    },
    auth: {
      allow_guest: true,
      http_url: params.authHttpUrl,
      require_auth_service: false,
    },
    registry: {
      hmac_secret: params.hmacSecret,
      heartbeat_timeout: 90000,
    },
    web_api: {
      enabled: true,
      host: '127.0.0.1',
      port: params.webApiPort,
    },
    log_level: params.logLevel,
  };
  if (params.extraConfig) {
    Object.assign(base, params.extraConfig);
  }
  return base;
}

/**
 * 生成 Rust Edge JSON 配置
 */
function generateRustEdgeConfig(params: {
  serverId: number;
  name: string;
  port: number;
  edgePort: number;
  controlPort: number;
  hmacSecret: string;
  logLevel: string;
}): RustEdgeConfig {
  const certsDir = join(PROJECT_ROOT, 'tests/integration/certs');
  return {
    server_id: params.serverId,
    name: params.name,
    network: {
      host: '0.0.0.0',
      port: params.port,
      edge_port: params.edgePort,
      external_host: '127.0.0.1',
    },
    tls: {
      cert: join(certsDir, 'server.pem'),
      key: join(certsDir, 'server.key'),
      ca: join(certsDir, 'ca.pem'),
    },
    hub_server: {
      host: '127.0.0.1',
      control_port: params.controlPort,
      hmac_secret: params.hmacSecret,
      reconnect_interval: 5000,
      heartbeat_interval: 30000,
    },
    server: {
      capacity: 1000,
      max_bandwidth: 558000,
    },
    log_level: params.logLevel,
  };
}

/**
 * 启动 Rust Hub 服务进程
 */
async function startRustHubServer(params: {
  basePort: number;
  controlPort: number;
  webApiPort: number;
  authPort: number;
  dbPath: string;
  hmacSecret: string;
  silent: boolean;
  /** Optional extra config fields merged into the Hub JSON config */
  extraConfig?: Record<string, unknown>;
}): Promise<RustServerProcess> {
  const configPath = join(PROJECT_ROOT, `tmp/rust-hub-${params.basePort}.json`);
  const blobStorePath = join(PROJECT_ROOT, `tmp/rust-hub-blobs-${params.basePort}`);
  fs.mkdirSync(join(PROJECT_ROOT, 'tmp'), { recursive: true });
  const config = generateRustHubConfig({
    controlPort: params.controlPort,
    webApiPort: params.webApiPort,
    dbPath: params.dbPath,
    blobStorePath,
    authHttpUrl: `http://127.0.0.1:${params.authPort}/auth`,
    hmacSecret: params.hmacSecret,
    logLevel: params.silent ? 'error' : 'debug',
    extraConfig: params.extraConfig,
  });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  debugLog(`[RUST] Hub config written to ${configPath}`);

  const bin = findRustBinary('munode-hub');
  const proc = new RustServerProcess(bin, configPath, `Hub(${params.controlPort})`, params.silent);
  await proc.start();
  return proc;
}

/**
 * 启动 Rust Edge 服务进程
 */
async function startRustEdgeServer(
  serverId: number,
  name: string,
  port: number,
  edgeEdgePort: number,
  controlPort: number,
  basePort: number,
  hmacSecret: string,
  silent: boolean,
  extraConfig?: RustEdgeExtraConfig,
): Promise<RustServerProcess> {
  const configPath = join(PROJECT_ROOT, `tmp/rust-edge-${basePort}-${serverId}.json`);
  fs.mkdirSync(join(PROJECT_ROOT, 'tmp'), { recursive: true });
  let config: RustEdgeConfig = generateRustEdgeConfig({
    serverId,
    name,
    port,
    edgePort: edgeEdgePort,
    controlPort,
    hmacSecret,
    logLevel: silent ? 'error' : 'debug',
  });
  if (extraConfig) {
    const { hub_server: extraHub, ...otherExtra } = extraConfig;
    config = { ...config, ...otherExtra };
    // Deep-merge hub_server so individual fields (e.g. pool_size) can be overridden
    // without discarding the base host/control_port/hmac generated by generateRustEdgeConfig.
    if (extraHub) {
      config.hub_server = { ...config.hub_server, ...extraHub };
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  debugLog(`[RUST] Edge config written to ${configPath}`);

  const bin = findRustBinary('munode-edge');
  const proc = new RustServerProcess(bin, configPath, `Edge${serverId}(${port})`, silent);
  await proc.start();
  return proc;
}

/**
 * 测试调试日志函数
 */
export function debugLog(...args: any[]): void {
  if (TEST_DEBUG) {
    console.log('[TEST-DEBUG]', ...args);
  }
}

// Counter for cache busting in dynamic imports
let importCounter = 0;

// Global test environment
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
 * 查找可用端口
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
  hubServer?: HubServer;
  edgeServer?: EdgeServer;
  edgeServer2?: EdgeServer;
  edgeServer3?: EdgeServer;
  edgeServer4?: EdgeServer;
  /** Rust 模式：Hub 进程句柄 */
  hubProcess?: RustServerProcess;
  /** Rust 模式：Edge 进程句柄（对应 edgePort） */
  edgeProcess?: RustServerProcess;
  /** Rust 模式：Edge 进程句柄（对应 edgePort2） */
  edgeProcess2?: RustServerProcess;
  /** Rust 模式：Edge 进程句柄（对应 edgePort3） */
  edgeProcess3?: RustServerProcess;
  /** Rust 模式：Edge 进程句柄（对应 edgePort4） */
  edgeProcess4?: RustServerProcess;
  authServer?: TestAuthServer;
  authPort: number;
  hubPort: number;
  controlPort: number; // Hub 控制端口
  webApiPort: number; // Hub Web API 端口
  edgePort: number;       // Mumble 客户端 TLS 端口
  edgeEdgePort: number;   // Edge 间专用 TLS 端口
  edgeUdpPort: number;
  edgePort2: number;
  edgeEdgePort2: number;
  edgeUdpPort2: number;
  edgePort3: number;
  edgeEdgePort3: number;
  edgeUdpPort3: number;
  edgePort4: number;
  edgeEdgePort4: number;
  edgeUdpPort4: number;
  cleanup: () => Promise<void>;
}

/**
 * 客户端配置接口
 */
export interface ClientConfig {
  username: string;
  edge: 1 | 2 | 3 | 4;
  channelId?: number;
  /**
   * 使用 UDP 语音而非 TCP。启用后 createClients 会等待 UDP 握手完成。
   * 用于测试需要真实 UDP 路径（如网络质量模拟）的场景。
   */
  useUdpVoice?: boolean;
}

/**
 * 获取 Edge 端口
 */
function getEdgePort(testEnv: TestEnvironment, edge: 1 | 2 | 3 | 4): number {
  switch (edge) {
    case 1: return testEnv.edgePort;
    case 2: return testEnv.edgePort2;
    case 3: return testEnv.edgePort3;
    case 4: return testEnv.edgePort4;
  }
}

/**
 * 批量创建测试客户端（统一方法，从auth配置获取密码）
 */
export async function createClients(testEnv: TestEnvironment, configs: ClientConfig[]): Promise<MumbleClient[]> {
  const clients: MumbleClient[] = [];
  
  // Connect clients sequentially to avoid overwhelming the server
  for (const config of configs) {
    const userInfo = testUserPasswords[config.username];
    if (!userInfo) {
      throw new Error(`User not found: ${config.username}`);
    }
    
    const client = new MumbleClient();
    const targetPort = getEdgePort(testEnv, config.edge);
    console.log(`[TEST] Connecting ${config.username} to Edge ${config.edge} on port ${targetPort}`);
    
    try {
      await client.connect({
        host: 'localhost',
        port: targetPort,
        username: config.username,
        password: userInfo.password,
        rejectUnauthorized: false,
        forceTcpVoice: !config.useUdpVoice,
      });

      if (config.useUdpVoice) {
        // 等待 UDP 握手完成（handleCryptSetup 异步运行，connect() 返回后才发送 UDP ping）
        console.log(`[TEST] ${config.username} connected, waiting for UDP handshake...`);
        await client.waitForUDP(8000);
        console.log(`[TEST] ${config.username} UDP connection established`);
      } else {
        console.log(`[TEST] ${config.username} connected, using TCP voice`);
      }

      if (config.channelId !== undefined) {
        await client.sendUserState({ channel_id: config.channelId });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      clients.push(client);
      
      // Small delay between connections to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`[TEST] Failed to connect ${config.username}:`, error);
      // Clean up any successfully connected clients
      for (const c of clients) {
        try {
          await c.disconnect();
        } catch (e) {
          // ignore
        }
      }
      throw error;
    }
  }
  
  return clients;
}

/**
 * 清理客户端
 */
export async function cleanupClients(clients: MumbleClient[]): Promise<void> {
  // Disconnect clients sequentially to avoid overwhelming the server
  for (const [index, client] of clients.entries()) {
    try {
      await client.disconnect();
      // Small delay between disconnections
      await sleep(50);
    } catch (e) {
      // Log error but continue cleanup
      debugLog(`Error disconnecting client ${index}:`, e);
    }
  }
  
  // Wait for all client connections to be fully closed
  await sleep(300);
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
            authReq = this.parseFormData(body);
          } else {
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
        if (value) {
          arrays[arrayKey].push(value);
        }
      } else {
        result[key] = value;
      }
    }
    
    for (const [key, values] of Object.entries(arrays)) {
      result[key] = values;
    }
    
    if (!result.tokens) {
      result.tokens = [];
    }
    
    if (result.server_id) {
      result.server_id = parseInt(result.server_id, 10);
    }
    
    return result;
  }

  private authenticate(req: any): any {
    // Test users database
    const users = testUserPasswords;
    
    const user = users[req.username];
    if (!user || user.password !== req.password) {
      return { success: false, reason: 'Invalid credentials' };
    }

    const result = {
      success: true,
      user_id: user.user_id,
      username: req.username,
      displayName: req.username,
      groups: user.groups || ['user'],
    };
    
    return result;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error) => {
        reject(error);
      };

      this.server.once('error', errorHandler);
      
      this.server.listen(this.port, () => {
        this.server.removeListener('error', errorHandler);
        debugLog(`Test auth server listening on port ${this.port}`);
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
      this.server.closeAllConnections?.();
    });
  }
}

/**
 * 启动单个 Edge 服务器
 */
async function startEdgeServer(
  serverId: number,
  name: string,
  port: number,
  edgeEdgePort: number,
  hubPort: number,
  controlPort: number,
  silent: boolean
): Promise<EdgeServer> {
  const edgeConfigPath = join(PROJECT_ROOT, 'tests/config/edge-test.js');
  if (!fs.existsSync(edgeConfigPath)) {
    throw new Error(`Edge config file not found: ${edgeConfigPath}`);
  }

  const edgeConfigModule = await import(`file://${edgeConfigPath}?v=${++importCounter}`);
  const edgeConfig: EdgeConfig = { ...(edgeConfigModule.default || edgeConfigModule) };

  edgeConfig.server_id = serverId;
  edgeConfig.name = name;
  edgeConfig.network = edgeConfig.network || { host: '127.0.0.' + serverId, port, external_host: '127.0.0.' + serverId };
  edgeConfig.network.port = port;
  edgeConfig.network.edge_port = edgeEdgePort;  // Edge 间专用 TLS 端口
  edgeConfig.log_level = silent ? 'error' : 'debug';
  
  // Enable Worker Thread Pool for tests
  edgeConfig.workerThreads = edgeConfig.workerThreads || {
    enabled: true,
    count: 2, // Use 2 workers for tests
    workerTimeout: 5000,
    maxQueueLength: 100
  };
  
  // 配置UDP语音传输的共享密钥用于握手验证
  edgeConfig.voice_routing = edgeConfig.voice_routing || {
    enabled: true,
    shared_secret: 'test-shared-secret-for-udp-voice-handshake',
    connection_strategy: 'tcp_only', // Force TCP for Edge-to-Edge in tests to avoid UDP issues
  };
  if (!edgeConfig.voice_routing.shared_secret) {
    edgeConfig.voice_routing.shared_secret = 'test-shared-secret-for-udp-voice-handshake';
  }
  // Force TCP-only for Edge-to-Edge connections in tests to avoid UDP packet loss
  edgeConfig.voice_routing.connection_strategy = 'tcp_only';

  const certsDir = join(__dirname, 'certs');
  edgeConfig.tls = {
    cert: join(certsDir, 'server.pem'),
    key: join(certsDir, 'server.key'),
    ca: join(certsDir, 'ca.pem'),
  };

  edgeConfig.hub_server = edgeConfig.hub_server || {
    host: '127.0.0.1',
    port: hubPort,
    control_port: controlPort,
    tls: { reject_unauthorized: false },
    reconnect_interval: 5000,
    heartbeat_interval: 30000,
    pool_size: 1,
  };
  edgeConfig.hub_server.host = '127.0.0.1';
  edgeConfig.hub_server.port = hubPort;
  edgeConfig.hub_server.control_port = controlPort;

  const edgeServer = new EdgeServer(edgeConfig);
  await edgeServer.start();
  debugLog(`${name} started on port ${port}`);
  
  // Wait for Edge server to be ready (port listening)
  await waitForCondition(
    async () => {
      try {
        const testSocket = await new Promise<boolean>((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(100);
          socket.connect(port, '127.0.0.1', () => {
            socket.destroy();
            resolve(true);
          });
          socket.on('error', () => {
            socket.destroy();
            resolve(false);
          });
          socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
          });
        });
        return testSocket;
      } catch {
        return false;
      }
    },
    3000,
    100,
    `${name} to be listening on port ${port}`
  );

  return edgeServer;
}

/**
 * 创建独立的测试环境（不影响 globalTestEnvironment）
 * 用于需要重启 Hub/Edge 但不想影响其他测试的场景
 */
async function createIsolatedTestEnvironment(
  basePort: number,
  options: {
    startHub?: boolean;
    startEdge?: boolean;
    startEdge2?: boolean;
    startEdge3?: boolean;
    startEdge4?: boolean;
    startAuth?: boolean;
    silent?: boolean;
    /** Extra fields merged into the Rust Hub JSON config (Rust mode only) */
    rustHubExtraConfig?: Record<string, unknown>;
    /** Extra fields merged into the Rust Edge JSON config (Rust mode only) */
    rustEdgeExtraConfig?: RustEdgeExtraConfig;
  }
): Promise<TestEnvironment> {
  const startHub = options.startHub !== false;
  const startEdge = options.startEdge !== false;
  const startEdge2 = options.startEdge2 !== false;
  const silent = options.silent ?? true;

  // Allocate ports for this isolated environment
  const authPort = options.startAuth !== false ? await findAvailablePort(basePort) : 0;
  const hubPort = startHub ? await findAvailablePort(authPort + 1) : 0;
  const controlPort = startHub ? await findAvailablePort(hubPort + 1) : 0;
  const webApiPort = await findAvailablePort(controlPort + 1);
  const edgePort = startEdge ? await findAvailablePort(webApiPort + 1) : 0;
  const edgeEdgePort = startEdge ? await findAvailablePort(edgePort + 1) : 0;
  const edgeUdpPort = edgePort;
  const edgePort2 = startEdge2 ? await findAvailablePort(edgeEdgePort + 1) : 0;
  const edgeEdgePort2 = startEdge2 ? await findAvailablePort(edgePort2 + 1) : 0;
  const edgeUdpPort2 = edgePort2;

  let authServer: TestAuthServer | undefined;
  let hubProcess: RustServerProcess | undefined;
  let edgeProcess: RustServerProcess | undefined;
  let edgeProcess2: RustServerProcess | undefined;

  if (options.startAuth !== false) {
    authServer = new TestAuthServer(authPort);
    await authServer.start();
  }

  if (startHub && USE_RUST) {
    const dbPath = join(PROJECT_ROOT, `data/hub-isolated-${basePort}.db`);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    fs.mkdirSync(join(PROJECT_ROOT, 'data'), { recursive: true });
    const initScript = join(PROJECT_ROOT, 'scripts/init-test-db.ts');
    if (fs.existsSync(initScript)) {
      await new Promise<void>((resolve, reject) => {
        const initProcess = spawn('tsx', [initScript, dbPath], {
          stdio: silent ? 'ignore' : 'inherit',
          cwd: PROJECT_ROOT,
          env: { ...process.env, DB_PATH: dbPath },
        });
        initProcess.on('exit', (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`Database initialization failed with code ${code}`));
        });
        initProcess.on('error', reject);
      });
    }
    const hmacSecret = 'test-hmac-secret-key-for-integration-tests';
    hubProcess = await startRustHubServer({
      basePort,
      controlPort,
      webApiPort,
      authPort,
      dbPath,
      hmacSecret,
      silent,
      extraConfig: options.rustHubExtraConfig,
    });
    await waitForCondition(
      async () => {
        try {
          const testSocket = await new Promise<boolean>((resolve) => {
            const socket = new net.Socket();
            socket.connect(controlPort, '127.0.0.1', () => { socket.destroy(); resolve(true); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
          });
          return testSocket;
        } catch { return false; }
      },
      10000, 100, `Isolated Hub control port ${controlPort}`
    );
  }

  if (startEdge && USE_RUST) {
    const hmacSecret = 'test-hmac-secret-key-for-integration-tests';
    edgeProcess = await startRustEdgeServer(1, 'Edge1-Isolated', edgePort, edgeEdgePort, controlPort, basePort, hmacSecret, silent, options.rustEdgeExtraConfig);
    await waitForCondition(
      async () => {
        try {
          return await new Promise<boolean>((resolve) => {
            const socket = new net.Socket();
            socket.connect(edgePort, '127.0.0.1', () => { socket.destroy(); resolve(true); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
          });
        } catch { return false; }
      },
      10000, 100, `Isolated Edge 1 port ${edgePort}`
    );
  }

  if (startEdge2 && USE_RUST) {
    const hmacSecret = 'test-hmac-secret-key-for-integration-tests';
    edgeProcess2 = await startRustEdgeServer(2, 'Edge2-Isolated', edgePort2, edgeEdgePort2, controlPort, basePort, hmacSecret, silent, options.rustEdgeExtraConfig);
    await waitForCondition(
      async () => {
        try {
          return await new Promise<boolean>((resolve) => {
            const socket = new net.Socket();
            socket.connect(edgePort2, '127.0.0.1', () => { socket.destroy(); resolve(true); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
          });
        } catch { return false; }
      },
      10000, 100, `Isolated Edge 2 port ${edgePort2}`
    );
  }

  // Wait for edges to register with hub
  await sleep(1000);

  const env: TestEnvironment = {
    hubProcess,
    edgeProcess,
    edgeProcess2,
    authServer,
    authPort,
    hubPort,
    controlPort,
    webApiPort,
    edgePort,
    edgeEdgePort,
    edgeUdpPort,
    edgePort2,
    edgeEdgePort2,
    edgeUdpPort2,
    edgePort3: 0,
    edgeEdgePort3: 0,
    edgeUdpPort3: 0,
    edgePort4: 0,
    edgeEdgePort4: 0,
    edgeUdpPort4: 0,
    cleanup: async () => {
      if (edgeProcess2) await edgeProcess2.stop().catch(() => {});
      if (edgeProcess) await edgeProcess.stop().catch(() => {});
      if (hubProcess) await hubProcess.stop().catch(() => {});
      if (authServer) await authServer.stop().catch(() => {});
      // Clean up DB files
      const dbPath = join(PROJECT_ROOT, `data/hub-isolated-${basePort}.db`);
      for (const ext of ['', '-wal', '-shm']) {
        try { if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext); } catch {}
      }
    },
  };

  return env;
}


export async function setupTestEnvironment(
  basePort: number = 8080,
  options: {
    startHub?: boolean;
    startEdge?: boolean;
    startEdge2?: boolean;
    startEdge3?: boolean;
    startEdge4?: boolean;
    startAuth?: boolean;
    hubConfig?: Partial<HubConfig>;
    /** Extra fields merged into the Rust Hub JSON config (Rust mode only) */
    rustHubExtraConfig?: Record<string, unknown>;
    /** Extra fields merged into the Rust Edge JSON config (Rust mode only) */
    rustEdgeExtraConfig?: RustEdgeExtraConfig;
    reuse?: boolean;
    silent?: boolean;
    /** When true, creates an isolated environment without affecting globalTestEnvironment */
    isolated?: boolean;
    /** Fixed port for Edge 1 client listener (skips auto-allocation) */
    fixedEdgePort?: number;
    /** Fixed port for Edge 2 client listener (skips auto-allocation) */
    fixedEdgePort2?: number;
    /** Fixed port for Edge 3 client listener (skips auto-allocation) */
    fixedEdgePort3?: number;
    /** Fixed port for Edge 4 client listener (skips auto-allocation) */
    fixedEdgePort4?: number;
  } = {}
): Promise<TestEnvironment> {
  // Isolated mode: bypass global environment management entirely
  if (options.isolated) {
    return createIsolatedTestEnvironment(basePort, options);
  }
  // Apply default values
  const defaultOptions = {
    startHub: true,
    startEdge: true,
    startEdge2: true,
    startEdge3: false,
    startEdge4: false,
    startAuth: true,
    reuse: true,
    silent: true
  };
  
  const finalOptions = { ...defaultOptions, ...options };
  
  console.error('setup test env options:', finalOptions);
  
  // If reuse is false and global environment exists, clean it up first
  if (globalTestEnvironment && finalOptions.reuse === false) {
    debugLog('reuse=false: Cleaning up existing environment before creating new one');
    const oldEnv = globalTestEnvironment;
    globalTestEnvironment = null;
    refCount = 0;
    
    // Clean up old environment - stop Edge servers first to disconnect from Hub
    if (oldEnv.edgeProcess4) { try { await oldEnv.edgeProcess4.stop(); } catch {} }
    if (oldEnv.edgeServer4) {
      try {
        await oldEnv.edgeServer4.stop();
        debugLog('Edge server 4 stopped');
        await waitForPortsAvailable([oldEnv.edgePort4, oldEnv.edgeEdgePort4, oldEnv.edgeUdpPort4], 3000);
      } catch (error) {
        console.warn('Error stopping edge server 4:', error);
      }
    }
    if (oldEnv.edgeProcess3) { try { await oldEnv.edgeProcess3.stop(); } catch {} }
    if (oldEnv.edgeServer3) {
      try {
        await oldEnv.edgeServer3.stop();
        debugLog('Edge server 3 stopped');
        await waitForPortsAvailable([oldEnv.edgePort3, oldEnv.edgeEdgePort3, oldEnv.edgeUdpPort3], 3000);
      } catch (error) {
        console.warn('Error stopping edge server 3:', error);
      }
    }
    if (oldEnv.edgeProcess2) { try { await oldEnv.edgeProcess2.stop(); } catch {} }
    if (oldEnv.edgeServer2) {
      try {
        await oldEnv.edgeServer2.stop();
        debugLog('Edge server 2 stopped');
        await waitForPortsAvailable([oldEnv.edgePort2, oldEnv.edgeEdgePort2, oldEnv.edgeUdpPort2], 3000);
      } catch (error) {
        console.warn('Error stopping edge server 2:', error);
      }
    }
    if (oldEnv.edgeProcess) { try { await oldEnv.edgeProcess.stop(); } catch {} }
    if (oldEnv.edgeServer) {
      try {
        await oldEnv.edgeServer.stop();
        debugLog('Edge server 1 stopped');
        await waitForPortsAvailable([oldEnv.edgePort, oldEnv.edgeEdgePort, oldEnv.edgeUdpPort], 3000);
      } catch (error) {
        console.warn('Error stopping edge server:', error);
      }
    }
    
    // Now stop Hub after all Edge servers have disconnected
    if (oldEnv.hubProcess) { try { await oldEnv.hubProcess.stop(); } catch {} }
    if (oldEnv.hubServer) {
      try {
        await oldEnv.hubServer.stop();
        debugLog('Hub server stopped');
        await waitForPortsAvailable([oldEnv.hubPort, oldEnv.controlPort, oldEnv.webApiPort], 5000);
      } catch (error) {
        console.warn('Error stopping hub server:', error);
      }
    }
    
    if (oldEnv.authServer) {
      try {
        await oldEnv.authServer.stop();
        debugLog('Auth server stopped');
        await waitForPortAvailable(oldEnv.authPort, 2000);
      } catch (error) {
        console.warn('Error stopping auth server:', error);
      }
    }
    
    // Verify all old ports are released
    const oldPorts = [oldEnv.authPort, oldEnv.hubPort, oldEnv.edgePort, oldEnv.edgeEdgePort, oldEnv.edgePort2, oldEnv.edgeEdgePort2,
                      oldEnv.edgePort3, oldEnv.edgeEdgePort3, oldEnv.edgePort4, oldEnv.edgeEdgePort4, oldEnv.controlPort, oldEnv.webApiPort].filter(p => p > 0);
    await waitForPortsAvailable(oldPorts, 5000);
    debugLog('Old environment cleaned up');
  }
  
  // Reuse global environment if available and reuse is not explicitly false
  if (globalTestEnvironment && finalOptions.reuse !== false) {
    // Check if the global environment has all required servers (TS or Rust)
    const hasHub = globalTestEnvironment.hubServer !== undefined || globalTestEnvironment.hubProcess !== undefined;
    const hasEdge = globalTestEnvironment.edgeServer !== undefined || globalTestEnvironment.edgeProcess !== undefined;
    const hasEdge2 = globalTestEnvironment.edgeServer2 !== undefined || globalTestEnvironment.edgeProcess2 !== undefined;
    const hasEdge3 = globalTestEnvironment.edgeServer3 !== undefined || globalTestEnvironment.edgeProcess3 !== undefined;
    const hasEdge4 = globalTestEnvironment.edgeServer4 !== undefined || globalTestEnvironment.edgeProcess4 !== undefined;
    const hasRequiredServers = 
      (finalOptions.startHub === false || hasHub) &&
      (finalOptions.startAuth === false || globalTestEnvironment.authServer) &&
      (finalOptions.startEdge === false || hasEdge) &&
      (finalOptions.startEdge2 !== true || hasEdge2) &&
      (finalOptions.startEdge3 !== true || hasEdge3) &&
      (finalOptions.startEdge4 !== true || hasEdge4);
    
    if (hasRequiredServers) {
      refCount++;
      debugLog(`Reusing existing test environment (refCount: ${refCount})`);
      return globalTestEnvironment;
    } else {
      debugLog('Global environment missing required servers, creating new environment');
      // Clean up the incomplete environment
      const oldEnv = globalTestEnvironment;
      globalTestEnvironment = null;
      refCount = 0;
      
      // Stop any running servers in the old environment
      if (oldEnv.edgeServer4) {
        try {
          await oldEnv.edgeServer4.stop();
          debugLog('Edge server 4 stopped');
          await waitForPortsAvailable([oldEnv.edgePort4, oldEnv.edgeEdgePort4, oldEnv.edgeUdpPort4], 3000);
        } catch (error) {
          console.warn('Error stopping edge server 4:', error);
        }
      }
      if (oldEnv.edgeServer3) {
        try {
          await oldEnv.edgeServer3.stop();
          debugLog('Edge server 3 stopped');
          await waitForPortsAvailable([oldEnv.edgePort3, oldEnv.edgeEdgePort3, oldEnv.edgeUdpPort3], 3000);
        } catch (error) {
          console.warn('Error stopping edge server 3:', error);
        }
      }
      if (oldEnv.edgeServer2) {
        try {
          await oldEnv.edgeServer2.stop();
          debugLog('Edge server 2 stopped');
          await waitForPortsAvailable([oldEnv.edgePort2, oldEnv.edgeEdgePort2, oldEnv.edgeUdpPort2], 3000);
        } catch (error) {
          console.warn('Error stopping edge server 2:', error);
        }
      }
      if (oldEnv.edgeServer) {
        try {
          await oldEnv.edgeServer.stop();
          debugLog('Edge server 1 stopped');
          await waitForPortsAvailable([oldEnv.edgePort, oldEnv.edgeEdgePort, oldEnv.edgeUdpPort], 3000);
        } catch (error) {
          console.warn('Error stopping edge server:', error);
        }
      }
      
      // Now stop Hub after all Edge servers have disconnected
      if (oldEnv.hubServer) {
        try {
          await oldEnv.hubServer.stop();
          debugLog('Hub server stopped');
          await waitForPortsAvailable([oldEnv.hubPort, oldEnv.controlPort, oldEnv.webApiPort], 5000);
        } catch (error) {
          console.warn('Error stopping hub server:', error);
        }
      }
      
      if (oldEnv.authServer) {
        try {
          await oldEnv.authServer.stop();
          debugLog('Auth server stopped');
          await waitForPortAvailable(oldEnv.authPort, 2000);
        } catch (error) {
          console.warn('Error stopping auth server:', error);
        }
      }
      
      // Verify all old ports are released
      const oldPorts = [oldEnv.authPort, oldEnv.hubPort, oldEnv.edgePort, oldEnv.edgeEdgePort, oldEnv.edgePort2, oldEnv.edgeEdgePort2,
                        oldEnv.edgePort3, oldEnv.edgeEdgePort3, oldEnv.edgePort4, oldEnv.edgeEdgePort4, oldEnv.controlPort, oldEnv.webApiPort].filter(p => p > 0);
      await waitForPortsAvailable(oldPorts, 5000);
      debugLog('Incomplete environment cleaned up');
    }
  }

  const silent = finalOptions.silent ?? (process.env.TEST_VERBOSE !== '1');

  console.log(`Setting up test environment (${USE_RUST ? 'Rust binary' : 'in-process'} mode)...`);
  
  let authServer: TestAuthServer | undefined;
  let hubServer: HubServer | undefined;
  let edgeServer: EdgeServer | undefined;
  let edgeServer2: EdgeServer | undefined;
  let edgeServer3: EdgeServer | undefined;
  let edgeServer4: EdgeServer | undefined;
  // Rust mode process handles
  let hubProcess: RustServerProcess | undefined;
  let edgeProcess: RustServerProcess | undefined;
  let edgeProcess2: RustServerProcess | undefined;
  let edgeProcess3: RustServerProcess | undefined;
  let edgeProcess4: RustServerProcess | undefined;
  
  // 动态分配端口（统一UDP端口架构：不再为voice单独分配端口）
  const authPort = finalOptions.startAuth !== false ? await findAvailablePort(basePort) : 0;
  const hubPort = finalOptions.startHub !== false ? await findAvailablePort(authPort + 1) : 0;
  const controlPort = finalOptions.startHub !== false ? await findAvailablePort(hubPort + 1) : 0;
  const webApiPort = finalOptions.startHub !== false ? await findAvailablePort(controlPort + 1) : 0;
  
  const edgeBasePort = Math.max(webApiPort, basePort - 1);
  // Edge1: Mumble 客户端端口 + Edge 间专用 TLS 端口
  const edgePort = finalOptions.startEdge !== false
    ? (finalOptions.fixedEdgePort ?? await findAvailablePort(edgeBasePort + 2))
    : 0;
  const edgeEdgePort = (finalOptions.startEdge !== false && edgePort > 0) ? await findAvailablePort(edgePort + 1) : 0;
  const edgeUdpPort = edgePort; // 统一UDP端口：与TLS端口相同

  // Edge2
  const edgePort2 = (finalOptions.startEdge2 === true && edgeEdgePort > 0)
    ? (finalOptions.fixedEdgePort2 ?? await findAvailablePort(edgeEdgePort + 1))
    : 0;
  const edgeEdgePort2 = (finalOptions.startEdge2 === true && edgePort2 > 0) ? await findAvailablePort(edgePort2 + 1) : 0;
  const edgeUdpPort2 = edgePort2; // 统一UDP端口：与TLS端口相同

  // Edge3
  const edgePort3 = (finalOptions.startEdge3 === true && edgeEdgePort2 > 0)
    ? (finalOptions.fixedEdgePort3 ?? await findAvailablePort(edgeEdgePort2 + 1))
    : 0;
  const edgeEdgePort3 = (finalOptions.startEdge3 === true && edgePort3 > 0) ? await findAvailablePort(edgePort3 + 1) : 0;
  const edgeUdpPort3 = edgePort3; // 统一UDP端口：与TLS端口相同

  // Edge4
  const edgePort4 = (finalOptions.startEdge4 === true && edgeEdgePort3 > 0)
    ? (finalOptions.fixedEdgePort4 ?? await findAvailablePort(edgeEdgePort3 + 1))
    : 0;
  const edgeEdgePort4 = (finalOptions.startEdge4 === true && edgePort4 > 0) ? await findAvailablePort(edgePort4 + 1) : 0;
  const edgeUdpPort4 = edgePort4; // 统一UDP端口：与TLS端口相同

  console.log(`Allocated ports - Auth: ${authPort}, Hub: ${hubPort}(Unified UDP/TCP), Control: ${controlPort}, WebAPI: ${webApiPort}`);
  console.log(`Edge ports - Edge1: ${edgePort}(Client)/${edgeEdgePort}(Edge-Edge)/${edgeUdpPort}(UDP), Edge2: ${edgePort2}(Client)/${edgeEdgePort2}(Edge-Edge)/${edgeUdpPort2}(UDP), Edge3: ${edgePort3}(Client)/${edgeEdgePort3}(Edge-Edge)/${edgeUdpPort3}(UDP), Edge4: ${edgePort4}(Client)/${edgeEdgePort4}(Edge-Edge)/${edgeUdpPort4}(UDP)`);

  try {
    // 1. 启动认证服务器
    if (finalOptions.startAuth !== false) {
      authServer = new TestAuthServer(authPort);
      await authServer.start();
      // Verify auth server is listening
      await waitForCondition(
        async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${authPort}/auth`, { method: 'OPTIONS' });
            return response.status === 200;
          } catch {
            return false;
          }
        },
        2000,
        50,
        'auth server to be ready'
      );
    }

    // 2. 启动 Hub 服务器
    if (finalOptions.startHub !== false) {
      if (USE_RUST) {
        // --- Rust Hub 模式 ---
        const dbPath = join(PROJECT_ROOT, `data/hub-test-${basePort}.db`);
        // 初始化数据库（使用 TS init 脚本，Rust hub 共用相同 schema）
        // 必须同时删除 WAL 和 SHM 文件，否则 SQLite 在找不到主 DB 文件时会因 SHM 文件而报 disk I/O error
        for (const ext of ['', '-wal', '-shm']) {
          if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext);
        }
        fs.mkdirSync(join(PROJECT_ROOT, 'data'), { recursive: true });
        const initScript = join(PROJECT_ROOT, 'scripts/init-test-db.ts');
        if (fs.existsSync(initScript)) {
          await new Promise<void>((resolve, reject) => {
            const initProcess = spawn('tsx', [initScript, dbPath], {
              stdio: silent ? 'ignore' : 'inherit',
              cwd: PROJECT_ROOT,
              env: { ...process.env, DB_PATH: dbPath },
            });
            initProcess.on('exit', (code: number) => {
              if (code === 0) resolve();
              else reject(new Error(`Database initialization failed with code ${code}`));
            });
            initProcess.on('error', reject);
          });
        }
        await waitForCondition(() => fs.existsSync(dbPath), 2000, 50, 'database file to exist');

        const hmacSecret = 'test-hmac-secret-key-for-integration-tests';
        // Translate hubConfig fields to Rust Hub JSON config format.
        // hubConfig uses the deprecated TypeScript config schema; Rust Hub uses a
        // different JSON structure.  We convert the fields we care about here so
        // that callers can pass either hubConfig or rustHubExtraConfig.
        const rustHubExtraFromHubConfig: Record<string, unknown> = {};
        if (finalOptions.hubConfig?.bandwidth != null) {
          rustHubExtraFromHubConfig['limits'] = { max_bandwidth: finalOptions.hubConfig.bandwidth };
        }
        // Merge: rustHubExtraConfig takes precedence over derived values.
        // For nested objects (e.g. limits), do a shallow object merge so that
        // rustHubExtraConfig.limits.* fields don't silently drop others.
        const rustHubExplicit = (finalOptions as { rustHubExtraConfig?: Record<string, unknown> }).rustHubExtraConfig ?? {};
        const mergedRustHubExtra: Record<string, unknown> = { ...rustHubExtraFromHubConfig };
        for (const [key, value] of Object.entries(rustHubExplicit)) {
          if (
            key in mergedRustHubExtra &&
            typeof mergedRustHubExtra[key] === 'object' && mergedRustHubExtra[key] !== null &&
            typeof value === 'object' && value !== null && !Array.isArray(value)
          ) {
            mergedRustHubExtra[key] = { ...(mergedRustHubExtra[key] as object), ...(value as object) };
          } else {
            mergedRustHubExtra[key] = value;
          }
        }
        hubProcess = await startRustHubServer({
          basePort,
          controlPort,
          webApiPort,
          authPort,
          dbPath,
          hmacSecret,
          silent,
          extraConfig: Object.keys(mergedRustHubExtra).length > 0 ? mergedRustHubExtra : undefined,
        });
        // Wait for Rust Hub control port to be listening
        await waitForCondition(
          async () => {
            try {
              const testSocket = await new Promise<boolean>((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(100);
                socket.connect(controlPort, '127.0.0.1', () => { socket.destroy(); resolve(true); });
                socket.on('error', () => { socket.destroy(); resolve(false); });
                socket.on('timeout', () => { socket.destroy(); resolve(false); });
              });
              return testSocket;
            } catch { return false; }
          },
          10000,
          100,
          'Rust Hub control port to be listening'
        );
        debugLog('[RUST] Hub started and control port is ready');
      } else {
      const hubConfigPath = join(PROJECT_ROOT, 'tests/config/hub-test.js');
      if (fs.existsSync(hubConfigPath)) {
        const hubConfigModule = await import(`file://${hubConfigPath}?v=${++importCounter}`);
        // 使用 structuredClone 来保留 callback 函数
        const originalConfig = hubConfigModule.default || hubConfigModule;
        const hubConfig: HubConfig = {
          ...originalConfig,
          tls: { ...originalConfig.tls },
          connection: originalConfig.connection ? { ...originalConfig.connection } : undefined,
          database: { ...originalConfig.database },
          blob_store: originalConfig.blob_store ? { ...originalConfig.blob_store } : undefined,
          registry: { ...originalConfig.registry },
          web_api: originalConfig.web_api ? { ...originalConfig.web_api } : undefined,
          auth: originalConfig.auth ? { ...originalConfig.auth } : undefined,
          voice_routing: originalConfig.voice_routing ? { ...originalConfig.voice_routing } : undefined,
        } as HubConfig;
        
        hubConfig.port = hubPort;
        hubConfig.control_port = controlPort;
        hubConfig.web_api = hubConfig.web_api || { 
          enabled: true,
          port: webApiPort,
          host: '127.0.0.1',
          cors: true
        };
        hubConfig.web_api.port = webApiPort;
        // 不再设置 voicePort，使用统一端口

        hubConfig.blob_store = hubConfig.blob_store || { enabled: true, path: join(PROJECT_ROOT, 'data/blobs-test') };
        
        // 检查 hubConfig.auth 是否已经有 callback
        // 如果有 callback，保持不变；否则使用 HTTP API 方式（主要用于 auth 测试）
        if (!hubConfig.auth || !('callback' in hubConfig.auth)) {
          // 只有在没有 callback 时才配置 HTTP API 认证
          const existingAuth = hubConfig.auth || {};
          hubConfig.auth = { 
            ...existingAuth,
            api_url: `http://127.0.0.1:${authPort}/auth`, 
            api_key: '', 
            timeout: 5000,
            content_type: 'application/json',
            method: 'POST' as const,
            cache_ttl: 300000,
            pull_interval: 300000,
            track_sessions: false,
            allow_cache_fallback: true,
          };
          console.log(`[SETUP] Configured Hub auth URL: http://127.0.0.1:${authPort}/auth`);
        } else {
          console.log(`[SETUP] Using callback-based authentication from config`);
        }
        
        // Set log level based on TEST_VERBOSE
        hubConfig.log_level = silent ? 'error' : 'debug';
        
        if (finalOptions.hubConfig) {
          Object.assign(hubConfig, finalOptions.hubConfig);
        }
        
        // 使用基于端口的唯一数据库文件，避免多个测试套件冲突
        const dbPath = join(PROJECT_ROOT, `data/hub-test-${basePort}.db`);
        hubConfig.database.path = dbPath;
        
        // 删除旧的数据库文件
        if (fs.existsSync(dbPath)) {
          // Wait for file to be deletable (may be locked from previous test)
          let deleted = false;
          await waitForCondition(
            () => {
              // Check if file still exists first
              if (!fs.existsSync(dbPath)) {
                deleted = true;
                return true;
              }
              
              // Try to delete if it exists
              try {
                fs.unlinkSync(dbPath);
                debugLog(`Deleted existing test database file: ${dbPath}`);
                deleted = true;
                return true;
              } catch (error) {
                debugLog(`Database file still locked, retrying...`);
                return false;
              }
            },
            3000,
            100,
            'database file to be deletable'
          );
          
          if (!deleted) {
            console.warn(`Could not delete database file ${dbPath}, it may still be in use`);
          }
        }
        
        // 初始化数据库
        debugLog('Initializing test database...');
        const initScript = join(PROJECT_ROOT, 'scripts/init-test-db.ts');
        if (fs.existsSync(initScript)) {
          await new Promise<void>((resolve, reject) => {
            const initProcess = spawn('tsx', [initScript, dbPath], {
              stdio: silent ? 'ignore' : 'inherit',
              cwd: PROJECT_ROOT,
              env: { ...process.env, DB_PATH: dbPath },
            });
            
            initProcess.on('exit', (code: number) => {
              if (code === 0) {
                debugLog('Test database initialized successfully');
                resolve();
              } else {
                reject(new Error(`Database initialization failed with code ${code}`));
              }
            });
            initProcess.on('error', reject);
          });
        }
        
        // Wait for database file to be ready
        await waitForCondition(
          () => fs.existsSync(dbPath),
          2000,
          50,
          'database file to exist'
        );
        
        // 创建 Hub 服务器实例
        console.log(`[SETUP] Creating Hub server`);
        hubServer = new HubServer(hubConfig);
        await hubServer.start();
        debugLog('Hub server started successfully');
        
        // Wait for control port to be listening instead of fixed delay
        await waitForCondition(
          async () => {
            try {
              // Try to connect to control port
              const testSocket = await new Promise<boolean>((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(100);
                socket.connect(controlPort, '127.0.0.1', () => {
                  socket.destroy();
                  resolve(true);
                });
                socket.on('error', () => {
                  socket.destroy();
                  resolve(false);
                });
                socket.on('timeout', () => {
                  socket.destroy();
                  resolve(false);
                });
              });
              return testSocket;
            } catch {
              return false;
            }
          },
          5000,
          100,
          'Hub control port to be listening'
        );
        
        // 为测试环境设置默认ACL：给所有用户MakeChannel权限（方便测试）
        // 在生产环境中，这个权限应该只给特定的用户或组
        if (hubServer) {
          try {
            const database = (hubServer as any).database; // Access private database
            if (database) {
              // 为Root频道(channel_id=0)的'all'组添加MakeChannel权限
              // Permission.MakeChannel = 0x40 = 64
              // 'all'是特殊组，匹配所有用户
              await database.run(`
                INSERT OR REPLACE INTO acls (
                  channel_id, user_id, "group", apply_here, apply_subs, allow, deny
                ) VALUES (0, -1, 'admin', 1, 1, 3607777, 0)
              `);
              debugLog('Set default MakeChannel permission for all users on Root channel');
            }
          } catch (error) {
            console.warn('Failed to set default ACL for all users:', error);
          }
        }
      } // end if (fs.existsSync(hubConfigPath))
      } // end else (TS mode)
    }

    // 3. 启动 Edge 服务器 1
    if (finalOptions.startEdge !== false && edgePort > 0) {
      if (USE_RUST) {
        edgeProcess = await startRustEdgeServer(1, 'MuNode Edge Server 1 (Rust Test)', edgePort, edgeEdgePort, controlPort, basePort, 'test-hmac-secret-key-for-integration-tests', silent);
        await waitForCondition(
          async () => {
            try {
              const testSocket = await new Promise<boolean>((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(100);
                socket.connect(edgePort, '127.0.0.1', () => { socket.destroy(); resolve(true); });
                socket.on('error', () => { socket.destroy(); resolve(false); });
                socket.on('timeout', () => { socket.destroy(); resolve(false); });
              });
              return testSocket;
            } catch { return false; }
          },
          5000, 100, `Rust Edge 1 to be listening on port ${edgePort}`
        );
        debugLog(`[RUST] Edge 1 started on port ${edgePort}`);
      } else {
        edgeServer = await startEdgeServer(1, 'MuNode Edge Server 1 (Test)', edgePort, edgeEdgePort, hubPort, controlPort, silent);
      }
    }

    // 4. 启动 Edge 服务器 2
    if (finalOptions.startEdge2 !== false && edgePort2 > 0) {
      if (USE_RUST) {
        edgeProcess2 = await startRustEdgeServer(2, 'MuNode Edge Server 2 (Rust Test)', edgePort2, edgeEdgePort2, controlPort, basePort, 'test-hmac-secret-key-for-integration-tests', silent);
        await waitForCondition(
          async () => {
            try {
              return await new Promise<boolean>((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(100);
                socket.connect(edgePort2, '127.0.0.1', () => { socket.destroy(); resolve(true); });
                socket.on('error', () => { socket.destroy(); resolve(false); });
                socket.on('timeout', () => { socket.destroy(); resolve(false); });
              });
            } catch { return false; }
          },
          5000, 100, `Rust Edge 2 to be listening on port ${edgePort2}`
        );
        debugLog(`[RUST] Edge 2 started on port ${edgePort2}`);
      } else {
        edgeServer2 = await startEdgeServer(2, 'MuNode Edge Server 2 (Test)', edgePort2, edgeEdgePort2, hubPort, controlPort, silent);
      }
    }

    // 5. 启动 Edge 服务器 3
    if (finalOptions.startEdge3 === true && edgePort3 > 0) {
      if (USE_RUST) {
        edgeProcess3 = await startRustEdgeServer(3, 'MuNode Edge Server 3 (Rust Test)', edgePort3, edgeEdgePort3, controlPort, basePort, 'test-hmac-secret-key-for-integration-tests', silent);
        await waitForCondition(
          async () => {
            try {
              return await new Promise<boolean>((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(100);
                socket.connect(edgePort3, '127.0.0.1', () => { socket.destroy(); resolve(true); });
                socket.on('error', () => { socket.destroy(); resolve(false); });
                socket.on('timeout', () => { socket.destroy(); resolve(false); });
              });
            } catch { return false; }
          },
          5000, 100, `Rust Edge 3 to be listening on port ${edgePort3}`
        );
        debugLog(`[RUST] Edge 3 started on port ${edgePort3}`);
      } else {
        edgeServer3 = await startEdgeServer(3, 'MuNode Edge Server 3 (Test)', edgePort3, edgeEdgePort3, hubPort, controlPort, silent);
      }
    }

    // 6. 启动 Edge 服务器 4
    if (finalOptions.startEdge4 === true && edgePort4 > 0) {
      if (USE_RUST) {
        edgeProcess4 = await startRustEdgeServer(4, 'MuNode Edge Server 4 (Rust Test)', edgePort4, edgeEdgePort4, controlPort, basePort, 'test-hmac-secret-key-for-integration-tests', silent);
        await waitForCondition(
          async () => {
            try {
              return await new Promise<boolean>((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(100);
                socket.connect(edgePort4, '127.0.0.1', () => { socket.destroy(); resolve(true); });
                socket.on('error', () => { socket.destroy(); resolve(false); });
                socket.on('timeout', () => { socket.destroy(); resolve(false); });
              });
            } catch { return false; }
          },
          5000, 100, `Rust Edge 4 to be listening on port ${edgePort4}`
        );
        debugLog(`[RUST] Edge 4 started on port ${edgePort4}`);
      } else {
        edgeServer4 = await startEdgeServer(4, 'MuNode Edge Server 4 (Test)', edgePort4, edgeEdgePort4, hubPort, controlPort, silent);
      }
    }

    // 7. 等待 Edge 服务器之间建立连接（仅 TS 模式检查内部 TLS 连接状态）
    // Rust 模式下 Edge 间连接由 Hub 协调，需等待足够时间
    const activeEdges: EdgeServer[] = [edgeServer, edgeServer2, edgeServer3, edgeServer4].filter(Boolean) as EdgeServer[];
    if (activeEdges.length > 1) {
      debugLog(`Waiting for ${activeEdges.length} TS Edge servers to establish UDP connections...`);
      
      // 等待每个 Edge 都注册了其他 Edge 的端点并完成 TLS 连接握手
      await sleep(2000); // 基础等待时间让通知传递
      
      // 验证 Edge 间连接：需要注册且实际已连接（TLS 握手完成）
      let attempts = 0;
      const maxAttempts = 30; // 增加最大尝试次数
      while (attempts < maxAttempts) {
        let allConnected = true;
        
        for (const edge of activeEdges) {
          const voiceManager = edge.getVoiceManager();
          const voiceTransport = voiceManager?.getVoiceTransport();
          if (voiceTransport) {
            const registeredIds = voiceTransport.getRegisteredEdgeIds();
            const expectedCount = activeEdges.length - 1; // 不包括自己
            
            if (registeredIds.length < expectedCount) {
              allConnected = false;
              debugLog(`Edge ${edge.getConfig().server_id} has ${registeredIds.length}/${expectedCount} endpoints registered`);
              break;
            }
            
            // 额外检查：确认 TLS 连接已真正建立（不只是注册端点）
            for (const peerId of registeredIds) {
              if (!voiceTransport.isEdgeConnected(peerId)) {
                allConnected = false;
                debugLog(`Edge ${edge.getConfig().server_id} -> Edge ${peerId}: registered but TLS not yet connected`);
                break;
              }
            }
            if (!allConnected) break;
          }
        }
        
        if (allConnected) {
          debugLog('All Edge servers have registered peer endpoints and TLS connections established');
          break;
        }
        
        attempts++;
        await sleep(200);
      }
      
      if (attempts >= maxAttempts) {
        console.warn('Warning: Not all Edge servers completed TLS connection establishment within timeout');
        // 额外等待，让连接有更多时间完成
        await sleep(1000);
      }
    } else if (USE_RUST) {
      // Rust 模式：等待 Edge 注册到 Hub 后再继续
      const rustEdgeCount = [edgeProcess, edgeProcess2, edgeProcess3, edgeProcess4].filter(Boolean).length;
      if (rustEdgeCount > 0) {
        debugLog(`[RUST] Waiting for ${rustEdgeCount} Edge server(s) to register with Hub...`);
        await sleep(1500);
      }
    }

    console.log(`✓ All servers started successfully (${USE_RUST ? 'Rust binary' : 'in-process'} mode)!`);

  } catch (error) {
    console.error('Failed to setup test environment:', error);
    // Cleanup on error
    if (edgeProcess4) await edgeProcess4.stop().catch(() => {});
    if (edgeProcess3) await edgeProcess3.stop().catch(() => {});
    if (edgeProcess2) await edgeProcess2.stop().catch(() => {});
    if (edgeProcess) await edgeProcess.stop().catch(() => {});
    if (hubProcess) await hubProcess.stop().catch(() => {});
    if (edgeServer4) await edgeServer4.stop().catch(() => {});
    if (edgeServer3) await edgeServer3.stop().catch(() => {});
    if (edgeServer2) await edgeServer2.stop().catch(() => {});
    if (edgeServer) await edgeServer.stop().catch(() => {});
    if (hubServer) await hubServer.stop().catch(() => {});
    if (authServer) await authServer.stop().catch(() => {});
    throw error;
  }

  const realCleanup = async () => {
    debugLog('Cleaning up test environment...');

    // Stop Edge servers first (in reverse order), checking port release after each
    if (edgeProcess4) {
      try { await edgeProcess4.stop(); debugLog('[RUST] Edge process 4 stopped'); } catch (e) { console.warn('Error stopping Rust edge 4:', e); }
    }
    if (edgeServer4) {
      try {
        await edgeServer4.stop();
        debugLog('Edge server 4 stopped');
        // Wait for Edge 4 ports to be released
        await waitForPortsAvailable([edgePort4, edgeEdgePort4, edgeUdpPort4], 3000);
      } catch (error) {
        console.warn('Error stopping edge server 4:', error);
      }
    }

    if (edgeProcess3) {
      try { await edgeProcess3.stop(); debugLog('[RUST] Edge process 3 stopped'); } catch (e) { console.warn('Error stopping Rust edge 3:', e); }
    }
    if (edgeServer3) {
      try {
        await edgeServer3.stop();
        debugLog('Edge server 3 stopped');
        // Wait for Edge 3 ports to be released
        await waitForPortsAvailable([edgePort3, edgeEdgePort3, edgeUdpPort3], 3000);
      } catch (error) {
        console.warn('Error stopping edge server 3:', error);
      }
    }

    if (edgeProcess2) {
      try { await edgeProcess2.stop(); debugLog('[RUST] Edge process 2 stopped'); } catch (e) { console.warn('Error stopping Rust edge 2:', e); }
    }
    if (edgeServer2) {
      try {
        await edgeServer2.stop();
        debugLog('Edge server 2 stopped');
        // Wait for Edge 2 ports to be released
        await waitForPortsAvailable([edgePort2, edgeEdgePort2, edgeUdpPort2], 3000);
      } catch (error) {
        console.warn('Error stopping edge server 2:', error);
      }
    }

    if (edgeProcess) {
      try { await edgeProcess.stop(); debugLog('[RUST] Edge process 1 stopped'); } catch (e) { console.warn('Error stopping Rust edge 1:', e); }
    }
    if (edgeServer) {
      try {
        await edgeServer.stop();
        debugLog('Edge server 1 stopped');
        // Wait for Edge 1 ports to be released
        await waitForPortsAvailable([edgePort, edgeEdgePort, edgeUdpPort], 3000);
      } catch (error) {
        console.warn('Error stopping edge server 1:', error);
      }
    }

    // Now stop Hub after all Edge servers have disconnected
    if (hubProcess) {
      try { await hubProcess.stop(); debugLog('[RUST] Hub process stopped'); } catch (e) { console.warn('Error stopping Rust hub:', e); }
    }
    if (hubServer) {
      try {
        await hubServer.stop();
        debugLog('Hub server stopped');
        // Wait for Hub ports to be released
        await waitForPortsAvailable([hubPort, controlPort, webApiPort], 5000);
      } catch (error) {
        console.warn('Error stopping hub server:', error);
      }
    }

    if (authServer) {
      try {
        await authServer.stop();
        debugLog('Auth server stopped');
        // Wait for auth port to be released
        await waitForPortAvailable(authPort, 2000);
      } catch (error) {
        console.warn('Error stopping auth server:', error);
      }
    }

    // Final verification that all ports are released
    const portsToCheck = [authPort, hubPort, edgePort, edgeEdgePort, edgePort2, edgeEdgePort2, edgePort3, edgeEdgePort3, edgePort4, edgeEdgePort4, controlPort, webApiPort].filter(p => p > 0);
    const allPortsAvailable = await waitForPortsAvailable(portsToCheck, 5000);
    
    if (!allPortsAvailable) {
      console.warn('Some ports may still be in use after cleanup');
    }

    debugLog('Cleanup completed');
  };

  refCount = 1;
  globalTestEnvironment = { 
    hubServer, 
    edgeServer,
    edgeServer2,
    edgeServer3,
    edgeServer4,
    hubProcess,
    edgeProcess,
    edgeProcess2,
    edgeProcess3,
    edgeProcess4,
    authServer,
    authPort,
    hubPort,
    controlPort,
    webApiPort,
    edgePort,
    edgeEdgePort,
    edgeUdpPort,
    edgePort2,
    edgeEdgePort2,
    edgeUdpPort2,
    edgePort3,
    edgeEdgePort3,
    edgeUdpPort3,
    edgePort4,
    edgeEdgePort4,
    edgeUdpPort4,
    cleanup: async () => {
      refCount--;
      debugLog(`Test environment cleanup called (refCount: ${refCount})`);
      if (refCount === 0) {
        await realCleanup();
        globalTestEnvironment = null;
        debugLog('Global test environment cleared');
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

/**
 * 等待某个条件为真，带超时
 * @param checkFn 检查条件的函数
 * @param timeout 超时时间（毫秒）
 * @param interval 检查间隔（毫秒）
 * @param description 条件描述，用于日志
 */
export async function waitForCondition(
  checkFn: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 50,
  description: string = 'condition'
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const result = await checkFn();
    if (result) {
      debugLog(`✓ ${description} satisfied after ${Date.now() - startTime}ms`);
      return true;
    }
    await sleep(interval);
  }
  
  debugLog(`✗ ${description} timeout after ${timeout}ms`);
  return false;
}

/**
 * 等待端口可用（已释放）
 */
export async function waitForPortAvailable(port: number, timeout: number = 5000): Promise<boolean> {
  return waitForCondition(
    () => isPortAvailable(port),
    timeout,
    100,
    `port ${port} to be available`
  );
}

/**
 * 等待多个端口全部可用
 */
export async function waitForPortsAvailable(ports: number[], timeout: number = 10000): Promise<boolean> {
  const startTime = Date.now();
  
  for (const port of ports) {
    if (port === 0) continue; // Skip unallocated ports
    
    // Check remaining time at the start of iteration
    const elapsedTime = Date.now() - startTime;
    const remainingTime = Math.max(0, timeout - elapsedTime);
    
    if (remainingTime === 0) {
      console.warn(`Timeout waiting for ports. Port ${port} not yet checked.`);
      return false;
    }
    
    const available = await waitForPortAvailable(port, remainingTime);
    if (!available) {
      console.warn(`Warning: Port ${port} may still be in use after cleanup`);
      return false;
    }
  }
  
  debugLog(`✓ All ${ports.filter(p => p > 0).length} ports are now available`);
  return true;
}

// Global cleanup handler
process.on('beforeExit', async () => {
  if (globalTestEnvironment && refCount > 0) {
    debugLog('Process beforeExit: Cleaning up test environment...');
    refCount = 0;
    try {
      const env = globalTestEnvironment;
      globalTestEnvironment = null;
      
      if (env.edgeProcess4) await env.edgeProcess4.stop().catch(() => {});
      if (env.edgeProcess3) await env.edgeProcess3.stop().catch(() => {});
      if (env.edgeProcess2) await env.edgeProcess2.stop().catch(() => {});
      if (env.edgeProcess) await env.edgeProcess.stop().catch(() => {});
      if (env.hubProcess) await env.hubProcess.stop().catch(() => {});
      if (env.edgeServer4) await env.edgeServer4.stop().catch(() => {});
      if (env.edgeServer3) await env.edgeServer3.stop().catch(() => {});
      if (env.edgeServer2) await env.edgeServer2.stop().catch(() => {});
      if (env.edgeServer) await env.edgeServer.stop().catch(() => {});
      if (env.hubServer) await env.hubServer.stop().catch(() => {});
      if (env.authServer) await env.authServer.stop().catch(() => {});
      
      await sleep(500);
    } catch (error) {
      console.warn('Error during global cleanup:', error);
    }
  }
});

// Handle SIGINT (Ctrl+C) and SIGTERM
const handleSignal = async (signal: string) => {
  console.log(`\nReceived ${signal}, cleaning up...`);
  if (globalTestEnvironment && refCount > 0) {
    refCount = 0;
    const env = globalTestEnvironment;
    globalTestEnvironment = null;

    try {
      if (env.edgeProcess4) await env.edgeProcess4.stop().catch(() => {});
      if (env.edgeProcess3) await env.edgeProcess3.stop().catch(() => {});
      if (env.edgeProcess2) await env.edgeProcess2.stop().catch(() => {});
      if (env.edgeProcess) await env.edgeProcess.stop().catch(() => {});
      if (env.hubProcess) await env.hubProcess.stop().catch(() => {});
      if (env.edgeServer4) await env.edgeServer4.stop();
      if (env.edgeServer3) await env.edgeServer3.stop();
      if (env.edgeServer2) await env.edgeServer2.stop();
      if (env.edgeServer) await env.edgeServer.stop();
      if (env.hubServer) await env.hubServer.stop();
      if (env.authServer) await env.authServer.stop();
    } catch (e) {
      console.error('Error during cleanup:', e);
    }
  }
  
  // Exit immediately
  process.exit(0);
};

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

