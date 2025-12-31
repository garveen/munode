import type { Logger } from 'winston';
import type { EdgeConfig, VirtualHostConfig, VirtualHostContext } from '../types.js';
import { ClientManager } from '../client/client-manager.js';

/**
 * 虚拟主机管理器
 * 管理多个虚拟主机实例，负责创建、查找和生命周期管理
 */
export class VirtualHostManager {
  private hosts: Map<string, VirtualHostContext> = new Map();
  private defaultHostName: string;
  private config: EdgeConfig;
  private logger: Logger;

  constructor(config: EdgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    
    // 初始化虚拟主机
    if (config.virtualHosts && config.virtualHosts.length > 0) {
      this.logger.info(`Initializing ${config.virtualHosts.length} virtual hosts`);
      this.initializeVirtualHosts();
    } else {
      // 向后兼容：如果没有配置 virtualHosts，创建单一默认主机
      this.logger.info('No virtual hosts configured, using single-tenant mode');
      this.initializeSingleTenant();
    }
    
    // 设置默认主机
    this.defaultHostName = config.defaultVirtualHost || 
      Array.from(this.hosts.keys())[0];
    
    if (!this.defaultHostName) {
      throw new Error('No virtual hosts configured');
    }
    
    this.logger.info(`Default virtual host: ${this.defaultHostName}`);
  }

  /**
   * 初始化多个虚拟主机
   */
  private initializeVirtualHosts(): void {
    if (!this.config.virtualHosts) return;
    
    for (const vhostConfig of this.config.virtualHosts) {
      try {
        const context = this.createVirtualHostContext(vhostConfig);
        this.hosts.set(vhostConfig.servername, context);
        this.logger.info(
          `Virtual host initialized: ${vhostConfig.servername} (server_id: ${vhostConfig.server_id})`
        );
      } catch (error) {
        this.logger.error(`Failed to initialize virtual host ${vhostConfig.servername}:`, error);
        throw error;
      }
    }
  }

  /**
   * 初始化单租户模式（向后兼容）
   */
  private initializeSingleTenant(): void {
    // 使用根配置创建单一虚拟主机上下文
    const vhostConfig: VirtualHostConfig = {
      servername: 'default',
      server_id: this.config.server_id,
      name: this.config.name,
      tls: this.config.tls,
      welcomeText: this.config.server.welcome_text,
      maxUsers: this.config.server.capacity,
      defaultChannel: this.config.server.default_channel,
      hubServer: this.config.hub_server,
      features: this.config.features,
      server: this.config.server,
    };
    
    const context = this.createVirtualHostContext(vhostConfig);
    this.hosts.set('default', context);
  }

  /**
   * 创建虚拟主机上下文
   */
  private createVirtualHostContext(vhostConfig: VirtualHostConfig): VirtualHostContext {
    // 创建独立的 ClientManager
    // 注意：需要将 vhostConfig 转换为完整的 EdgeConfig
    const edgeConfig: EdgeConfig = this.mergeConfig(vhostConfig);
    const clientManager = new ClientManager(edgeConfig, this.logger);
    
    // 创建其他管理器（暂时留空，后续阶段实现）
    const context: VirtualHostContext = {
      config: vhostConfig,
      clientManager,
      channelManager: undefined,  // Phase 2 will implement
      voiceRouter: undefined,     // Phase 3 will implement
      hubClient: undefined,       // Phase 2 will implement
    };
    
    return context;
  }

  /**
   * 合并虚拟主机配置到完整的 EdgeConfig
   * 虚拟主机配置继承全局配置，但可以覆盖部分字段
   */
  private mergeConfig(vhostConfig: VirtualHostConfig): EdgeConfig {
    return {
      ...this.config,
      server_id: vhostConfig.server_id,
      name: vhostConfig.name,
      tls: vhostConfig.tls,
      hub_server: vhostConfig.hubServer || this.config.hub_server,
      features: vhostConfig.features || this.config.features,
      server: {
        ...this.config.server,
        ...(vhostConfig.server || {}),
        welcome_text: vhostConfig.welcomeText || this.config.server.welcome_text,
        capacity: vhostConfig.maxUsers || this.config.server.capacity,
        default_channel: vhostConfig.defaultChannel,
      },
    };
  }

  /**
   * 根据域名获取虚拟主机
   * @param servername SNI 提供的域名
   * @returns 虚拟主机上下文，如果未找到则返回默认主机
   */
  getHost(servername: string | undefined): VirtualHostContext {
    // 如果没有提供 servername，使用默认主机
    if (!servername) {
      return this.getDefaultHost();
    }

    // 精确匹配
    let context = this.hosts.get(servername);
    
    if (!context) {
      // 通配符匹配（可选实现）
      context = this.matchWildcard(servername);
    }
    
    if (!context) {
      // 使用默认主机
      this.logger.debug(`No virtual host found for ${servername}, using default: ${this.defaultHostName}`);
      context = this.hosts.get(this.defaultHostName);
    }
    
    if (!context) {
      throw new Error(`Failed to find virtual host: ${servername}`);
    }
    
    return context;
  }

  /**
   * 通配符域名匹配（可选）
   * 支持 *.example.com 格式
   */
  private matchWildcard(servername: string): VirtualHostContext | undefined {
    for (const [pattern, ctx] of this.hosts.entries()) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // 移除 *
        if (servername.endsWith(suffix)) {
          this.logger.debug(`Wildcard match: ${servername} -> ${pattern}`);
          return ctx;
        }
      }
    }
    return undefined;
  }

  /**
   * 获取所有虚拟主机名称
   */
  getHostNames(): string[] {
    return Array.from(this.hosts.keys());
  }

  /**
   * 获取虚拟主机数量
   */
  getHostCount(): number {
    return this.hosts.size;
  }

  /**
   * 是否为多租户模式
   */
  isMultiTenant(): boolean {
    return this.config.virtualHosts !== undefined && this.config.virtualHosts.length > 1;
  }

  /**
   * 获取默认虚拟主机
   */
  getDefaultHost(): VirtualHostContext {
    const context = this.hosts.get(this.defaultHostName);
    if (!context) {
      throw new Error(`Default virtual host not found: ${this.defaultHostName}`);
    }
    return context;
  }

  /**
   * 清理所有虚拟主机资源
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up virtual hosts...');
    
    for (const [name] of this.hosts.entries()) {
      try {
        // 清理各个管理器（后续阶段实现具体清理逻辑）
        this.logger.debug(`Cleaning up virtual host: ${name}`);
        // await context.hubClient?.disconnect();
        // await context.voiceRouter?.cleanup();
      } catch (error) {
        this.logger.error(`Error cleaning up virtual host ${name}:`, error);
      }
    }
    
    this.hosts.clear();
  }
}
