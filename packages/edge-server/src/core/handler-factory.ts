/**
 * HandlerFactory - 处理器工厂
 * 统一管理所有处理器的单例实例，自行创建和管理核心组件
 * 处理器通过工厂获取其他处理器和组件，而不是在构造函数中传递
 */

import { logger } from '@munode/common';
import { ClientManager } from '../client/client-manager.js';
import { ChannelManager } from '../models/channel.js';
import { MessageHandler } from '../message-handler.js';
import { VoiceRouter } from '../voice/voice-router.js';
import { AuthManager } from '../auth/auth-manager.js';
import { EdgeControlClient } from '../cluster/hub-client.js';
import { BanManager } from '../ban/ban-manager.js';
import { ContextActions } from '../handlers/context-action.js';
import { UserCache } from '../state/user-cache.js';
import { EdgeStateManager } from '../state/state-manager.js';
import { PermissionManager, type ACLEntry } from '@munode/protocol';
import { EdgeConfig } from '../types.js';

import { ProtocolHandlers } from '../handlers/protocol-handlers.js';
import { HubMessageHandlers } from '../cluster/hub-message-handler.js';
import { AuthHandlers } from '../auth/auth-handler.js';
import { ConnectionHandlers } from '../handlers/connection-handlers.js';
import { StateHandlers } from '../handlers/state-handlers.js';
import { PermissionHandlers } from '../auth/permission-checker.js';
import { MessageHandlers } from '../handlers/message-handlers.js';
import { AdminHandlers } from '../handlers/admin-handlers.js';

/**
 * 处理器工厂 - 单例模式
 * 负责创建和管理所有核心组件和处理器
 */
export class HandlerFactory {
  // 核心组件
  public readonly clientManager: ClientManager;
  public readonly channelManager: ChannelManager;
  public readonly messageHandler: MessageHandler;
  public readonly voiceRouter: VoiceRouter;
  public readonly authManager: AuthManager;
  public readonly banManager: BanManager;
  public readonly contextActions: ContextActions;
  public readonly permissionManager: PermissionManager;
  public readonly config: EdgeConfig;
  
  // 可选组件
  public readonly hubClient: EdgeControlClient;
  public readonly userCache?: UserCache;
  public readonly stateManager: EdgeStateManager;
  public readonly aclMap: Map<number, ACLEntry[]>;

  // 处理器实例
  public readonly protocolHandlers: ProtocolHandlers;
  public readonly hubMessageHandlers: HubMessageHandlers;
  public readonly authHandlers: AuthHandlers;
  public readonly connectionHandlers: ConnectionHandlers;
  public readonly stateHandlers: StateHandlers;
  public readonly permissionHandlers: PermissionHandlers;
  public readonly messageHandlers: MessageHandlers;
  public readonly adminHandlers: AdminHandlers;

  constructor(
    config: EdgeConfig,
    hubClient: EdgeControlClient,
    userCache?: UserCache
  ) {
    this.config = config;
    this.hubClient = hubClient;
    this.userCache = userCache;
    
    // 初始化核心组件
    this.clientManager = new ClientManager(config, logger);
    this.channelManager = new ChannelManager(config, logger);
    this.messageHandler = new MessageHandler(config, logger);
    this.voiceRouter = new VoiceRouter(config, logger);
    this.authManager = new AuthManager(config, logger, userCache, hubClient);
    this.banManager = new BanManager(config.databasePath, 1024);
    this.contextActions = new ContextActions();
    this.permissionManager = new PermissionManager(logger);
    this.aclMap = new Map();
    
    // 设置 VoiceRouter 的依赖
    this.voiceRouter.setClientManager(this.clientManager);
    
    // 初始化状态管理器（集群模式）
    this.stateManager = new EdgeStateManager();

    // 初始化处理器
    this.protocolHandlers = new ProtocolHandlers(this);
    this.hubMessageHandlers = new HubMessageHandlers(this);
    this.authHandlers = new AuthHandlers(this);
    this.connectionHandlers = new ConnectionHandlers(this);
    this.stateHandlers = new StateHandlers(this);
    this.permissionHandlers = new PermissionHandlers(this);
    this.messageHandlers = new MessageHandlers(this);
    this.adminHandlers = new AdminHandlers(this);

  }

  /**
   * 获取核心组件引用
   */
}
