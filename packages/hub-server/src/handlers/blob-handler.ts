import type { Logger } from '@munode/common';
import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';


/**
 * Hub Blob处理器接口
 */
export interface IBlobHandler {
  handleBlobPut(params: RPCParams<'blob.put'>): Promise<RPCResult<'blob.put'>>;
  handleBlobGet(params: RPCParams<'blob.get'>): Promise<RPCResult<'blob.get'>>;
  handleGetUserTexture(params: RPCParams<'blob.getUserTexture'>): Promise<RPCResult<'blob.getUserTexture'>>;
  handleGetUserComment(params: RPCParams<'blob.getUserComment'>): Promise<RPCResult<'blob.getUserComment'>>;
  handleSetUserTexture(params: RPCParams<'blob.setUserTexture'>): Promise<RPCResult<'blob.setUserTexture'>>;
  handleSetUserComment(params: RPCParams<'blob.setUserComment'>): Promise<RPCResult<'blob.setUserComment'>>;
}

/**
 * Hub Blob处理器 - 处理Blob存储相关的操作
 */
export class BlobHandler implements IBlobHandler {
  private factory: HubHandlerFactory;

    private logger: Logger;

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    this.logger = factory.getLogger();
  }

  /**
   * 处理Blob存储
   */
  async handleBlobPut(params: RPCParams<'blob.put'>): Promise<RPCResult<'blob.put'>> {
    if (!this.factory.getBlobStore() || !this.factory.getBlobStore().isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    try {
      const hash = await this.factory.getBlobStore().put(params.data);
      this.logger.debug(`Blob stored: ${hash}`);
      return { success: true, hash };
    } catch (error) {
      this.logger.error('Error storing blob:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 处理Blob获取
   */
  async handleBlobGet(params: RPCParams<'blob.get'>): Promise<RPCResult<'blob.get'>> {
    if (!this.factory.getBlobStore() || !this.factory.getBlobStore().isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    try {
      const data = await this.factory.getBlobStore().get(params.hash);
      if (!data) {
        return { success: false, error: 'Blob not found' };
      }
      return { success: true, data };
    } catch (error) {
      this.logger.error(`Error retrieving blob ${params.hash}:`, error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 处理获取用户纹理
   */
  async handleGetUserTexture(params: RPCParams<'blob.getUserTexture'>): Promise<RPCResult<'blob.getUserTexture'>> {
    if (!this.factory.getBlobStore() || !this.factory.getBlobStore().isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this.factory.getDatabase()) {
      return { success: false, error: 'Database not available' };
    }

    try {
      const hash = await this.factory.getDatabaseOperations().getUserTextureBlob(params.user_id);
      if (!hash) {
        return { success: false, error: 'User texture not found' };
      }

      const data = await this.factory.getDatabaseOperations().getBlobData(hash);
      if (!data) {
        return { success: false, error: 'Texture blob not found' };
      }

      return { success: true, data, hash };
    } catch (error) {
      this.logger.error(`Error getting user texture for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 处理获取用户评论
   */
  async handleGetUserComment(params: RPCParams<'blob.getUserComment'>): Promise<RPCResult<'blob.getUserComment'>> {
    if (!this.factory.getBlobStore() || !this.factory.getBlobStore().isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this.factory.getDatabase()) {
      return { success: false, error: 'Database not available' };
    }

    try {
      const hash = await this.factory.getDatabaseOperations().getUserCommentBlob(params.user_id);
      if (!hash) {
        return { success: false, error: 'User comment not found' };
      }

      const data = await this.factory.getBlobStore().get(hash);
      if (!data) {
        return { success: false, error: 'Comment blob not found' };
      }

      return { success: true, data, hash };
    } catch (error) {
      this.logger.error(`Error getting user comment for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 处理设置用户纹理
   */
  async handleSetUserTexture(params: RPCParams<'blob.setUserTexture'>): Promise<RPCResult<'blob.setUserTexture'>> {
    if (!this.factory.getBlobStore() || !this.factory.getBlobStore().isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this.factory.getDatabase()) {
      return { success: false, error: 'Database not available' };
    }

    try {
      // 存储 blob 数据
      const hash = await this.factory.getDatabaseOperations().putBlobData(params.data);

      // 保存 hash 到数据库
      await this.factory.getDatabaseOperations().setUserTextureBlob(params.user_id, hash);
      this.logger.info(`Set user texture for user ${params.user_id}: ${hash}`);
      
      // 广播 UserState 更新（对齐 C++ Mumble 服务器行为）
      const sessionManager = this.factory.getSessionManager();
      const controlService = this.factory.getControlService();
      const userSessions = sessionManager.getUserSessions(params.user_id);
      
      if (userSessions.length > 0) {
        // 广播给用户的所有会话
        for (const userSession of userSessions) {
          this.logger.debug(`Broadcasting texture_hash update for session ${userSession.session_id}`);
          controlService.broadcast('hub.userStateBroadcast', {
            session: userSession.session_id,
            actor: userSession.session_id,
            texture_hash: hash,
          });
        }
      }
      
      return { success: true, hash };
    } catch (error) {
      this.logger.error(`Error setting user texture for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 处理设置用户评论
   */
  async handleSetUserComment(params: RPCParams<'blob.setUserComment'>): Promise<RPCResult<'blob.setUserComment'>> {
    if (!this.factory.getBlobStore() || !this.factory.getBlobStore().isEnabled()) {
      return { success: false, error: 'Blob storage is disabled' };
    }

    if (!this.factory.getDatabase()) {
      return { success: false, error: 'Database not available' };
    }

    try {
      // 存储 blob 数据
      const hash = await this.factory.getDatabaseOperations().putBlobData(params.data);

      // 保存 hash 到数据库
      await this.factory.getDatabaseOperations().setUserCommentBlob(params.user_id, hash);
      this.logger.info(`Set user comment for user ${params.user_id}: ${hash}`);
      
      // 广播 UserState 更新（对齐 C++ Mumble 服务器行为）
      const sessionManager = this.factory.getSessionManager();
      const controlService = this.factory.getControlService();
      const userSessions = sessionManager.getUserSessions(params.user_id);
      
      if (userSessions.length > 0) {
        // 广播给用户的所有会话
        for (const userSession of userSessions) {
          this.logger.debug(`Broadcasting comment_hash update for session ${userSession.session_id}`);
          controlService.broadcast('hub.userStateBroadcast', {
            session: userSession.session_id,
            actor: userSession.session_id,
            comment_hash: hash,
          });
        }
      }
      
      return { success: true, hash };
    } catch (error) {
      this.logger.error(`Error setting user comment for user ${params.user_id}:`, error);
      return { success: false, error: String(error) };
    }
  }
}