/**
 * 数据库 Worker 线程
 * 使用 Node.js 22+ 内置的 SQLite 模块执行同步数据库操作
 * 通过 Worker 线程实现异步化，避免阻塞主线程
 */

import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

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

let db: DatabaseSync | null = null;
const preparedStatements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

/**
 * 处理来自主线程的消息
 */
function handleMessage(message: WorkerMessage): void {
  const response: WorkerResponse = {
    id: message.id,
    success: false,
  };

  try {
    switch (message.type) {
      case 'init':
        if (!message.dbPath) {
          throw new Error('Database path is required for init');
        }
        db = new DatabaseSync(message.dbPath);
        response.success = true;
        response.result = { initialized: true };
        break;

      case 'exec':
        if (!db) {
          throw new Error('Database not initialized');
        }
        if (!message.sql) {
          throw new Error('SQL is required for exec');
        }
        db.exec(message.sql);
        response.success = true;
        response.result = { executed: true };
        break;

      case 'prepare':
        if (!db) {
          throw new Error('Database not initialized');
        }
        if (!message.sql) {
          throw new Error('SQL is required for prepare');
        }
        // Cache the prepared statement by SQL
        const stmt = db.prepare(message.sql);
        preparedStatements.set(message.sql, stmt);
        response.success = true;
        response.result = { prepared: true };
        break;

      case 'run': {
        if (!db) {
          throw new Error('Database not initialized');
        }
        if (!message.sql) {
          throw new Error('SQL is required for run');
        }

        // Get or create prepared statement
        let stmt = preparedStatements.get(message.sql);
        if (!stmt) {
          stmt = db.prepare(message.sql);
          preparedStatements.set(message.sql, stmt);
        }

        // Convert params to proper types for SQLite
        const params = (message.params || []).map(p => {
          if (p === null || p === undefined) return null;
          if (typeof p === 'number' || typeof p === 'string' || typeof p === 'bigint') return p;
          if (Buffer.isBuffer(p)) return p;
          return String(p);
        });
        const result = stmt.run(...params);
        response.success = true;
        response.result = {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
        break;
      }

      case 'get': {
        if (!db) {
          throw new Error('Database not initialized');
        }
        if (!message.sql) {
          throw new Error('SQL is required for get');
        }

        // Get or create prepared statement
        let stmt = preparedStatements.get(message.sql);
        if (!stmt) {
          stmt = db.prepare(message.sql);
          preparedStatements.set(message.sql, stmt);
        }

        // Convert params to proper types for SQLite
        const params = (message.params || []).map(p => {
          if (p === null || p === undefined) return null;
          if (typeof p === 'number' || typeof p === 'string' || typeof p === 'bigint') return p;
          if (Buffer.isBuffer(p)) return p;
          return String(p);
        });
        const result = stmt.get(...params);
        response.success = true;
        response.result = result || null;
        break;
      }

      case 'all': {
        if (!db) {
          throw new Error('Database not initialized');
        }
        if (!message.sql) {
          throw new Error('SQL is required for all');
        }

        // Get or create prepared statement
        let stmt = preparedStatements.get(message.sql);
        if (!stmt) {
          stmt = db.prepare(message.sql);
          preparedStatements.set(message.sql, stmt);
        }

        // Convert params to proper types for SQLite
        const params = (message.params || []).map(p => {
          if (p === null || p === undefined) return null;
          if (typeof p === 'number' || typeof p === 'string' || typeof p === 'bigint') return p;
          if (Buffer.isBuffer(p)) return p;
          return String(p);
        });
        const result = stmt.all(...params);
        response.success = true;
        response.result = result;
        break;
      }

      case 'close':
        if (db) {
          // Clear all prepared statements
          preparedStatements.clear();
          db.close();
          db = null;
        }
        response.success = true;
        response.result = { closed: true };
        break;

      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  } catch (error) {
    response.success = false;
    response.error = error instanceof Error ? error.message : String(error);
  }

  parentPort?.postMessage(response);
}

// 监听主线程的消息
if (parentPort) {
  parentPort.on('message', handleMessage);
} else {
  console.error('Worker started without parentPort');
  process.exit(1);
}
