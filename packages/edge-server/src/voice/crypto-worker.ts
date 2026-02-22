/**
 * Crypto Worker
 * 
 * 在 Worker Thread 中执行 OCB2-AES128 加密/解密操作
 */

import { parentPort } from 'worker_threads';
import { OCB2AES128, createLogger } from '@munode/common';

const logger = createLogger({ service: 'edge-crypto-worker' });
import type {
  WorkerMessage,
  WorkerResponse,
  WorkerMessageType,
  WorkerResponseType,
  WorkerStats,
} from './crypto-worker-types.js';

// Worker 状态
let workerId = 0;
let startTime = Date.now();

// 会话加密器映射: compositeKey -> OCB2AES128
const cryptoMap = new Map<string, OCB2AES128>();

// 统计信息
const stats = {
  encryptCount: 0,
  decryptCount: 0,
  errorCount: 0,
};

/**
 * 发送响应到主线程
 */
function sendResponse(response: WorkerResponse): void {
  if (!parentPort) {
    throw new Error('Worker: parentPort is null');
  }
  parentPort.postMessage(response);
}

/**
 * 发送错误响应
 */
function sendError(requestId: string, error: string, originalType?: WorkerMessageType): void {
  stats.errorCount++;
  sendResponse({
    type: 'error' as WorkerResponseType.ERROR,
    requestId,
    error,
    originalType,
  });
}

/**
 * 处理初始化消息
 */
function handleInit(msg: WorkerMessage): void {
  if (msg.type !== 'init') {
    sendError(msg.requestId, 'Invalid message type for init');
    return;
  }
  
  try {
    workerId = msg.workerId;
    startTime = Date.now();
    
    sendResponse({
      type: 'init_success' as WorkerResponseType.INIT_SUCCESS,
      requestId: msg.requestId,
      workerId,
    });
  } catch (error) {
    sendError(
      msg.requestId,
      error instanceof Error ? error.message : 'Unknown error',
      msg.type
    );
  }
}

/**
 * 处理设置密钥消息
 */
function handleSetKey(msg: WorkerMessage): void {
  if (msg.type !== 'set_key') {
    sendError(msg.requestId, 'Invalid message type for setKey');
    return;
  }
  
  try {
    const crypto = new OCB2AES128();
    crypto.setKey(
      Buffer.from(msg.key),
      Buffer.from(msg.encryptIV),
      Buffer.from(msg.decryptIV)
    );
    
    cryptoMap.set(msg.compositeKey, crypto);
    
    sendResponse({
      type: 'set_key_success' as WorkerResponseType.SET_KEY_SUCCESS,
      requestId: msg.requestId,
      compositeKey: msg.compositeKey,
    });
  } catch (error) {
    sendError(
      msg.requestId,
      error instanceof Error ? error.message : 'Unknown error',
      msg.type
    );
  }
}

/**
 * 处理加密消息
 */
function handleEncrypt(msg: WorkerMessage): void {
  if (msg.type !== 'encrypt') {
    sendError(msg.requestId, 'Invalid message type for encrypt');
    return;
  }
  
  try {
    const crypto = cryptoMap.get(msg.compositeKey);
    if (!crypto) {
      sendError(msg.requestId, `Crypto not found for key: ${msg.compositeKey}`, msg.type);
      return;
    }
    
    const encrypted = crypto.encrypt(Buffer.from(msg.data));
    stats.encryptCount++;
    
    sendResponse({
      type: 'encrypt_success' as WorkerResponseType.ENCRYPT_SUCCESS,
      requestId: msg.requestId,
      data: new Uint8Array(encrypted),
    });
  } catch (error) {
    sendError(
      msg.requestId,
      error instanceof Error ? error.message : 'Unknown error',
      msg.type
    );
  }
}

/**
 * 处理解密消息
 */
function handleDecrypt(msg: WorkerMessage): void {
  if (msg.type !== 'decrypt') {
    sendError(msg.requestId, 'Invalid message type for decrypt');
    return;
  }
  
  try {
    const crypto = cryptoMap.get(msg.compositeKey);
    if (!crypto) {
      sendError(msg.requestId, `Crypto not found for key: ${msg.compositeKey}`, msg.type);
      return;
    }
    
    const result = crypto.decrypt(Buffer.from(msg.data));
    stats.decryptCount++;
    
    sendResponse({
      type: 'decrypt_success' as WorkerResponseType.DECRYPT_SUCCESS,
      requestId: msg.requestId,
      data: result.valid ? new Uint8Array(result.data) : new Uint8Array(),
      valid: result.valid,
    });
  } catch (error) {
    sendError(
      msg.requestId,
      error instanceof Error ? error.message : 'Unknown error',
      msg.type
    );
  }
}

/**
 * 处理移除会话消息
 */
function handleRemoveSession(msg: WorkerMessage): void {
  if (msg.type !== 'remove_session') {
    sendError(msg.requestId, 'Invalid message type for removeSession');
    return;
  }
  
  try {
    cryptoMap.delete(msg.compositeKey);
    
    sendResponse({
      type: 'remove_session_success' as WorkerResponseType.REMOVE_SESSION_SUCCESS,
      requestId: msg.requestId,
      compositeKey: msg.compositeKey,
    });
  } catch (error) {
    sendError(
      msg.requestId,
      error instanceof Error ? error.message : 'Unknown error',
      msg.type
    );
  }
}

/**
 * 处理获取统计信息消息
 */
function handleGetStats(msg: WorkerMessage): void {
  if (msg.type !== 'get_stats') {
    sendError(msg.requestId, 'Invalid message type for getStats');
    return;
  }
  
  try {
    const workerStats: WorkerStats = {
      workerId,
      sessionsCount: cryptoMap.size,
      encryptCount: stats.encryptCount,
      decryptCount: stats.decryptCount,
      errorCount: stats.errorCount,
      uptime: Date.now() - startTime,
    };
    
    sendResponse({
      type: 'stats_response' as WorkerResponseType.STATS_RESPONSE,
      requestId: msg.requestId,
      stats: workerStats,
    });
  } catch (error) {
    sendError(
      msg.requestId,
      error instanceof Error ? error.message : 'Unknown error',
      msg.type
    );
  }
}

/**
 * 处理清理消息
 */
function handleCleanup(msg: WorkerMessage): void {
  if (msg.type !== 'cleanup') {
    sendError(msg.requestId, 'Invalid message type for cleanup');
    return;
  }
  
  try {
    const beforeCount = cryptoMap.size;
    cryptoMap.clear();
    const removedCount = beforeCount;
    
    sendResponse({
      type: 'cleanup_success' as WorkerResponseType.CLEANUP_SUCCESS,
      requestId: msg.requestId,
      removedCount,
    });
  } catch (error) {
    sendError(
      msg.requestId,
      error instanceof Error ? error.message : 'Unknown error',
      msg.type
    );
  }
}

/**
 * 消息处理器映射
 */
const messageHandlers = {
  init: handleInit,
  set_key: handleSetKey,
  encrypt: handleEncrypt,
  decrypt: handleDecrypt,
  remove_session: handleRemoveSession,
  get_stats: handleGetStats,
  cleanup: handleCleanup,
};

/**
 * Worker 入口
 */
if (parentPort) {
  parentPort.on('message', (msg: WorkerMessage) => {
    try {
      // 验证消息格式
      if (!msg || !msg.type || !msg.requestId) {
        logger.error('[Worker] Invalid message format:', { msg });
        return;
      }
      
      const handler = messageHandlers[msg.type];
      if (handler) {
        handler(msg);
      } else {
        sendError(msg.requestId, `Unknown message type: ${msg.type}`);
      }
    } catch (error) {
      logger.error('[Worker] Error handling message:', { error });
      if (msg && msg.requestId) {
        sendError(
          msg.requestId,
          error instanceof Error ? error.message : 'Unknown error in message handler'
        );
      }
    }
  });
  
  parentPort.on('error', (error) => {
    logger.error('[Worker] Port error:', { error });
  });
  
  // 通知主线程 Worker 已就绪
  parentPort.postMessage({ type: 'ready' });
}
