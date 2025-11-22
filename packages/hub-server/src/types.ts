// Hub Server 配置
// 导入共享类型
import type { ServerStats, EdgeInfo, RegisterRequest, RegisterResponse, HeartbeatRequest, HeartbeatResponse } from '@munode/protocol';
export type { ServerStats, EdgeInfo, RegisterRequest, RegisterResponse, HeartbeatRequest, HeartbeatResponse };

export interface HubConfig {
   server_id: number;
  name: string;
  registerName?: string; // Root频道的显示名称（默认为"Root"）
  host: string;
  port: number;
  controlPort?: number; // 控制信道端口
  voicePort?: number;   // 语音信道端口
  
  // 基础网络配置
  timeout?: number; // 客户端超时时间（秒），默认: 30
  serverPassword?: string; // 服务器密码
  
  // 用户与频道限制
  maxUsers?: number; // 最大用户数，默认: 1000
  maxUsersPerChannel?: number; // 每频道最大用户数，默认: 0 (无限制)
  channelNestingLimit?: number; // 频道嵌套深度限制，默认: 10
  channelCountLimit?: number; // 频道总数限制，默认: 1000
  
  // 带宽与消息限制
  bandwidth?: number; // 每用户最大带宽 (bps)，默认: 558000
  textMessageLength?: number; // 文本消息最大长度，默认: 5000
  imageMessageLength?: number; // 图片消息最大长度（字节），默认: 131072
  messageLimit?: number; // 消息速率限制（消息/秒），默认: 1
  messageBurst?: number; // 消息突发容量，默认: 5
  pluginMessageLimit?: number; // 插件消息速率限制，默认: 4
  pluginMessageBurst?: number; // 插件消息突发容量，默认: 15
  
  // 认证与安全
  kdfIterations?: number; // PBKDF2迭代次数，默认: -1 (自动基准测试)
  allowHTML?: boolean; // 允许HTML消息，默认: true
  forceExternalAuth?: boolean; // 强制外部认证，默认: false
  sslCiphers?: string; // SSL加密套件配置
  
  // 用户名与频道名验证
  usernameRegex?: string; // 用户名正则表达式，默认: [ -=\w\[\]\{\}\(\)\@\|\.]+
  channelNameRegex?: string; // 频道名正则表达式，默认: [ -=\w\#\[\]\{\}\(\)\@\|]+
  
  // 欢迎消息
  welcomeText?: string; // 欢迎消息文本
  welcomeTextFile?: string; // 欢迎消息文件路径
  
  // 自动封禁配置
  autoBan?: AutoBanConfig;
  
  // 频道行为
  defaultChannel?: number; // 默认频道ID，默认: 0 (Root)
  rememberChannel?: boolean; // 记住用户上次频道，默认: true
  rememberChannelDuration?: number; // 记住频道的时长（秒），默认: 0 (永久)
  
  // 客户端建议
  suggest?: ClientSuggestConfig;
  
  // 服务器注册与发现
  registerPassword?: string; // 注册到公开列表的密码
  registerHostname?: string; // 注册主机名
  registerLocation?: string; // 服务器位置
  registerUrl?: string; // 服务器网站URL
  bonjour?: boolean; // 启用Bonjour/Zeroconf本地网络发现，默认: false
  
  // 监听功能
  listenersPerChannel?: number; // 每频道最大监听者数，默认: 0 (无限制)
  listenersPerUser?: number; // 每用户最大监听代理数，默认: 0 (无限制)
  broadcastListenerVolumeAdjustments?: boolean; // 广播监听者音量调整，默认: false
  
  // 高级功能
  allowRecording?: boolean; // 允许录音，默认: true
  sendVersion?: boolean; // 向客户端发送版本信息，默认: true
  allowPing?: boolean; // 允许ping，默认: true
  hideCertHashes?: boolean; // 混淆证书哈希，返回用户ID哈希代替真实证书哈希，默认: false
  
  // 日志配置
  logDays?: number; // 数据库日志保留天数，默认: 31
  
  // 认证配置
  auth?: HubAuthConfig;
  
  tls: TLSConfig;
  registry: RegistryConfig;
  database: DatabaseConfig;
  blobStore: BlobStoreConfig; // Blob存储配置
  webApi: WebApiConfig;
  logLevel: string;
  logFile?: string;
}

// Hub 认证配置
export interface HubAuthConfig {
  apiUrl?: string; // 外部认证 API 地址
  apiKey?: string; // API 密钥
  timeout?: number; // 超时时间（毫秒），默认 5000
  contentType?: 'application/json' | 'application/x-www-form-urlencoded'; // 请求内容类型，默认 'application/json'
  headers?: {
    authHeaderName?: string; // 认证头名称，默认 'Authorization'
    authHeaderFormat?: string; // 认证头格式，默认 'Bearer {apiKey}'
  };
  responseFields?: {
    successField?: string; // 成功标志字段名，默认 'success'
    userIdField?: string; // 用户ID字段名，默认 'user_id'
    usernameField?: string; // 用户名字段名，默认 'username'
    displayNameField?: string; // 显示名字段名，默认 'displayName'
    groupsField?: string; // 用户组字段名，默认 'groups'
    reasonField?: string; // 失败原因字段名，默认 'reason' 或 'message'
  };
  cacheTTL?: number; // 缓存TTL（毫秒），默认 300000 (5分钟)
  allowCacheFallback?: boolean; // 是否允许缓存回退，默认 false
}

// TLS 配置
export interface TLSConfig {
  cert?: string;
  key?: string;
  ca?: string;
  requireClientCert?: boolean;
  rejectUnauthorized?: boolean;
}

// 注册表配置
export interface RegistryConfig {
  heartbeatInterval: number;
  timeout: number;
  maxEdges: number;
}

// 数据库配置
export interface DatabaseConfig {
  path: string;
  backupDir: string;
  backupInterval: number;
  walMode?: boolean; // 启用SQLite WAL模式，默认: false
}

// Blob存储配置
export interface BlobStoreConfig {
  enabled: boolean;  // 是否启用blob存储
  path: string;      // blob存储目录
}

// Web API 配置
export interface WebApiConfig {
  enabled: boolean;
  port: number;
  cors: boolean;
}

// 已注册的 Edge 服务器信息
export interface RegisteredEdge {
   server_id: number;
  name: string;
  host: string;
  port: number;
  region?: string;
  capacity: number;
   current_load: number;
  certificate: string;
   last_seen: number;
  stats: ServerStats;
}

// VoiceTarget 配置
export interface VoiceTargetConfig {
   edge_id: number;
   client_session: number;
   target_id: number;
  config: import('@munode/protocol').VoiceTarget | null;
  timestamp: number;
}

// 导出 VoiceTarget 类型别名
export type VoiceTarget = import('@munode/protocol').VoiceTarget;

// 自动封禁配置
export interface AutoBanConfig {
  attempts: number; // 失败尝试次数，默认: 10
  timeframe: number; // 时间窗口（秒），默认: 120
  duration: number; // 封禁时长（秒），默认: 300
  banSuccessfulConnections: boolean; // 成功连接后是否重置计数，默认: true
}

// 客户端建议配置
export interface ClientSuggestConfig {
  version?: string; // 建议客户端版本，格式: "1.4.0"
  positional?: boolean | null; // 建议启用位置音频
  pushToTalk?: boolean | null; // 建议使用按键说话
}

// 证书信息
export interface CertificateInfo {
   server_id: number;
  pem: string;
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
  subject: unknown;
  issuer: unknown;
}

// 证书交换结果
export interface CertificateExchangeResult {
  success: boolean;
  certificates?: Record<number, string>;
  error?: string;
}

// 服务器统计信息
export interface ServiceRegistry {
  register(request: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
  unregister( server_id: number): Promise<void>;
  getEdge( server_id: number): RegisteredEdge | undefined;
  getEdgeList(): EdgeInfo[];
  getEdgeCount(): number;
  cleanup(): void;
}
