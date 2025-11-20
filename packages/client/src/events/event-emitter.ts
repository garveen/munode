/**
 * ClientEventEmitter - 客户端事件发射器
 * 
 * 主要职责:
 * - 提供统一的事件总线
 * - 事件类型定义
 * - 事件订阅和发布
 * - 事件过滤
 */

import { EventEmitter } from 'events';
import type { ClientEvent, EventFilter } from '../types/client-types.js';

/**
 * 扩展的事件发射器，支持类型化事件
 */
export class ClientEventEmitter extends EventEmitter {
  private eventFilters: Map<string, EventFilter[]> = new Map();

  constructor() {
    super();
  }

  /**
   * 添加事件过滤器
   */
  addFilter(eventName: string, filter: EventFilter): void {
    if (!this.eventFilters.has(eventName)) {
      this.eventFilters.set(eventName, []);
    }
    this.eventFilters.get(eventName)!.push(filter);
  }

  /**
   * 移除事件过滤器
   */
  removeFilter(eventName: string, filter: EventFilter): void {
    const filters = this.eventFilters.get(eventName);
    if (filters) {
      const index = filters.indexOf(filter);
      if (index !== -1) {
        filters.splice(index, 1);
      }
    }
  }

  /**
   * 发射事件 (应用过滤器)
   */
  emitFiltered(eventName: string, event: ClientEvent): boolean {
    // 应用过滤器
    const filters = this.eventFilters.get(eventName);
    if (filters) {
      for (const filter of filters) {
        if (!filter(event)) {
          return false; // 事件被过滤
        }
      }
    }

    // 发射事件
    return this.emit(eventName, event);
  }

  /**
   * 清除所有监听器和过滤器
   */
  clearAll(): void {
    this.removeAllListeners();
    this.eventFilters.clear();
  }
}

/**
 * 事件名称常量
 */
export const ClientEvents = {
  // 连接事件
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  CONNECTION_STATE_CHANGED: 'connectionStateChanged',

  // 认证事件
  AUTHENTICATED: 'authenticated',
  AUTHENTICATION_FAILED: 'authenticationFailed',
  SERVER_SYNC: 'serverSync',

  // 用户事件
  USER_JOINED: 'userJoined',
  USER_LEFT: 'userLeft',
  USER_MOVED: 'userMoved',
  USER_STATE_CHANGED: 'userStateChanged',
  USER_TALKING: 'userTalking',
  USER_STOPPED_TALKING: 'userStoppedTalking',

  // 频道事件
  CHANNEL_CREATED: 'channelCreated',
  CHANNEL_REMOVED: 'channelRemoved',
  CHANNEL_UPDATED: 'channelUpdated',
  CHANNEL_MOVED: 'channelMoved',

  // 消息事件
  MESSAGE: 'message',
  TEXT_MESSAGE: 'textMessage',

  // 音频事件
  AUDIO_RECEIVED: 'audioReceived',
  AUDIO_STREAM_STARTED: 'audioStreamStarted',
  AUDIO_STREAM_ENDED: 'audioStreamEnded',

  // 权限事件
  PERMISSION_DENIED: 'permissionDenied',
  PERMISSION_QUERY: 'permissionQuery',

  // 服务器事件
  SERVER_CONFIG: 'serverConfig',
  PING: 'ping',
  PONG: 'pong',

  // 其他事件
  CONTEXT_ACTION: 'contextAction',
  PLUGIN_DATA: 'pluginData',
} as const;

/**
 * 事件类型定义
 */
export interface ClientEventMap {
  // 连接事件
  connected: () => void;
  disconnected: (reason: string) => void;
  reconnecting: (attempt: number) => void;
  error: (error: Error) => void;
  connectionStateChanged: (state: string) => void;

  // 认证事件
  authenticated: (session: number) => void;
  authenticationFailed: (reason: string) => void;
  serverSync: (data: any) => void;

  // 用户事件
  userJoined: (user: any) => void;
  userLeft: (user: any) => void;
  userMoved: (user: any, fromChannel: number, toChannel: number) => void;
  userStateChanged: (user: any, changes: any) => void;
  userTalking: (session: number) => void;
  userStoppedTalking: (session: number) => void;

  // 频道事件
  channelCreated: (channel: any) => void;
  channelRemoved: (channel: any) => void;
  channelUpdated: (channel: any, changes: any) => void;
  channelMoved: (channel: any, newParent: number) => void;

  // 消息事件
  message: (message: any) => void;
  textMessage: (message: any) => void;

  // 音频事件
  audioReceived: (session: number, audioData: Buffer) => void;
  audioStreamStarted: (session: number) => void;
  audioStreamEnded: (session: number) => void;

  // 权限事件
  permissionDenied: (permission: string, reason: string) => void;
  permissionQuery: (channelId: number, permissions: number) => void;

  // 服务器事件
  serverConfig: (config: any) => void;
  ping: (timestamp: number) => void;
  pong: (timestamp: number) => void;

  // 其他事件
  contextAction: (action: string, data: any) => void;
  pluginData: (data: any) => void;
}
