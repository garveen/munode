/**
 * Permission Worker Manager
 *
 * 维护一个 permission-worker 线程池，对外提供
 * calculateBulkEnterPermissions() 接口，用于批量计算
 * 用户对所有频道的进入权限（can_enter / is_enter_restricted）。
 *
 * 设计原则：
 * - 每次请求携带完整数据快照（频道列表 + ACL 映射），worker 无需访问 DB
 * - 轮询负载均衡，支持并发
 * - 超时保护（默认 10s）
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Logger } from '@munode/common';
import type {
  PermWorkerRequest,
  PermWorkerResponse,
  PermWorkerChannel,
  PermWorkerACLEntry,
  PermWorkerUserInfo,
  PermWorkerChannelResult,
} from './permission-worker.js';

interface PendingRequest {
  resolve: (results: PermWorkerChannelResult[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PermissionWorkerManager {
  private workers: Worker[] = [];
  private pendingRequests = new Map<number, PendingRequest>();
  private nextWorkerIndex = 0;
  private requestCounter = 0;
  private workerScriptPath: string;
  private readonly workerCount: number;
  private readonly timeoutMs: number;
  private isShuttingDown = false;

  constructor(
    private readonly logger: Logger,
    options?: { workerCount?: number; timeoutMs?: number }
  ) {
    this.workerCount = options?.workerCount ?? 2;
    this.timeoutMs = options?.timeoutMs ?? 10_000;

    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);

    const candidates = [
      join(currentDir, 'permission-worker.js'),
      join(currentDir, '..', 'dist', 'permission-worker.js'),
    ];

    if (process.env.MUNODE_PERM_WORKER_PATH) {
      this.workerScriptPath = process.env.MUNODE_PERM_WORKER_PATH;
    } else {
      const found = candidates.find(p => existsSync(p));
      this.workerScriptPath = found ?? candidates[0];
    }

    this.logger.info(`PermissionWorkerManager: script=${this.workerScriptPath}, workers=${this.workerCount}`);
  }

  async initialize(): Promise<void> {
    for (let i = 0; i < this.workerCount; i++) {
      this.spawnWorker(i);
    }
    this.logger.info(`PermissionWorkerManager initialized (${this.workerCount} workers)`);
  }

  private spawnWorker(index: number): void {
    const worker = new Worker(this.workerScriptPath);

    worker.on('message', (response: PermWorkerResponse) => {
      const pending = this.pendingRequests.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(response.id);
      if (response.success && response.results) {
        pending.resolve(response.results);
      } else {
        pending.reject(new Error(response.error ?? 'Permission worker error'));
      }
    });

    worker.on('error', (err) => {
      this.logger.error(`PermissionWorker[${index}] error:`, err);
      if (!this.isShuttingDown) {
        // 重启 worker
        this.workers[index] = new Worker(this.workerScriptPath);
        this.attachWorkerListeners(this.workers[index], index);
      }
    });

    worker.on('exit', (code) => {
      if (!this.isShuttingDown && code !== 0) {
        this.logger.warn(`PermissionWorker[${index}] exited with code ${code}, restarting`);
        this.workers[index] = new Worker(this.workerScriptPath);
        this.attachWorkerListeners(this.workers[index], index);
      }
    });

    this.workers[index] = worker;
  }

  private attachWorkerListeners(worker: Worker, index: number): void {
    worker.on('message', (response: PermWorkerResponse) => {
      const pending = this.pendingRequests.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(response.id);
      if (response.success && response.results) {
        pending.resolve(response.results);
      } else {
        pending.reject(new Error(response.error ?? 'Permission worker error'));
      }
    });
    worker.on('error', (err) => {
      this.logger.error(`PermissionWorker[${index}] error (restarted):`, err);
    });
  }

  /**
   * 批量计算用户对一组频道的进入权限
   * @param channels 频道列表
   * @param aclMap   channel_id => ACL 条目列表
   * @param user     用户信息
   */
  async calculateBulkEnterPermissions(
    channels: PermWorkerChannel[],
    aclMap: Map<number, PermWorkerACLEntry[]>,
    user: PermWorkerUserInfo
  ): Promise<PermWorkerChannelResult[]> {
    if (this.workers.length === 0) {
      throw new Error('PermissionWorkerManager not initialized');
    }

    const id = ++this.requestCounter;

    // 序列化 aclMap 为普通对象（postMessage 要求 structuredClone 兼容）
    const aclMapObj: Record<string, PermWorkerACLEntry[]> = {};
    for (const [k, v] of aclMap) {
      aclMapObj[String(k)] = v;
    }

    const request: PermWorkerRequest = { id, channels, aclMap: aclMapObj, user };

    return new Promise<PermWorkerChannelResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`PermissionWorker request ${id} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      // 轮询选择 worker
      const workerIndex = this.nextWorkerIndex % this.workers.length;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      this.workers[workerIndex].postMessage(request);
    });
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    // 取消所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('PermissionWorkerManager shutting down'));
      this.pendingRequests.delete(id);
    }
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    this.logger.info('PermissionWorkerManager shut down');
  }
}

// 重新导出 worker 类型，方便外部使用
export type {
  PermWorkerChannel,
  PermWorkerACLEntry,
  PermWorkerUserInfo,
  PermWorkerChannelResult,
};
