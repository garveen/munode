import { EventEmitter } from 'events';
import { logger } from '@munode/common';
import { ClientInfo } from '../types.js';
import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';

/**
 * 上下文动作管理器 - 实现右键菜单系统 (Context Actions)
 * 支持 Group Shout、批量移动、Promiscuous Mode 等功能
 */
export class ContextActions extends EventEmitter {
  private clients: Map<number, ClientInfo> = new Map(); // sessionId -> ClientInfo

  constructor() {
    super();
  }

  /**
   * 初始化客户端的 Context Actions
   */
  initializeClient(client: ClientInfo): void {
    this.clients.set(client.session, client);

    // 初始化 Group Shout 控制
    this.initializeGroupShout(client);

    // 初始化频道移动功能
    this.initializeChannelMovement(client);

    // 初始化 Promiscuous Mode
    this.initializePromiscuousMode(client);
  }

  /**
   * 移除客户端
   */
  removeClient(sessionId: number): void {
    this.clients.delete(sessionId);
  }

  /**
   * 处理 ContextAction 消息
   */
  async handleContextAction(sessionId: number, message: mumbleproto.ContextAction): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) {
      logger.warn(`Unknown client session: ${sessionId}`);
      return;
    }

    const action = message.action;

    try {
      switch (action) {
        // Group Shout 控制
        case 'enable_group_shout':
          await this.handleEnableGroupShout(client);
          break;
        case 'disable_group_shout':
          await this.handleDisableGroupShout(client);
          break;

        // 批量频道移动
        case 'members_moveto':
          if (message.channel_id !== undefined) {
            await this.handleMembersMoveTo(client, message.channel_id);
          }
          break;
        case 'members_movefrom':
          if (message.channel_id !== undefined) {
            await this.handleMembersMoveFrom(client, message.channel_id);
          }
          break;

        // Promiscuous Mode
        case 'enable_promiscuous_mode':
          await this.handleEnablePromiscuousMode(client);
          break;
        case 'disable_promiscuous_mode':
          await this.handleDisablePromiscuousMode(client);
          break;

        default:
          logger.warn(`Unknown context action: ${action} from session ${sessionId}`);
      }
    } catch (error) {
      logger.error(`Context action error for ${action}:`, error);
      this.emit('permissionDenied', sessionId, (error as Error).message);
    }
  }

  // ===== Group Shout 控制 =====

  /**
   * 初始化 Group Shout 控制菜单
   */
  private initializeGroupShout(client: ClientInfo): void {
    if (!client.user_id || client.user_id === 0) {
      // 访客用户不支持组呼叫控制
      return;
    }

    // 默认显示"禁用组呼叫"选项
    this.sendContextActionModify(client.session, {
      action: 'disable_group_shout',
      text: '禁用组呼叫',
      context: 0x01, // Server context
      operation: 0, // Add
    });
  }

  /**
   * 处理启用组呼叫
   */
  private async handleEnableGroupShout(client: ClientInfo): Promise<void> {
    if (!client.user_id || client.user_id === 0) {
      throw new Error('权限不足: 需要注册用户');
    }

    // 设置客户端选项
    client.self_deaf = false; // 确保不处于自我静音状态

    // 清除相关缓存
    this.emit('clearUserCache', client.session);

    // 更新菜单：移除"启用"，添加"禁用"
    this.sendContextActionModify(client.session, {
      action: 'enable_group_shout',
      operation: 1, // Remove
    });

    this.sendContextActionModify(client.session, {
      action: 'disable_group_shout',
      text: '禁用组呼叫',
      context: 0x01, // Server context
      operation: 0, // Add
    });

    logger.info(`User ${client.username} enabled group shout`);
  }

  /**
   * 处理禁用组呼叫
   */
  private async handleDisableGroupShout(client: ClientInfo): Promise<void> {
    if (!client.user_id || client.user_id === 0) {
      throw new Error('权限不足: 需要注册用户');
    }

    // 设置客户端选项
    client.self_deaf = true; // 自我静音来阻止组呼叫

    // 清除相关缓存
    this.emit('clearUserCache', client.session);

    // 更新菜单：移除"禁用"，添加"启用"
    this.sendContextActionModify(client.session, {
      action: 'disable_group_shout',
      operation: 1, // Remove
    });

    this.sendContextActionModify(client.session, {
      action: 'enable_group_shout',
      text: '启用组呼叫',
      context: 0x01, // Server context
      operation: 0, // Add
    });

    logger.info(`User ${client.username} disabled group shout`);
  }

  // ===== 批量频道移动 =====

  /**
   * 初始化频道移动功能
   */
  private initializeChannelMovement(client: ClientInfo): void {
    // 检查是否有移动权限（这里需要从服务器获取权限信息）
    // 暂时假设有权限的用户可以访问这些功能

    this.sendContextActionModify(client.session, {
      action: 'members_moveto',
      text: '将本频道成员移动到...',
      context: 0x02, // Channel context
      operation: 0, // Add
    });

    this.sendContextActionModify(client.session, {
      action: 'members_movefrom',
      text: '将该频道成员移动到此',
      context: 0x02, // Channel context
      operation: 0, // Add
    });
  }

  /**
   * 处理将成员移动到目标频道
   */
  private async handleMembersMoveTo(client: ClientInfo, targetChannelId: number): Promise<void> {
    // 检查权限（需要 Move 权限）
    if (!this.checkMovePermission(client)) {
      throw new Error('权限不足: 需要 Move 权限');
    }

    const currentChannelId = client.channel_id;
    this.emit('moveChannelMembers', client.session, currentChannelId, targetChannelId);

    logger.info(
      `User ${client.username} moved members from channel ${currentChannelId} to ${targetChannelId}`
    );
  }

  /**
   * 处理将目标频道成员移动到当前频道
   */
  private async handleMembersMoveFrom(client: ClientInfo, sourceChannelId: number): Promise<void> {
    // 检查权限（需要 Move 权限）
    if (!this.checkMovePermission(client)) {
      throw new Error('权限不足: 需要 Move 权限');
    }

    const currentChannelId = client.channel_id;
    this.emit('moveChannelMembers', client.session, sourceChannelId, currentChannelId);

    logger.info(
      `User ${client.username} moved members from channel ${sourceChannelId} to ${currentChannelId}`
    );
  }

  // ===== Promiscuous Mode =====

  /**
   * 初始化 Promiscuous Mode
   */
  private initializePromiscuousMode(client: ClientInfo): void {
    // 只有 SuperUser 可以访问混杂模式
    if (!this.isSuperUser(client)) {
      return;
    }

    this.sendContextActionModify(client.session, {
      action: 'enable_promiscuous_mode',
      text: '启用混杂模式（监听所有频道）',
      context: 0x01, // Server context
      operation: 0, // Add
    });
  }

  /**
   * 处理启用混杂模式
   */
  private async handleEnablePromiscuousMode(client: ClientInfo): Promise<void> {
    if (!this.isSuperUser(client)) {
      throw new Error('权限不足: 仅 SuperUser 可用');
    }

    // 设置混杂模式
    this.emit('setPromiscuousMode', client.session, true);

    // 清除缓存
    this.emit('clearUserCache', client.session);

    // 更新菜单
    this.sendContextActionModify(client.session, {
      action: 'enable_promiscuous_mode',
      operation: 1, // Remove
    });

    this.sendContextActionModify(client.session, {
      action: 'disable_promiscuous_mode',
      text: '禁用混杂模式',
      context: 0x01, // Server context
      operation: 0, // Add
    });

    logger.info(`SuperUser ${client.username} enabled promiscuous mode`);
  }

  /**
   * 处理禁用混杂模式
   */
  private async handleDisablePromiscuousMode(client: ClientInfo): Promise<void> {
    if (!this.isSuperUser(client)) {
      throw new Error('权限不足: 仅 SuperUser 可用');
    }

    // 禁用混杂模式
    this.emit('setPromiscuousMode', client.session, false);

    // 清除缓存
    this.emit('clearUserCache', client.session);

    // 更新菜单
    this.sendContextActionModify(client.session, {
      action: 'disable_promiscuous_mode',
      operation: 1, // Remove
    });

    this.sendContextActionModify(client.session, {
      action: 'enable_promiscuous_mode',
      text: '启用混杂模式（监听所有频道）',
      context: 0x01, // Server context
      operation: 0, // Add
    });

    logger.info(`SuperUser ${client.username} disabled promiscuous mode`);
  }

  // ===== 辅助方法 =====

  /**
   * 发送 ContextActionModify 消息
   */
  private sendContextActionModify(sessionId: number, message: Partial<mumbleproto.ContextActionModify>): void {
    this.emit('sendContextActionModify', sessionId, message);
  }

  /**
   * 检查移动权限
   */
  private checkMovePermission(client: ClientInfo): boolean {
    // 这里应该检查实际的权限系统
    // 暂时允许所有注册用户
    return client.user_id !== undefined && client.user_id > 0;
  }

  /**
   * 检查是否为 SuperUser
   */
  private isSuperUser(client: ClientInfo): boolean {
    // 这里应该检查用户组或特殊权限
    // 暂时检查用户名是否为 admin
    return client.username?.toLowerCase() === 'admin';
  }

  /**
   * 获取动作统计
   */
  getActionStats(): any {
    return {
      totalClients: this.clients.size,
      // 可以添加更多统计信息
    };
  }
}
