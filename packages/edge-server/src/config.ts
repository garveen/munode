import { resolve } from 'path';
import { EdgeConfig } from './types.js';
import { loadConfig } from '@munode/common';
import type { Logger } from '@munode/common';
import { validateAndParseEdgeConfig, getDefaultEdgeConfig } from './config-schema.js';

/**
 * 加载 Edge Server 配置
 * 配置验证失败将抛出错误，阻止系统启动
 */
export async function loadEdgeConfig(configPath?: string, logger?: Logger): Promise<EdgeConfig> {
  if (configPath) {
    try {
      const rawConfig = await loadConfig<unknown>(resolve(configPath));
      logger?.info(`Loading configuration from: ${configPath}`);
      
      // 使用 Zod 验证并应用默认值
      const validatedConfig = validateAndParseEdgeConfig(rawConfig);
      logger?.info('Configuration validated successfully');
      
      return validatedConfig;
    } catch (error) {
      if (error instanceof Error && error.message.includes('validation failed')) {
        logger?.error('Configuration validation failed');
        throw error; // 验证失败直接抛出，阻止启动
      }
      logger?.error(`Failed to load config from ${configPath}:`, error);
      throw new Error(`Configuration load error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger?.warn('No configuration file specified, using default configuration');
  return getDefaultEdgeConfig();
}

/**
 * 验证配置（旧版 API，保留以保持向后兼容）
 * 现在使用 Zod schema 进行验证，该函数仅用于附加验证
 */
export function validateConfig(config: EdgeConfig): string[] {
  const errors: string[] = [];

  // Zod 已经验证了大部分字段，这里只增加一些附加检查
  if (config.network.external_port && config.network.external_port === config.network.port) {
    // 这不是错误，只是一个提醒
  }

  if (config.tls.require_client_cert && !config.tls.ca) {
    errors.push('tls.ca is required when tls.requireClientCert is true');
  }

  return errors;
}
