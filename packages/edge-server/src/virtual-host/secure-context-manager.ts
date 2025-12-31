import tls from 'tls';
import fs from 'fs/promises';
import type { Logger } from 'winston';
import type { VirtualHostConfig } from '../types.js';

/**
 * 安全上下文管理器
 * 管理每个虚拟主机的 TLS SecureContext（证书和密钥）
 */
export class SecureContextManager {
  private contexts: Map<string, tls.SecureContext> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * 为虚拟主机创建 SecureContext
   */
  async createContext(vhostConfig: VirtualHostConfig): Promise<void> {
    const { servername, tls: tlsConfig } = vhostConfig;
    
    try {
      // 读取证书和密钥文件
      const [cert, key, ca] = await Promise.all([
        fs.readFile(tlsConfig.cert, 'utf-8'),
        fs.readFile(tlsConfig.key, 'utf-8'),
        tlsConfig.ca ? fs.readFile(tlsConfig.ca, 'utf-8') : Promise.resolve(undefined),
      ]);
      
      // 创建 SecureContext
      const context = tls.createSecureContext({
        cert,
        key,
        ca,
        // 其他 TLS 选项
        minVersion: 'TLSv1.2',
      });
      
      this.contexts.set(servername, context);
      this.logger.info(`Loaded TLS context for virtual host: ${servername}`);
      
      // 支持通配符域名
      if (servername.startsWith('*.')) {
        const basePattern = servername.slice(2); // 移除 *.
        this.logger.debug(`Wildcard certificate registered: ${servername} -> *.${basePattern}`);
      }
    } catch (error) {
      this.logger.error(`Failed to load TLS context for ${servername}:`, error);
      throw new Error(`Cannot load TLS configuration for ${servername}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 根据 servername 获取 SecureContext
   * @param servername SNI 提供的域名
   * @returns SecureContext，如果未找到返回 null
   */
  getContext(servername: string): tls.SecureContext | null {
    // 精确匹配
    let context = this.contexts.get(servername);
    if (context) {
      return context;
    }
    
    // 通配符匹配
    for (const [pattern, ctx] of this.contexts.entries()) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // 移除 *，保留 .example.com
        if (servername.endsWith(suffix)) {
          this.logger.debug(`Wildcard match: ${servername} -> ${pattern}`);
          return ctx;
        }
      }
    }
    
    this.logger.warn(`No TLS context found for servername: ${servername}`);
    return null;
  }

  /**
   * 重新加载指定虚拟主机的证书
   * 用于证书更新/续期
   */
  async reloadContext(vhostConfig: VirtualHostConfig): Promise<void> {
    const { servername } = vhostConfig;
    
    this.logger.info(`Reloading TLS context for: ${servername}`);
    
    // 删除旧上下文
    this.contexts.delete(servername);
    
    // 创建新上下文
    await this.createContext(vhostConfig);
  }

  /**
   * 获取所有已加载的域名
   */
  getLoadedHosts(): string[] {
    return Array.from(this.contexts.keys());
  }

  /**
   * 清理所有上下文
   */
  clear(): void {
    this.contexts.clear();
  }
}
