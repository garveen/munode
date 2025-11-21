/**
 * Hub Server 配置验证器
 * 验证配置项的合法性
 */

import type { HubConfig } from './types.js';
import { createLogger } from '@munode/common';

const logger = createLogger({ service: 'hub-config-validator' });

/**
 * 配置验证错误
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * 验证 Hub 配置
 * @param config Hub 配置对象
 * @throws {ConfigValidationError} 如果配置无效
 */
export function validateHubConfig(config: HubConfig): void {
  const errors: string[] = [];
  
  // 验证基础配置
  if (config.server_id < 0) {
    errors.push('server_id must be non-negative');
  }
  
  if (!config.name || config.name.trim() === '') {
    errors.push('name is required and cannot be empty');
  }
  
  if (!config.host) {
    errors.push('host is required');
  }
  
  if (config.port <= 0 || config.port > 65535) {
    errors.push('port must be between 1 and 65535');
  }
  
  // 验证超时配置
  if (config.timeout !== undefined && config.timeout <= 0) {
    errors.push('timeout must be positive');
  }
  
  // 验证用户与频道限制
  if (config.maxUsers !== undefined && config.maxUsers < 1) {
    errors.push('maxUsers must be at least 1');
  }
  
  if (config.maxUsersPerChannel !== undefined && config.maxUsersPerChannel < 0) {
    errors.push('maxUsersPerChannel must be non-negative (0 means unlimited)');
  }
  
  if (config.channelNestingLimit !== undefined && config.channelNestingLimit < 1) {
    errors.push('channelNestingLimit must be at least 1');
  }
  
  if (config.channelCountLimit !== undefined && config.channelCountLimit < 1) {
    errors.push('channelCountLimit must be at least 1');
  }
  
  // 验证带宽与消息限制
  if (config.bandwidth !== undefined && config.bandwidth <= 0) {
    errors.push('bandwidth must be positive');
  }
  
  if (config.textMessageLength !== undefined && config.textMessageLength <= 0) {
    errors.push('textMessageLength must be positive');
  }
  
  if (config.imageMessageLength !== undefined && config.imageMessageLength <= 0) {
    errors.push('imageMessageLength must be positive');
  }
  
  if (config.messageLimit !== undefined && config.messageLimit <= 0) {
    errors.push('messageLimit must be positive');
  }
  
  if (config.messageBurst !== undefined && config.messageBurst <= 0) {
    errors.push('messageBurst must be positive');
  }
  
  if (config.pluginMessageLimit !== undefined && config.pluginMessageLimit <= 0) {
    errors.push('pluginMessageLimit must be positive');
  }
  
  if (config.pluginMessageBurst !== undefined && config.pluginMessageBurst <= 0) {
    errors.push('pluginMessageBurst must be positive');
  }
  
  // 验证 KDF 迭代次数
  if (config.kdfIterations !== undefined && config.kdfIterations !== -1 && config.kdfIterations < 1) {
    errors.push('kdfIterations must be -1 (auto) or positive');
  }
  
  // 验证正则表达式
  if (config.usernameRegex !== undefined) {
    try {
      new RegExp(config.usernameRegex);
    } catch (e) {
      errors.push(`Invalid usernameRegex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  if (config.channelNameRegex !== undefined) {
    try {
      new RegExp(config.channelNameRegex);
    } catch (e) {
      errors.push(`Invalid channelNameRegex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  // 验证自动封禁配置
  if (config.autoBan) {
    if (config.autoBan.attempts < 1) {
      errors.push('autoBan.attempts must be at least 1');
    }
    
    if (config.autoBan.timeframe <= 0) {
      errors.push('autoBan.timeframe must be positive');
    }
    
    if (config.autoBan.duration <= 0) {
      errors.push('autoBan.duration must be positive');
    }
  }
  
  // 验证频道行为
  if (config.defaultChannel !== undefined && config.defaultChannel < 0) {
    errors.push('defaultChannel must be non-negative');
  }
  
  if (config.rememberChannelDuration !== undefined && config.rememberChannelDuration < 0) {
    errors.push('rememberChannelDuration must be non-negative (0 means permanent)');
  }
  
  // 验证客户端建议配置
  if (config.suggest?.version !== undefined) {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(config.suggest.version)) {
      errors.push('suggest.version must be in format "major.minor.patch" (e.g., "1.4.0")');
    }
  }
  
  // 验证监听限制
  if (config.listenersPerChannel !== undefined && config.listenersPerChannel < 0) {
    errors.push('listenersPerChannel must be non-negative (0 means unlimited)');
  }
  
  if (config.listenersPerUser !== undefined && config.listenersPerUser < 0) {
    errors.push('listenersPerUser must be non-negative (0 means unlimited)');
  }
  
  // 验证日志配置
  if (config.logDays !== undefined && config.logDays < 0) {
    errors.push('logDays must be non-negative');
  }
  
  // 验证 TLS 配置
  if (!config.tls) {
    errors.push('tls configuration is required');
  }
  
  // 验证注册表配置
  if (!config.registry) {
    errors.push('registry configuration is required');
  } else {
    if (config.registry.heartbeatInterval <= 0) {
      errors.push('registry.heartbeatInterval must be positive');
    }
    
    if (config.registry.timeout <= 0) {
      errors.push('registry.timeout must be positive');
    }
    
    if (config.registry.maxEdges < 1) {
      errors.push('registry.maxEdges must be at least 1');
    }
  }
  
  // 验证数据库配置
  if (!config.database) {
    errors.push('database configuration is required');
  } else {
    if (!config.database.path) {
      errors.push('database.path is required');
    }
    
    if (!config.database.backupDir) {
      errors.push('database.backupDir is required');
    }
    
    if (config.database.backupInterval <= 0) {
      errors.push('database.backupInterval must be positive');
    }
  }
  
  // 验证 Blob 存储配置
  if (!config.blobStore) {
    errors.push('blobStore configuration is required');
  } else if (config.blobStore.enabled && !config.blobStore.path) {
    errors.push('blobStore.path is required when blobStore is enabled');
  }
  
  // 验证 Web API 配置
  if (!config.webApi) {
    errors.push('webApi configuration is required');
  } else if (config.webApi.enabled) {
    if (config.webApi.port <= 0 || config.webApi.port > 65535) {
      errors.push('webApi.port must be between 1 and 65535');
    }
  }
  
  // 如果有错误，抛出异常
  if (errors.length > 0) {
    const errorMessage = 'Configuration validation failed:\n  ' + errors.join('\n  ');
    logger.error(errorMessage);
    throw new ConfigValidationError(errorMessage);
  }
  
  // 记录警告（不会阻止启动）
  const warnings: string[] = [];
  
  // 检查安全相关的配置
  if (config.allowHTML === true) {
    warnings.push('allowHTML is enabled - ensure HTML filtering is implemented to prevent XSS attacks');
  }
  
  if (config.serverPassword === undefined || config.serverPassword === '') {
    warnings.push('serverPassword is not set - server is publicly accessible');
  }
  
  if (config.kdfIterations !== undefined && config.kdfIterations < 100000) {
    warnings.push('kdfIterations is set to a low value - consider using higher iterations for better security (or -1 for auto-benchmark)');
  }
  
  if (warnings.length > 0) {
    warnings.forEach(warning => logger.warn(warning));
  }
}
