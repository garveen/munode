/**
 * 复合键工具
 * 用于在多租户环境下唯一标识客户端
 * 格式: "vhostName:sessionId"
 */

/**
 * 创建复合键
 * @param vhostName 虚拟主机名称
 * @param sessionId 会话 ID（虚拟主机内部分配）
 * @returns 复合键字符串，格式: "vhostName:sessionId"
 */
export function makeCompositeKey(vhostName: string, sessionId: number): string {
  return `${vhostName}:${sessionId}`;
}

/**
 * 解析复合键
 * @param compositeKey 复合键字符串
 * @returns { vhostName, sessionId }
 */
export function parseCompositeKey(compositeKey: string): { vhostName: string; sessionId: number } {
  const parts = compositeKey.split(':');
  if (parts.length !== 2) {
    throw new Error(`Invalid composite key format: ${compositeKey}`);
  }
  
  const [vhostName, sessionIdStr] = parts;
  const sessionId = parseInt(sessionIdStr, 10);
  
  if (isNaN(sessionId)) {
    throw new Error(`Invalid session ID in composite key: ${compositeKey}`);
  }
  
  return { vhostName, sessionId };
}

/**
 * 验证复合键格式
 */
export function isValidCompositeKey(key: string): boolean {
  try {
    parseCompositeKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从虚拟主机上下文和会话ID创建复合键
 */
export function makeCompositeKeyFromContext(vhostName: string, sessionId: number): string {
  return makeCompositeKey(vhostName, sessionId);
}
