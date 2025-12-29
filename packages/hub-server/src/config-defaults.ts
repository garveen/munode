/**
 * Hub Server 配置默认值
 * 根据 Murmur 官方默认值设定
 */

import type { HubConfig, AutoBanConfig, ClientSuggestConfig } from './types.js';

// 默认的自动封禁配置
export const DEFAULT_AUTO_BAN: AutoBanConfig = {
  attempts: 10,
  timeframe: 120,
  duration: 300,
  ban_successful_connections: true,
};

// 默认的客户端建议配置
export const DEFAULT_CLIENT_SUGGEST: ClientSuggestConfig = {
  version: undefined,
  positional: null,
  push_to_talk: null,
};

// 配置默认值
export const CONFIG_DEFAULTS = {
  // 基础网络配置
  timeout: 30,
  
  // 用户与频道限制
  max_users: 1000,
  max_users_per_channel: 0, // 0 表示无限制
  channel_nesting_limit: 10,
  channel_count_limit: 1000,
  
  // 带宽与消息限制
  bandwidth: 558000, // 558 Kbps
  text_message_length: 5000,
  image_message_length: 131072, // 128 KB
  message_limit: 1,
  message_burst: 5,
  plugin_message_limit: 4,
  plugin_message_burst: 15,
  
  // 认证与安全
  kdf_iterations: -1, // -1 表示自动基准测试
  allow_html: true,
  force_external_auth: false,
  
  // 用户名与频道名验证（Murmur 默认正则）
  username_regex: '[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+',
  channel_name_regex: '[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+',
  
  // 频道行为
  default_channel: 0, // Root 频道
  remember_channel: true,
  remember_channel_duration: 0, // 0 表示永久记住
  
  // 服务器注册与发现
  bonjour: false,
  
  // 监听功能
  listeners_per_channel: 0, // 0 表示无限制
  listeners_per_user: 0, // 0 表示无限制
  broadcast_listener_volume_adjustments: false,
  
  // 高级功能
  allow_recording: true,
  send_version: true,
  allow_ping: true,
  channel_ninja: false,
  
  // 日志配置
  log_days: 31,
  
  // 数据库配置
  wal_mode: false,
} as const;

/**
 * 应用配置默认值
 * @param config 用户提供的配置
 * @returns 合并了默认值的完整配置
 * @note 即使输入的 config 中某些字段（如 autoBan, suggest）是 undefined，
 *       输出的配置对象也会包含这些字段的默认值，以简化运行时代码
 */
export function applyConfigDefaults(config: HubConfig): HubConfig {
  return {
    ...config,
    
    // 应用基础配置默认值
    timeout: config.timeout ?? CONFIG_DEFAULTS.timeout,
    max_users: config.max_users ?? CONFIG_DEFAULTS.max_users,
    max_users_per_channel: config.max_users_per_channel ?? CONFIG_DEFAULTS.max_users_per_channel,
    channel_nesting_limit: config.channel_nesting_limit ?? CONFIG_DEFAULTS.channel_nesting_limit,
    channel_count_limit: config.channel_count_limit ?? CONFIG_DEFAULTS.channel_count_limit,
    
    bandwidth: config.bandwidth ?? CONFIG_DEFAULTS.bandwidth,
    text_message_length: config.text_message_length ?? CONFIG_DEFAULTS.text_message_length,
    image_message_length: config.image_message_length ?? CONFIG_DEFAULTS.image_message_length,
    message_limit: config.message_limit ?? CONFIG_DEFAULTS.message_limit,
    message_burst: config.message_burst ?? CONFIG_DEFAULTS.message_burst,
    plugin_message_limit: config.plugin_message_limit ?? CONFIG_DEFAULTS.plugin_message_limit,
    plugin_message_burst: config.plugin_message_burst ?? CONFIG_DEFAULTS.plugin_message_burst,
    
    kdf_iterations: config.kdf_iterations ?? CONFIG_DEFAULTS.kdf_iterations,
    allow_html: config.allow_html ?? CONFIG_DEFAULTS.allow_html,
    force_external_auth: config.force_external_auth ?? CONFIG_DEFAULTS.force_external_auth,
    
    username_regex: config.username_regex ?? CONFIG_DEFAULTS.username_regex,
    channel_name_regex: config.channel_name_regex ?? CONFIG_DEFAULTS.channel_name_regex,
    
    default_channel: config.default_channel ?? CONFIG_DEFAULTS.default_channel,
    remember_channel: config.remember_channel ?? CONFIG_DEFAULTS.remember_channel,
    remember_channel_duration: config.remember_channel_duration ?? CONFIG_DEFAULTS.remember_channel_duration,
    
    bonjour: config.bonjour ?? CONFIG_DEFAULTS.bonjour,
    
    listeners_per_channel: config.listeners_per_channel ?? CONFIG_DEFAULTS.listeners_per_channel,
    listeners_per_user: config.listeners_per_user ?? CONFIG_DEFAULTS.listeners_per_user,
    broadcast_listener_volume_adjustments: config.broadcast_listener_volume_adjustments ?? CONFIG_DEFAULTS.broadcast_listener_volume_adjustments,
    
    allow_recording: config.allow_recording ?? CONFIG_DEFAULTS.allow_recording,
    send_version: config.send_version ?? CONFIG_DEFAULTS.send_version,
    allow_ping: config.allow_ping ?? CONFIG_DEFAULTS.allow_ping,
    channel_ninja: config.channel_ninja ?? CONFIG_DEFAULTS.channel_ninja,
    
    log_days: config.log_days ?? CONFIG_DEFAULTS.log_days,
    
    // 应用自动封禁配置默认值
    auto_ban: config.auto_ban ? {
      attempts: config.auto_ban.attempts ?? DEFAULT_AUTO_BAN.attempts,
      timeframe: config.auto_ban.timeframe ?? DEFAULT_AUTO_BAN.timeframe,
      duration: config.auto_ban.duration ?? DEFAULT_AUTO_BAN.duration,
      ban_successful_connections: config.auto_ban.ban_successful_connections ?? DEFAULT_AUTO_BAN.ban_successful_connections,
    } : DEFAULT_AUTO_BAN,
    
    // 应用客户端建议配置默认值
    suggest: config.suggest ? {
      version: config.suggest.version,
      positional: config.suggest.positional ?? null,
      push_to_talk: config.suggest.push_to_talk ?? null,
    } : DEFAULT_CLIENT_SUGGEST,
    
    // 应用数据库配置默认值
    database: {
      ...config.database,
      wal_mode: config.database.wal_mode ?? CONFIG_DEFAULTS.wal_mode,
    },
  };
}
