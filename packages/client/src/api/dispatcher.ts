/**
 * ApiDispatcher - API 统一分发器
 * 
 * 主要职责:
 * - 统一处理来自不同接口 (HTTP, WebSocket, Node.js) 的请求
 * - 参数验证
 * - 权限检查
 * - 请求路由到具体业务处理器
 * - 错误处理
 */

import { 
  ConnectHandler,
  DisconnectHandler,
  JoinChannelHandler,
  SendMessageHandler,
  AddListeningChannelHandler,
  RemoveListeningChannelHandler,
  ClearListeningChannelsHandler,
  GetListeningChannelsHandler,
  SetVoiceTargetHandler,
  RemoveVoiceTargetHandler,
  SendPluginDataHandler,
  RegisterContextActionHandler,
  ExecuteContextActionHandler,
  AddWebhookHandler,
  RemoveWebhookHandler,
  GetWebhooksHandler,
  QueryACLHandler,
  SaveACLHandler,
  CheckPermissionHandler,
  GetUserPermissionsHandler,
  AddACLEntryHandler,
  RemoveACLEntryHandler,
  UpdateACLEntryHandler,
  CreateChannelGroupHandler,
  DeleteChannelGroupHandler,
  AddUserToGroupHandler,
  RemoveUserFromGroupHandler
} from '../business/handlers/index.js';
import type { ApiContext, ApiRequest, ApiResponse } from '../types/api-types.js';

export class ApiDispatcher {
  private handlers: Map<string, BusinessHandler> = new Map();

  constructor() {
    this.registerHandlers();
  }

  /**
   * 分发请求到相应的业务处理器
   */
  async dispatch(request: ApiRequest, context: ApiContext): Promise<ApiResponse> {
    try {
      // 1. 验证请求参数
      this.validateRequest(request);

      // 2. 检查权限
      await this.checkPermissions(request.action, context);

      // 3. 获取处理器
      const handler = this.getHandler(request.action);
      if (!handler) {
        throw new Error(`Unknown action: ${request.action}`);
      }

      // 4. 执行业务逻辑
      const result = await handler.execute(request.params, context);

      // 5. 返回成功响应
      return {
        success: true,
        data: result
      };
    } catch (error) {
      // 6. 错误处理
      return {
        success: false,
        error: {
          code: (error as any).code || 'UNKNOWN_ERROR',
          message: (error as Error).message
        }
      };
    }
  }

  /**
   * 注册所有业务处理器
   */
  private registerHandlers(): void {
    this.handlers.set('connect', new ConnectHandler());
    this.handlers.set('disconnect', new DisconnectHandler());
    this.handlers.set('joinChannel', new JoinChannelHandler());
    this.handlers.set('sendMessage', new SendMessageHandler());
    this.handlers.set('addListeningChannel', new AddListeningChannelHandler());
    this.handlers.set('removeListeningChannel', new RemoveListeningChannelHandler());
    this.handlers.set('clearListeningChannels', new ClearListeningChannelsHandler());
    this.handlers.set('getListeningChannels', new GetListeningChannelsHandler());
    this.handlers.set('setVoiceTarget', new SetVoiceTargetHandler());
    this.handlers.set('removeVoiceTarget', new RemoveVoiceTargetHandler());
    this.handlers.set('sendPluginData', new SendPluginDataHandler());
    this.handlers.set('registerContextAction', new RegisterContextActionHandler());
    this.handlers.set('executeContextAction', new ExecuteContextActionHandler());
    this.handlers.set('addWebhook', new AddWebhookHandler());
    this.handlers.set('removeWebhook', new RemoveWebhookHandler());
    this.handlers.set('getWebhooks', new GetWebhooksHandler());
    this.handlers.set('queryACL', new QueryACLHandler());
    this.handlers.set('saveACL', new SaveACLHandler());
    this.handlers.set('checkPermission', new CheckPermissionHandler());
    this.handlers.set('getUserPermissions', new GetUserPermissionsHandler());
    this.handlers.set('addACLEntry', new AddACLEntryHandler());
    this.handlers.set('removeACLEntry', new RemoveACLEntryHandler());
    this.handlers.set('updateACLEntry', new UpdateACLEntryHandler());
    this.handlers.set('createChannelGroup', new CreateChannelGroupHandler());
    this.handlers.set('deleteChannelGroup', new DeleteChannelGroupHandler());
    this.handlers.set('addUserToGroup', new AddUserToGroupHandler());
    this.handlers.set('removeUserFromGroup', new RemoveUserFromGroupHandler());
  }

  /**
   * 获取处理器
   */
  private getHandler(action: string): BusinessHandler | null {
    return this.handlers.get(action) || null;
  }

  /**
   * 验证请求
   */
  private validateRequest(request: ApiRequest): void {
    // 检查请求格式
    if (!request.action) {
      throw new Error('Action is required');
    }
    
    // 检查必需参数
    if (request.action === 'connect') {
      if (!request.params.host || !request.params.username) {
        throw new Error('Host and username are required for connect action');
      }
    }
    
    if (request.action === 'joinChannel') {
      if (typeof request.params.channelId !== 'number') {
        throw new Error('channelId must be a number');
      }
    }
    
    if (request.action === 'sendMessage') {
      if (!request.params.message) {
        throw new Error('message is required');
      }
      if (!request.params.target) {
        throw new Error('target is required');
      }
    }
  }

  /**
   * 检查权限
   */
  private async checkPermissions(action: string, context: ApiContext): Promise<void> {
    // 某些操作需要已连接
    const requiresConnection = [
      'joinChannel', 'sendMessage', 'createChannel', 
      'deleteChannel', 'kickUser', 'banUser'
    ];
    
    if (requiresConnection.includes(action) && !context.client.isConnected()) {
      throw new Error('Client must be connected to perform this action');
    }
  }
}

/**
 * 业务处理器接口
 */
export interface BusinessHandler {
  /**
   * 执行业务逻辑
   */
  execute(params: any, context: ApiContext): Promise<any>;
}
