// 认证配置
export interface AuthConfig {
  apiUrl: string;
  apiKey: string;
  timeout: number;
  retry: number;
  insecure: boolean;
  cacheTTL: number;
  userCachePath?: string;
  pullInterval: number;
  trackSessions: boolean;
  allowCacheFallback: boolean;
}

// 认证请求
export interface AuthRequest {
  username: string;
  password: string;
  certHash?: string;
  ipAddress: string;
  serverId: number;
}

// 认证响应
export interface AuthResponse {
  status: 'success' | 'error';
  userId?: number;
  username?: string;
  displayName?: string;
  groups?: string[];
  permissions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  code?: string;
  message?: string;
}

// 认证状态
export enum AuthStatus {
  Success = 0,
  UserNotFound = -2,
  InvalidCredentials = -1,
  Banned = -3,
  ServerError = -4,
}

// 认证结果
export interface AuthResult {
  status: AuthStatus;
  userId: number;
  username: string;
  groups: string[];
  permissions: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

// 缓存的用户
export interface CachedUser {
  userId: string;
  password: string;
  username: string;
  groups: string[];
  metadata?: Record<string, unknown>;
  cachedAt: number;
}
