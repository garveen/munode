/**
 * ConnectHandler - 连接处理器
 * 
 * 处理客户端连接到 Mumble 服务器
 */

import type { BusinessHandler } from '../../api/dispatcher.js';
import type { ApiContext } from '../context.js';
import type { ConnectOptions } from '../../types/client-types.js';

export class ConnectHandler implements BusinessHandler {
  async execute(params: ConnectOptions, context: ApiContext): Promise<void> {
    // 验证必需参数
    if (!params.host) {
      throw new Error('Host is required');
    }
    if (!params.username) {
      throw new Error('Username is required');
    }
    
    // 调用客户端连接方法并等待连接成功
    await context.client.connect(params);
  }
}
