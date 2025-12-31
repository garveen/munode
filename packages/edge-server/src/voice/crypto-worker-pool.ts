/**
 * Crypto Worker Pool
 * 
 * 管理多个 Crypto Worker 实例，实现负载均衡和任务分发
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';import { existsSync } from 'fs';import type { Logger } from 'winston';
import {
  WorkerMessageType,
  type WorkerMessage,
  type WorkerResponse,
  type CryptoWorkerPoolConfig,
  type WorkerStats,
} from './crypto-worker-types.js';

/**
 * Worker 实例信息
 */
interface WorkerInstance {
  id: number;
  worker: Worker;
  busy: boolean;
  taskCount: number;
  sessionAffinity: Set<string>; // 会话亲和：该 Worker 负责的会话
}

/**
 * 等待中的请求
 */
interface PendingRequest {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Crypto Worker Pool
 */
export class CryptoWorkerPool {
  private config: Required<CryptoWorkerPoolConfig>;
  private logger: Logger;
  private workers: WorkerInstance[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private workerScriptPath: string;
  private isShuttingDown = false;
  
  constructor(config: CryptoWorkerPoolConfig, logger: Logger) {
    this.config = {
      workerCount: config.workerCount,
      workerTimeout: config.workerTimeout ?? 5000,
      maxQueueLength: config.maxQueueLength ?? 10000,
    };
    this.logger = logger;
    
    // 解析 Worker 脚本路径 - 参考 database-worker-manager.ts 的模式
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);
    
    // 可能的路径列表：
    // - 当前文件在 dist/voice/crypto-worker-pool.d.ts，Worker 在 dist/voice/crypto-worker.js (类型声明文件)
    // - 当前文件在 dist/index.js (打包后)，Worker 在 dist/voice/crypto-worker.js
    // - 开发环境: tsx 从 src 运行，Worker 在 dist/voice/crypto-worker.js
    const possiblePaths = [
      join(currentDir, 'crypto-worker.js'),  // 同目录 (如果在 dist/voice/)
      join(currentDir, 'voice', 'crypto-worker.js'),  // 如果在 dist/ 根目录
      join(currentDir, '..', '..', 'dist', 'voice', 'crypto-worker.js'),  // 从 src 目录运行
    ];
    
    // 支持环境变量覆盖
    if (process.env.MUNODE_CRYPTO_WORKER_PATH) {
      this.workerScriptPath = process.env.MUNODE_CRYPTO_WORKER_PATH;
      this.logger.info(`使用环境变量指定的 Crypto Worker 路径: ${this.workerScriptPath}`);
    } else {
      // 尝试各个可能的路径，使用第一个存在的文件
      let foundPath: string | undefined;
      for (const path of possiblePaths) {
        if (existsSync(path)) {
          foundPath = path;
          break;
        }
      }
      
      if (foundPath) {
        this.workerScriptPath = foundPath;
      } else {
        // 默认使用第二个路径 (dist/voice)
        this.workerScriptPath = possiblePaths[1];
      }
      
      this.logger.info(`解析 Crypto Worker 路径: ${this.workerScriptPath} (当前目录: ${currentDir})`);
    }
    this.logger.debug(`Worker script path: ${this.workerScriptPath}`);
  }

  /**
   * 初始化 Worker Pool
   */
  async initialize(): Promise<void> {
    this.logger.info(`Initializing CryptoWorkerPool with ${this.config.workerCount} workers`);
    
    const initPromises: Promise<void>[] = [];
    
    for (let i = 0; i < this.config.workerCount; i++) {
      initPromises.push(this.createWorker(i));
    }
    
    await Promise.all(initPromises);
    
    this.logger.info('CryptoWorkerPool initialized successfully');
  }

  /**
   * 创建 Worker 实例
   */
  private async createWorker(workerId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const worker = new Worker(this.workerScriptPath);
        
        const workerInstance: WorkerInstance = {
          id: workerId,
          worker,
          busy: false,
          taskCount: 0,
          sessionAffinity: new Set(),
        };
        
        // 临时监听器：等待 Worker 就绪
        const onReady = (msg: WorkerResponse | { type: string; workerId: number }): void => {
          if ('type' in msg && msg.type === 'ready') {
            this.logger.debug(`Worker ${workerId} is ready`);
            // 移除临时监听器
            worker.off('message', onReady);
            // 设置正式的消息处理器
            worker.on('message', (response: WorkerResponse) => {
              this.handleWorkerResponse(response);
            });
            resolve();
          }
        };
        
        worker.on('message', onReady);
        
        // 监听错误
        worker.on('error', (error) => {
          this.logger.error(`Worker ${workerId} error:`, error);
          this.handleWorkerCrash(workerInstance);
        });
        
        // 监听退出
        worker.on('exit', (code) => {
          if (code !== 0) {
            this.logger.warn(`Worker ${workerId} exited with code ${code}`);
            this.handleWorkerCrash(workerInstance);
          }
        });
        
        this.workers.push(workerInstance);
        
      } catch (error) {
        this.logger.error(`Failed to create worker ${workerId}:`, error);
        reject(error);
      }
    });
  }

  /**
   * 处理 Worker 响应
   */
  private handleWorkerResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) {
      this.logger.warn(`Received response for unknown request: ${response.requestId}`);
      return;
    }
    
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.requestId);
    
    if (response.type === 'error') {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response);
    }
  }

  /**
   * 处理 Worker 崩溃
   */
  private handleWorkerCrash(workerInstance: WorkerInstance): void {
    this.logger.warn(`Handling crash for worker ${workerInstance.id}`);
    
    // 移除崩溃的 Worker
    const index = this.workers.indexOf(workerInstance);
    if (index > -1) {
      this.workers.splice(index, 1);
    }
    
    // 重新创建 Worker
    this.createWorker(workerInstance.id).catch((error) => {
      this.logger.error(`Failed to recreate worker ${workerInstance.id}:`, error);
    });
  }

  /**
   * 生成请求 ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${this.requestIdCounter++}`;
  }

  /**
   * 选择 Worker（使用会话亲和策略）
   * 
   * 会话亲和策略确保同一会话的所有操作（setKey/encrypt/decrypt）
   * 都路由到同一个 Worker，这对于有状态的 OCB2-AES128 加密是必需的。
   * 
   * 首次分配时会选择最空闲的 Worker，自动实现负载均衡。
   */
  private selectWorker(compositeKey?: string): WorkerInstance | undefined {
    if (this.workers.length === 0) {
      return undefined;
    }
    
    if (!compositeKey) {
      // 无会话关联，选择最空闲的 Worker
      return this.selectWorkerLeastBusy();
    }
    
    // 查找已有会话的 Worker
    for (const worker of this.workers) {
      if (worker.sessionAffinity.has(compositeKey)) {
        return worker;
      }
    }
    
    // 首次分配：选择最空闲的 Worker 并记录亲和
    const worker = this.selectWorkerLeastBusy();
    worker.sessionAffinity.add(compositeKey);
    return worker;
  }

  /**
   * 选择最少繁忙的 Worker
   */
  private selectWorkerLeastBusy(): WorkerInstance {
    return this.workers.reduce((least, current) => 
      current.taskCount < least.taskCount ? current : least
    );
  }

  /**
   * 发送消息到 Worker
   */
  private async sendMessage(
    worker: WorkerInstance,
    message: WorkerMessage
  ): Promise<WorkerResponse> {
    // 如果正在关闭，拒绝新请求 (除了 cleanup 消息)
    if (this.isShuttingDown && message.type !== WorkerMessageType.CLEANUP) {
      return Promise.reject(new Error('Worker pool is shutting down'));
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error(`Worker request timeout: ${message.requestId}`));
      }, this.config.workerTimeout);
      
      this.pendingRequests.set(message.requestId, {
        resolve,
        reject,
        timeout,
      });
      
      worker.taskCount++;
      worker.busy = true;
      
      try {
        worker.worker.postMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(message.requestId);
        worker.taskCount--;
        worker.busy = false;
        reject(error);
      }
      
      // 标记为不繁忙（异步）
      setTimeout(() => {
        worker.taskCount--;
        worker.busy = worker.taskCount > 0;
      }, 0);
    });
  }

  /**
   * 设置加密密钥
   */
  async setKey(
    compositeKey: string,
    key: Buffer,
    encryptIV: Buffer,
    decryptIV: Buffer
  ): Promise<void> {
    const worker = this.selectWorker(compositeKey);
    if (!worker) {
      throw new Error('No workers available');
    }
    
    const message: WorkerMessage = {
      type: WorkerMessageType.SET_KEY,
      requestId: this.generateRequestId(),
      compositeKey,
      key: new Uint8Array(key),
      encryptIV: new Uint8Array(encryptIV),
      decryptIV: new Uint8Array(decryptIV),
    } as WorkerMessage;
    
    await this.sendMessage(worker, message);
  }

  /**
   * 加密数据
   */
  async encrypt(compositeKey: string, data: Buffer): Promise<Buffer> {
    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }
    
    const worker = this.selectWorker(compositeKey);
    if (!worker) {
      throw new Error('No workers available');
    }
    
    const message: WorkerMessage = {
      type: WorkerMessageType.ENCRYPT,
      requestId: this.generateRequestId(),
      compositeKey,
      data: new Uint8Array(data),
    } as WorkerMessage;
    
    const response = await this.sendMessage(worker, message);
    if (response.type === 'encrypt_success') {
      return Buffer.from(response.data);
    }
    
    throw new Error('Encryption failed');
  }

  /**
   * 解密数据
   */
  async decrypt(compositeKey: string, data: Buffer): Promise<{ plain: Buffer; valid: boolean }> {
    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }
    
    const worker = this.selectWorker(compositeKey);
    if (!worker) {
      throw new Error('No workers available');
    }
    
    const message: WorkerMessage = {
      type: WorkerMessageType.DECRYPT,
      requestId: this.generateRequestId(),
      compositeKey,
      data: new Uint8Array(data),
    } as WorkerMessage;
    
    const response = await this.sendMessage(worker, message);
    if (response.type === 'decrypt_success') {
      return {
        plain: Buffer.from(response.data),
        valid: response.valid,
      };
    }
    
    throw new Error('Decryption failed');
  }

  /**
   * 移除会话
   */
  async removeSession(compositeKey: string): Promise<void> {
    // 如果正在关闭，忽略 remove session 请求
    if (this.isShuttingDown) {
      return;
    }
    
    const worker = this.selectWorker(compositeKey);
    if (!worker) {
      return;
    }
    
    const message: WorkerMessage = {
      type: WorkerMessageType.REMOVE_SESSION,
      requestId: this.generateRequestId(),
      compositeKey,
    } as WorkerMessage;
    
    try {
      await this.sendMessage(worker, message);
      worker.sessionAffinity.delete(compositeKey);
    } catch (error) {
      // 如果 Worker Pool 正在关闭，忽略错误
      if (error instanceof Error && error.message.includes('shutting down')) {
        return;
      }
      throw error;
    }
  }

  /**
   * 获取所有 Worker 的统计信息
   */
  async getStats(): Promise<WorkerStats[]> {
    const statsPromises = this.workers.map(async (worker) => {
      const message: WorkerMessage = {
        type: WorkerMessageType.GET_STATS,
        requestId: this.generateRequestId(),
      } as WorkerMessage;
      
      const response = await this.sendMessage(worker, message);
      if (response.type === 'stats_response') {
        return response.stats;
      }
      throw new Error('Failed to get stats');
    });
    
    return Promise.all(statsPromises);
  }

  /**
   * 清理所有 Worker
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up CryptoWorkerPool');
    this.isShuttingDown = true;
    
    const cleanupPromises = this.workers.map(async (worker) => {
      const message: WorkerMessage = {
        type: WorkerMessageType.CLEANUP,
        requestId: this.generateRequestId(),
      } as WorkerMessage;
      
      try {
        // 先发送 cleanup 消息并等待响应
        await this.sendMessage(worker, message);
      } catch (error) {
        // 忽略清理过程中的错误，确保继续清理其他 Worker
        this.logger.debug(`Worker ${worker.id} cleanup message failed (expected during shutdown):`, error);
      }
      
      try {
        // 然后终止 Worker
        await worker.worker.terminate();
      } catch (error) {
        this.logger.error(`Error terminating worker ${worker.id}:`, error);
      }
    });
    
    await Promise.all(cleanupPromises);
    this.workers = [];
    this.pendingRequests.clear();
    
    this.logger.info('CryptoWorkerPool cleanup complete');
  }

  /**
   * 获取 Worker 数量
   */
  get workerCount(): number {
    return this.workers.length;
  }

  /**
   * 获取等待队列长度
   */
  get queueLength(): number {
    return this.pendingRequests.size;
  }
}
