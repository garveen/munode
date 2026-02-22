/**
 * Hub Server 配置验证器
 * 验证配置项的合法性
 */

import type { Logger } from '@munode/common';
import type { HubConfig } from './types.js';

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
export function validateHubConfig(config: HubConfig, logger?: Logger): void {
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
  if (config.max_users !== undefined && config.max_users < 1) {
    errors.push('max_users must be at least 1');
  }
  
  if (config.max_users_per_channel !== undefined && config.max_users_per_channel < 0) {
    errors.push('max_users_per_channel must be non-negative (0 means unlimited)');
  }
  
  if (config.channel_nesting_limit !== undefined && config.channel_nesting_limit < 1) {
    errors.push('channel_nesting_limit must be at least 1');
  }
  
  if (config.channel_count_limit !== undefined && config.channel_count_limit < 1) {
    errors.push('channel_count_limit must be at least 1');
  }
  
  // 验证带宽与消息限制
  if (config.bandwidth !== undefined && config.bandwidth <= 0) {
    errors.push('bandwidth must be positive');
  }
  
  if (config.text_message_length !== undefined && config.text_message_length <= 0) {
    errors.push('text_message_length must be positive');
  }
  
  if (config.image_message_length !== undefined && config.image_message_length <= 0) {
    errors.push('image_message_length must be positive');
  }
  
  if (config.message_limit !== undefined && config.message_limit <= 0) {
    errors.push('message_limit must be positive');
  }
  
  if (config.message_burst !== undefined && config.message_burst <= 0) {
    errors.push('message_burst must be positive');
  }
  
  if (config.plugin_message_limit !== undefined && config.plugin_message_limit <= 0) {
    errors.push('plugin_message_limit must be positive');
  }
  
  if (config.plugin_message_burst !== undefined && config.plugin_message_burst <= 0) {
    errors.push('plugin_message_burst must be positive');
  }
  
  // 验证 KDF 迭代次数
  if (config.kdf_iterations !== undefined && config.kdf_iterations !== -1 && config.kdf_iterations < 1) {
    errors.push('kdf_iterations must be -1 (auto) or positive');
  }
  
  // 验证正则表达式
  if (config.username_regex !== undefined) {
    try {
      new RegExp(config.username_regex);
    } catch (e) {
      errors.push(`Invalid username_regex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  if (config.channel_name_regex !== undefined) {
    try {
      new RegExp(config.channel_name_regex);
    } catch (e) {
      errors.push(`Invalid channel_name_regex: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  // 验证自动封禁配置
  if (config.auto_ban) {
    if (config.auto_ban.attempts < 1) {
      errors.push('auto_ban.attempts must be at least 1');
    }
    
    if (config.auto_ban.timeframe <= 0) {
      errors.push('auto_ban.timeframe must be positive');
    }
    
    if (config.auto_ban.duration <= 0) {
      errors.push('auto_ban.duration must be positive');
    }
  }
  
  // 验证频道行为
  if (config.default_channel !== undefined && config.default_channel < 0) {
    errors.push('default_channel must be non-negative');
  }
  
  if (config.remember_channel_duration !== undefined && config.remember_channel_duration < 0) {
    errors.push('remember_channel_duration must be non-negative (0 means permanent)');
  }
  
  // 验证客户端建议配置
  if (config.suggest?.version !== undefined) {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(config.suggest.version)) {
      errors.push('suggest.version must be in format "major.minor.patch" (e.g., "1.4.0")');
    }
  }
  
  // 验证监听限制
  if (config.listeners_per_channel !== undefined && config.listeners_per_channel < 0) {
    errors.push('listeners_per_channel must be non-negative (0 means unlimited)');
  }
  
  if (config.listeners_per_user !== undefined && config.listeners_per_user < 0) {
    errors.push('listeners_per_user must be non-negative (0 means unlimited)');
  }
  
  // 验证日志配置
  if (config.log_days !== undefined && config.log_days < 0) {
    errors.push('log_days must be non-negative');
  }
  
  // 验证 TLS 配置
  if (!config.tls) {
    errors.push('tls configuration is required');
  }
  
  // 验证注册表配置
  if (!config.registry) {
    errors.push('registry configuration is required');
  } else {
    if (config.registry.heartbeat_interval <= 0) {
      errors.push('registry.heartbeat_interval must be positive');
    }
    
    if (config.registry.timeout <= 0) {
      errors.push('registry.timeout must be positive');
    }
    
    if (config.registry.max_edges < 1) {
      errors.push('registry.max_edges must be at least 1');
    }
  }
  
  // 验证数据库配置
  if (!config.database) {
    errors.push('database configuration is required');
  } else {
    if (!config.database.path) {
      errors.push('database.path is required');
    }
    
    if (!config.database.backup_dir) {
      errors.push('database.backup_dir is required');
    }
    
    if (config.database.backup_interval <= 0) {
      errors.push('database.backup_interval must be positive');
    }
  }
  
  // 验证 Blob 存储配置
  if (!config.blob_store) {
    errors.push('blob_store configuration is required');
  } else if (config.blob_store.enabled && !config.blob_store.path) {
    errors.push('blob_store.path is required when blob_store is enabled');
  }
  
  // 验证 Web API 配置
  if (!config.web_api) {
    errors.push('web_api configuration is required');
  } else if (config.web_api.enabled) {
    if (config.web_api.port <= 0 || config.web_api.port > 65535) {
      errors.push('web_api.port must be between 1 and 65535');
    }
  }
  
  // 如果有错误，抛出异常
  if (errors.length > 0) {
    const errorMessage = 'Configuration validation failed:\n  ' + errors.join('\n  ');
    throw new ConfigValidationError(errorMessage);
  }
  
  // 记录警告（不会阻止启动）
  const warnings: string[] = [];
  
  // 检查安全相关的配置
  if (config.allow_html === true) {
    warnings.push('allow_html is enabled - ensure HTML filtering is implemented to prevent XSS attacks');
  }
  
  if (config.server_password === undefined || config.server_password === '') {
    warnings.push('server_password is not set - server is publicly accessible');
  }
  
  if (config.kdf_iterations !== undefined && config.kdf_iterations < 100000) {
    warnings.push('kdf_iterations is set to a low value - consider using higher iterations for better security (or -1 for auto-benchmark)');
  }
  
  if (warnings.length > 0) {
    warnings.forEach(warning => logger?.warn(`[config-validator] ${warning}`));
  }
}
