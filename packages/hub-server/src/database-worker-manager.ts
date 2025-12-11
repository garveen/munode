/**
 * 数据库 Worker 管理器
 * 管理与数据库 Worker 线程的通信，提供异步接口
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from '@munode/common';

const logger = createLogger({ service: 'database-worker-manager' });

interface WorkerMessage {
  id: number;
  type: 'init' | 'exec' | 'prepare' | 'run' | 'get' | 'all' | 'close';
  sql?: string;
  params?: unknown[];
  dbPath?: string;
}

interface WorkerResponse {
  id: number;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * 数据库 Worker 管理器类
 */
export class DatabaseWorkerManager {
  private worker: Worker | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private workerPath: string;
  private isInitialized = false;

  constructor() {
    // 计算 worker 文件路径
    // 在 ESM 中，我们需要使用 import.meta.url 来获取当前文件路径
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);
    
    // 检查是否在 src 目录运行（开发模式）还是 dist 目录（生产模式）
    if (currentDir.endsWith('src')) {
      // 开发模式：指向 dist 目录
      const distDir = join(currentDir, '..', 'dist');
      this.workerPath = join(distDir, 'database-worker.js');
    } else {
      // 生产模式：当前目录就是 dist 目录
      this.workerPath = join(currentDir, 'database-worker.js');
    }
  }

  /**
   * 初始化 Worker 和数据库
   */
  async init(dbPath: string): Promise<void> {
    if (this.isInitialized) {
      throw new Error('Database worker already initialized');
    }

    // 创建 Worker 线程
    this.worker = new Worker(this.workerPath);

    // 监听 Worker 消息
    this.worker.on('message', (response: WorkerResponse) => {
      this.handleWorkerResponse(response);
    });

    // 监听 Worker 错误
    this.worker.on('error', (error: Error) => {
      logger.error('Worker error:', error);
      // 拒绝所有待处理的请求
      for (const [id, request] of this.pendingRequests) {
        request.reject(new Error(`Worker error: ${error.message}`));
        this.pendingRequests.delete(id);
      }
    });

    // 监听 Worker 退出
    this.worker.on('exit', (code: number) => {
      if (code !== 0) {
        logger.error(`Worker exited with code ${code}`);
        // 拒绝所有待处理的请求
        for (const [id, request] of this.pendingRequests) {
          request.reject(new Error(`Worker exited with code ${code}`));
          this.pendingRequests.delete(id);
        }
      }
    });

    // 初始化数据库
    await this.sendMessage({ type: 'init', dbPath });
    this.isInitialized = true;
    logger.info('Database worker initialized', { dbPath });
  }

  /**
   * 执行 SQL 语句（无返回值）
   */
  async exec(sql: string): Promise<void> {
    await this.sendMessage({ type: 'exec', sql });
  }

  /**
   * 准备 SQL 语句（用于后续的 run/get/all）
   */
  async prepare(sql: string): Promise<void> {
    await this.sendMessage({ type: 'prepare', sql });
  }

  /**
   * 执行 SQL 语句并返回变更信息
   */
  async run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const result = await this.sendMessage({ type: 'run', sql, params });
    return result as { changes: number; lastInsertRowid: number | bigint };
  }

  /**
   * 执行 SQL 查询并返回第一行
   */
  async get(sql: string, ...params: unknown[]): Promise<unknown> {
    return await this.sendMessage({ type: 'get', sql, params });
  }

  /**
   * 执行 SQL 查询并返回所有行
   */
  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    const result = await this.sendMessage({ type: 'all', sql, params });
    return result as unknown[];
  }

  /**
   * 关闭数据库和 Worker
   */
  async close(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      await this.sendMessage({ type: 'close' });
      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      logger.info('Database worker closed');
    } catch (error) {
      logger.error('Error closing database worker:', error);
      // 强制终止 Worker
      if (this.worker) {
        await this.worker.terminate();
        this.worker = null;
        this.isInitialized = false;
      }
    }
  }

  /**
   * 发送消息到 Worker
   */
  private async sendMessage(message: Omit<WorkerMessage, 'id'>): Promise<unknown> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = this.requestId++;
    const fullMessage: WorkerMessage = { id, ...message };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker!.postMessage(fullMessage);

      // 设置超时（30秒）
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Database operation timeout: ${message.type}`));
      }, 30000);

      // 清理超时定时器
      const originalResolve = resolve;
      const originalReject = reject;
      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          originalResolve(value);
        },
        reject: (reason: Error) => {
          clearTimeout(timeout);
          originalReject(reason);
        },
      });
    });
  }

  /**
   * 处理 Worker 响应
   */
  private handleWorkerResponse(response: WorkerResponse): void {
    const request = this.pendingRequests.get(response.id);
    if (!request) {
      logger.warn('Received response for unknown request', { id: response.id });
      return;
    }

    this.pendingRequests.delete(response.id);

    if (response.success) {
      request.resolve(response.result);
    } else {
      request.reject(new Error(response.error || 'Unknown error'));
    }
  }
}
