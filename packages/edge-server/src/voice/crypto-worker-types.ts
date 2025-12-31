/**
 * Worker Thread 通信协议
 * 
 * 定义主线程和 Worker 之间的消息格式
 */

/**
 * Worker 消息类型
 */
export enum WorkerMessageType {
  /** 初始化 Worker */
  INIT = 'init',
  /** 设置加密密钥 */
  SET_KEY = 'set_key',
  /** 加密操作 */
  ENCRYPT = 'encrypt',
  /** 解密操作 */
  DECRYPT = 'decrypt',
  /** 移除会话 */
  REMOVE_SESSION = 'remove_session',
  /** 获取统计信息 */
  GET_STATS = 'get_stats',
  /** 清理过期会话 */
  CLEANUP = 'cleanup',
}

/**
 * Worker 响应类型
 */
export enum WorkerResponseType {
  /** 初始化成功 */
  INIT_SUCCESS = 'init_success',
  /** 密钥设置成功 */
  SET_KEY_SUCCESS = 'set_key_success',
  /** 加密成功 */
  ENCRYPT_SUCCESS = 'encrypt_success',
  /** 解密成功 */
  DECRYPT_SUCCESS = 'decrypt_success',
  /** 移除会话成功 */
  REMOVE_SESSION_SUCCESS = 'remove_session_success',
  /** 统计信息响应 */
  STATS_RESPONSE = 'stats_response',
  /** 清理完成 */
  CLEANUP_SUCCESS = 'cleanup_success',
  /** 错误响应 */
  ERROR = 'error',
}

/**
 * 基础消息接口
 */
export interface BaseWorkerMessage {
  type: WorkerMessageType;
  requestId: string;
}

/**
 * 初始化消息
 */
export interface InitMessage extends BaseWorkerMessage {
  type: WorkerMessageType.INIT;
  workerId: number;
}

/**
 * 设置密钥消息
 */
export interface SetKeyMessage extends BaseWorkerMessage {
  type: WorkerMessageType.SET_KEY;
  compositeKey: string;
  key: Uint8Array;
  encryptIV: Uint8Array;
  decryptIV: Uint8Array;
}

/**
 * 加密消息
 */
export interface EncryptMessage extends BaseWorkerMessage {
  type: WorkerMessageType.ENCRYPT;
  compositeKey: string;
  data: Uint8Array;
}

/**
 * 解密消息
 */
export interface DecryptMessage extends BaseWorkerMessage {
  type: WorkerMessageType.DECRYPT;
  compositeKey: string;
  data: Uint8Array;
}

/**
 * 移除会话消息
 */
export interface RemoveSessionMessage extends BaseWorkerMessage {
  type: WorkerMessageType.REMOVE_SESSION;
  compositeKey: string;
}

/**
 * 获取统计信息消息
 */
export interface GetStatsMessage extends BaseWorkerMessage {
  type: WorkerMessageType.GET_STATS;
}

/**
 * 清理消息
 */
export interface CleanupMessage extends BaseWorkerMessage {
  type: WorkerMessageType.CLEANUP;
}

/**
 * Worker 消息联合类型
 */
export type WorkerMessage =
  | InitMessage
  | SetKeyMessage
  | EncryptMessage
  | DecryptMessage
  | RemoveSessionMessage
  | GetStatsMessage
  | CleanupMessage;

/**
 * 基础响应接口
 */
export interface BaseWorkerResponse {
  type: WorkerResponseType;
  requestId: string;
}

/**
 * 初始化成功响应
 */
export interface InitSuccessResponse extends BaseWorkerResponse {
  type: WorkerResponseType.INIT_SUCCESS;
  workerId: number;
}

/**
 * 密钥设置成功响应
 */
export interface SetKeySuccessResponse extends BaseWorkerResponse {
  type: WorkerResponseType.SET_KEY_SUCCESS;
  compositeKey: string;
}

/**
 * 加密成功响应
 */
export interface EncryptSuccessResponse extends BaseWorkerResponse {
  type: WorkerResponseType.ENCRYPT_SUCCESS;
  data: Uint8Array;
}

/**
 * 解密成功响应
 */
export interface DecryptSuccessResponse extends BaseWorkerResponse {
  type: WorkerResponseType.DECRYPT_SUCCESS;
  data: Uint8Array;
  valid: boolean;
}

/**
 * 移除会话成功响应
 */
export interface RemoveSessionSuccessResponse extends BaseWorkerResponse {
  type: WorkerResponseType.REMOVE_SESSION_SUCCESS;
  compositeKey: string;
}

/**
 * Worker 统计信息
 */
export interface WorkerStats {
  workerId: number;
  sessionsCount: number;
  encryptCount: number;
  decryptCount: number;
  errorCount: number;
  uptime: number;
}

/**
 * 统计信息响应
 */
export interface StatsResponse extends BaseWorkerResponse {
  type: WorkerResponseType.STATS_RESPONSE;
  stats: WorkerStats;
}

/**
 * 清理成功响应
 */
export interface CleanupSuccessResponse extends BaseWorkerResponse {
  type: WorkerResponseType.CLEANUP_SUCCESS;
  removedCount: number;
}

/**
 * 错误响应
 */
export interface ErrorResponse extends BaseWorkerResponse {
  type: WorkerResponseType.ERROR;
  error: string;
  originalType?: WorkerMessageType;
}

/**
 * Worker 响应联合类型
 */
export type WorkerResponse =
  | InitSuccessResponse
  | SetKeySuccessResponse
  | EncryptSuccessResponse
  | DecryptSuccessResponse
  | RemoveSessionSuccessResponse
  | StatsResponse
  | CleanupSuccessResponse
  | ErrorResponse;

/**
 * Worker 配置
 */
export interface CryptoWorkerConfig {
  /** Worker ID */
  workerId: number;
  /** 会话过期时间（毫秒） */
  sessionTimeout?: number;
}

/**
 * Worker Pool 配置
 */
export interface CryptoWorkerPoolConfig {
  /** Worker 数量 */
  workerCount: number;

  /** Worker 超时时间（毫秒） */
  workerTimeout?: number;
  /** 最大队列长度 */
  maxQueueLength?: number;
}
