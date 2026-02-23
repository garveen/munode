/**
 * @munode/auth-service
 *
 * TypeScript 用户认证服务包。
 * 连接到 Rust Hub 的 WebSocket 认证端口，接收认证请求并由用户自定义
 * callback 处理后返回结果。
 *
 * 快速开始：
 *
 * ```typescript
 * import { createAuthService } from '@munode/auth-service';
 *
 * const service = createAuthService({
 *   hubUrl: 'ws://127.0.0.1:8444',
 *   onAuth: async (req) => {
 *     const ok = req.username === 'alice' && req.password === 'secret';
 *     return {
 *       request_id: req.request_id,
 *       success: ok,
 *       user_id: ok ? 1 : undefined,
 *       reason: ok ? undefined : 'Wrong password',
 *       reject_type: ok ? undefined : 3,
 *     };
 *   },
 * });
 *
 * service.start();
 * ```
 */

export { AuthServiceClient } from './client.js';
export type { AuthServiceConfig, AuthCallback } from './client.js';
export {
  encodePacket,
  decodePacket,
  AuthServicePacket,
  AuthServicePacket_Type,
} from './protocol.js';
export type { AuthRequest, AuthResponse, HelloParams } from './protocol.js';

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

import { AuthServiceClient } from './client.js';
import type { AuthServiceConfig } from './client.js';

/**
 * Create and return a new AuthServiceClient without starting it.
 * Call `.start()` when ready.
 */
export function createAuthService(config: AuthServiceConfig): AuthServiceClient {
  return new AuthServiceClient(config);
}
