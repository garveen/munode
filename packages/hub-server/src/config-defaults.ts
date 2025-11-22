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
  banSuccessfulConnections: true,
};

// 默认的客户端建议配置
export const DEFAULT_CLIENT_SUGGEST: ClientSuggestConfig = {
  version: undefined,
  positional: null,
  pushToTalk: null,
};

// 配置默认值
export const CONFIG_DEFAULTS = {
  // 基础网络配置
  timeout: 30,
  
  // 用户与频道限制
  maxUsers: 1000,
  maxUsersPerChannel: 0, // 0 表示无限制
  channelNestingLimit: 10,
  channelCountLimit: 1000,
  
  // 带宽与消息限制
  bandwidth: 558000, // 558 Kbps
  textMessageLength: 5000,
  imageMessageLength: 131072, // 128 KB
  messageLimit: 1,
  messageBurst: 5,
  pluginMessageLimit: 4,
  pluginMessageBurst: 15,
  
  // 认证与安全
  kdfIterations: -1, // -1 表示自动基准测试
  allowHTML: true,
  forceExternalAuth: false,
  
  // 用户名与频道名验证（Murmur 默认正则）
  usernameRegex: '[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+',
  channelNameRegex: '[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+',
  
  // 频道行为
  defaultChannel: 0, // Root 频道
  rememberChannel: true,
  rememberChannelDuration: 0, // 0 表示永久记住
  
  // 服务器注册与发现
  bonjour: false,
  
  // 监听功能
  listenersPerChannel: 0, // 0 表示无限制
  listenersPerUser: 0, // 0 表示无限制
  broadcastListenerVolumeAdjustments: false,
  
  // 高级功能
  allowRecording: true,
  sendVersion: true,
  allowPing: true,
  channelNinja: false,
  
  // 日志配置
  logDays: 31,
  
  // 数据库配置
  walMode: false,
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
    maxUsers: config.maxUsers ?? CONFIG_DEFAULTS.maxUsers,
    maxUsersPerChannel: config.maxUsersPerChannel ?? CONFIG_DEFAULTS.maxUsersPerChannel,
    channelNestingLimit: config.channelNestingLimit ?? CONFIG_DEFAULTS.channelNestingLimit,
    channelCountLimit: config.channelCountLimit ?? CONFIG_DEFAULTS.channelCountLimit,
    
    bandwidth: config.bandwidth ?? CONFIG_DEFAULTS.bandwidth,
    textMessageLength: config.textMessageLength ?? CONFIG_DEFAULTS.textMessageLength,
    imageMessageLength: config.imageMessageLength ?? CONFIG_DEFAULTS.imageMessageLength,
    messageLimit: config.messageLimit ?? CONFIG_DEFAULTS.messageLimit,
    messageBurst: config.messageBurst ?? CONFIG_DEFAULTS.messageBurst,
    pluginMessageLimit: config.pluginMessageLimit ?? CONFIG_DEFAULTS.pluginMessageLimit,
    pluginMessageBurst: config.pluginMessageBurst ?? CONFIG_DEFAULTS.pluginMessageBurst,
    
    kdfIterations: config.kdfIterations ?? CONFIG_DEFAULTS.kdfIterations,
    allowHTML: config.allowHTML ?? CONFIG_DEFAULTS.allowHTML,
    forceExternalAuth: config.forceExternalAuth ?? CONFIG_DEFAULTS.forceExternalAuth,
    
    usernameRegex: config.usernameRegex ?? CONFIG_DEFAULTS.usernameRegex,
    channelNameRegex: config.channelNameRegex ?? CONFIG_DEFAULTS.channelNameRegex,
    
    defaultChannel: config.defaultChannel ?? CONFIG_DEFAULTS.defaultChannel,
    rememberChannel: config.rememberChannel ?? CONFIG_DEFAULTS.rememberChannel,
    rememberChannelDuration: config.rememberChannelDuration ?? CONFIG_DEFAULTS.rememberChannelDuration,
    
    bonjour: config.bonjour ?? CONFIG_DEFAULTS.bonjour,
    
    listenersPerChannel: config.listenersPerChannel ?? CONFIG_DEFAULTS.listenersPerChannel,
    listenersPerUser: config.listenersPerUser ?? CONFIG_DEFAULTS.listenersPerUser,
    broadcastListenerVolumeAdjustments: config.broadcastListenerVolumeAdjustments ?? CONFIG_DEFAULTS.broadcastListenerVolumeAdjustments,
    
    allowRecording: config.allowRecording ?? CONFIG_DEFAULTS.allowRecording,
    sendVersion: config.sendVersion ?? CONFIG_DEFAULTS.sendVersion,
    allowPing: config.allowPing ?? CONFIG_DEFAULTS.allowPing,
    channelNinja: config.channelNinja ?? CONFIG_DEFAULTS.channelNinja,
    
    logDays: config.logDays ?? CONFIG_DEFAULTS.logDays,
    
    // 应用自动封禁配置默认值
    autoBan: config.autoBan ? {
      attempts: config.autoBan.attempts ?? DEFAULT_AUTO_BAN.attempts,
      timeframe: config.autoBan.timeframe ?? DEFAULT_AUTO_BAN.timeframe,
      duration: config.autoBan.duration ?? DEFAULT_AUTO_BAN.duration,
      banSuccessfulConnections: config.autoBan.banSuccessfulConnections ?? DEFAULT_AUTO_BAN.banSuccessfulConnections,
    } : DEFAULT_AUTO_BAN,
    
    // 应用客户端建议配置默认值
    suggest: config.suggest ? {
      version: config.suggest.version,
      positional: config.suggest.positional ?? null,
      pushToTalk: config.suggest.pushToTalk ?? null,
    } : DEFAULT_CLIENT_SUGGEST,
    
    // 应用数据库配置默认值
    database: {
      ...config.database,
      walMode: config.database.walMode ?? CONFIG_DEFAULTS.walMode,
    },
  };
}
