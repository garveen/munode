/**
 * Edge-Hub RPC 方法类型定义
 * 
 * 这个文件定义了所有 Edge 和 Hub 之间的 RPC 方法签名，
 * 提供类型安全的 RPC 调用接口
 */

// ============================================================================
// Edge -> Hub RPC 方法
// ============================================================================

/**
 * Edge 注册到 Hub
 */
export interface EdgeRegisterMethod {
  method: 'edge.register';
  params: {
    edge_id: number;
    server_name: string;
    host: string;
    port: number;
    max_users: number;
    protocol_version: string;  // 例如: "2.0.0-protobuf"
    supported_features: string[];  // 例如: ["batch-sync", "compression"]
  };
  result: {
    success: boolean;
    hub_id: number;
    hub_protocol_version: string;
    hub_supported_features: string[];
    initial_sync_sequence: number;
  };
}

/**
 * 向 Hub 请求分配 Session ID（新增）
 * 
 * Edge 在接受客户端连接后，必须先向 Hub 请求分配全局唯一的 Session ID
 */
export interface EdgeAllocateSessionIdMethod {
  method: 'edge.allocateSessionId';
  params: {
    edge_id: number;
    client_ip?: string;  // 可选的客户端 IP，用于日志和统计
  };
  result: {
    session_id: number;  // Hub 分配的全局唯一 Session ID
  };
}

/**
 * 用户认证（认证前必须先分配 Session ID）
 */
export interface EdgeAuthenticateUserMethod {
  method: 'edge.authenticateUser';
  params: {
    session_id: number;  // 已分配的 Session ID
    username: string;
    password?: string;
    tokens?: string[];
    cert_hash?: string;
  };
  result: {
    success: boolean;
    user_id: number;
    username: string;
    groups: string[];
    error?: string;
  };
}

/**
 * 查询用户权限
 */
export interface EdgeQueryPermissionMethod {
  method: 'edge.queryPermission';
  params: {
    session_id: number;
    channel_id: number;
    permission: number;  // 权限位掩码
  };
  result: {
    allowed: boolean;
    effective_permissions: number;  // 有效的权限位掩码
  };
}

/**
 * 查询用户信息
 */
export interface EdgeQueryUserMethod {
  method: 'edge.queryUser';
  params: {
    user_id?: number;
    username?: string;
    cert_hash?: string;
  };
  result: {
    found: boolean;
    user?: {
      user_id: number;
      username: string;
      last_seen?: number;
      last_channel?: number;
    };
  };
}

/**
 * 查询频道 ACL
 */
export interface EdgeQueryChannelACLMethod {
  method: 'edge.queryChannelACL';
  params: {
    channel_id: number;
  };
  result: {
    channel_id: number;
    inherit_acl: boolean;
    acl_entries: Array<{
      user_id?: number;
      group?: string;
      allow: number;
      deny: number;
      apply_here: boolean;
      apply_subs: boolean;
    }>;
    groups: Array<{
      name: string;
      inherited: boolean;
      inherit: boolean;
      inheritable: boolean;
      members: number[];
    }>;
  };
}

/**
 * 请求频道树（用于客户端连接时获取完整频道结构）
 */
export interface EdgeQueryChannelTreeMethod {
  method: 'edge.queryChannelTree';
  params: {
    root_channel_id?: number;  // 可选，默认从根频道开始
  };
  result: {
    channels: Array<{
      channel_id: number;
      name: string;
      parent_id?: number;
      description?: string;
      position: number;
      temporary: boolean;
      max_users?: number;
    }>;
  };
}

/**
 * 请求在线用户列表
 */
export interface EdgeQueryOnlineUsersMethod {
  method: 'edge.queryOnlineUsers';
  params: {
    channel_id?: number;  // 可选，只查询特定频道的用户
  };
  result: {
    users: Array<{
      session_id: number;
      user_id: number;
      username: string;
      channel_id: number;
      mute: boolean;
      deaf: boolean;
      self_mute: boolean;
      self_deaf: boolean;
    }>;
  };
}

// ============================================================================
// Hub -> Edge RPC 方法
// ============================================================================

/**
 * Hub 请求 Edge 断开客户端连接
 */
export interface HubDisconnectClientMethod {
  method: 'hub.disconnectClient';
  params: {
    session_id: number;
    reason: string;
  };
  result: {
    success: boolean;
  };
}

/**
 * Hub 请求 Edge 重新加载配置
 */
export interface HubReloadConfigMethod {
  method: 'hub.reloadConfig';
  params: {
    config_version: number;
  };
  result: {
    success: boolean;
    current_version: number;
  };
}

/**
 * Hub 请求 Edge 提供详细统计信息
 */
export interface HubRequestStatsMethod {
  method: 'hub.requestStats';
  params: {
    include_clients?: boolean;
  };
  result: {
    user_count: number;
    channel_count: number;
    cpu_usage: number;
    memory_usage_mb: number;
    network_send_kbps: number;
    network_recv_kbps: number;
    uptime_seconds: number;
    clients?: Array<{
      session_id: number;
      username: string;
      connected_duration: number;
      bytes_sent: number;
      bytes_received: number;
    }>;
  };
}

// ============================================================================
// RPC 方法注册表类型
// ============================================================================

/**
 * Edge -> Hub 的所有 RPC 方法
 */
export interface EdgeToHubMethods {
  'edge.register': EdgeRegisterMethod;
  'edge.allocateSessionId': EdgeAllocateSessionIdMethod;
  'edge.authenticateUser': EdgeAuthenticateUserMethod;
  'edge.queryPermission': EdgeQueryPermissionMethod;
  'edge.queryUser': EdgeQueryUserMethod;
  'edge.queryChannelACL': EdgeQueryChannelACLMethod;
  'edge.queryChannelTree': EdgeQueryChannelTreeMethod;
  'edge.queryOnlineUsers': EdgeQueryOnlineUsersMethod;
  // 添加索引签名以满足泛型约束
  [key: string]: { method: string; params: any; result: any };
}

/**
 * Hub -> Edge 的所有 RPC 方法
 */
export interface HubToEdgeMethods {
  'hub.disconnectClient': HubDisconnectClientMethod;
  'hub.reloadConfig': HubReloadConfigMethod;
  'hub.requestStats': HubRequestStatsMethod;
  // 添加索引签名以满足泛型约束
  [key: string]: { method: string; params: any; result: any };
}

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * 从方法名获取参数类型
 */
export type RPCParams<
  Methods extends Record<string, { method: string; params: any }>,
  M extends keyof Methods
> = Methods[M] extends { params: infer P } ? P : never;

/**
 * 从方法名获取返回值类型
 */
export type RPCResult<
  Methods extends Record<string, { method: string; result: any }>,
  M extends keyof Methods
> = Methods[M] extends { result: infer R } ? R : never;

/**
 * RPC 调用选项
 */
export interface RPCCallOptions {
  timeout?: number;  // 超时时间（毫秒），默认 30000
  trace_id?: string;  // 可选的追踪 ID
}

/**
 * RPC 错误代码
 */
export enum RPCErrorCode {
  UNKNOWN = 0,
  TIMEOUT = 1,
  METHOD_NOT_FOUND = 2,
  INVALID_PARAMS = 3,
  INTERNAL_ERROR = 4,
  NOT_AUTHENTICATED = 5,
  PERMISSION_DENIED = 6,
  RATE_LIMITED = 7,
  SERVICE_UNAVAILABLE = 8,
}

/**
 * RPC 错误类
 */
export class RPCError extends Error {
  constructor(
    public code: RPCErrorCode,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'RPCError';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }

  static fromJSON(json: { code: number; message: string; details?: any }): RPCError {
    return new RPCError(json.code, json.message, json.details);
  }
}
