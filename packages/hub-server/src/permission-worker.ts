/**
 * Permission Worker Thread
 *
 * 在独立线程中批量计算用户对所有频道的进入权限，避免阻塞主线程。
 * 数据（频道列表、ACL 列表）由主线程传入，无需访问数据库。
 */

import { parentPort } from 'node:worker_threads';

// ────────────────────────────────────────────────────────────────────────────
// 类型定义（与主线程共享，通过消息传递）
// ────────────────────────────────────────────────────────────────────────────

export interface PermWorkerChannel {
  id: number;
  parent_id: number;
  inherit_acl: boolean;
}

export interface PermWorkerACLEntry {
  channel_id: number;
  user_id?: number;
  group?: string;
  apply_here: boolean;
  apply_subs: boolean;
  allow: number;
  deny: number;
}

export interface PermWorkerUserInfo {
  session_id: number;
  user_id: number;
  cert_hash?: string;
  channel_id?: number;
  groups?: string[];
}

export interface PermWorkerRequest {
  id: number;
  channels: PermWorkerChannel[];
  /** key = channelId (stringified) */
  aclMap: Record<string, PermWorkerACLEntry[]>;
  user: PermWorkerUserInfo;
}

export interface PermWorkerChannelResult {
  channel_id: number;
  can_enter: boolean;
  is_enter_restricted: boolean;
}

export interface PermWorkerResponse {
  id: number;
  success: boolean;
  results?: PermWorkerChannelResult[];
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 权限常量
// ────────────────────────────────────────────────────────────────────────────

const PERM_TRAVERSE = 0x2;
const PERM_ENTER    = 0x4;
const PERM_WRITE    = 0x1;

const DEFAULT_PERMISSIONS =
  PERM_TRAVERSE |
  PERM_ENTER    |
  0x8  | // Speak
  0x100 | // Whisper
  0x200 | // TextMessage
  0x800;  // Listen

// ────────────────────────────────────────────────────────────────────────────
// 特殊组判断（纯逻辑，无 DB）
// ────────────────────────────────────────────────────────────────────────────

function groupMatchesUser(group: string, user: PermWorkerUserInfo): boolean {
  if (group === 'all') return true;
  if (group === 'auth') return user.user_id > 0;
  if (group === 'none') return false;

  // 取反前缀 !
  if (group.startsWith('!')) {
    return !groupMatchesUser(group.slice(1), user);
  }

  // 证书哈希 $hash
  if (group.startsWith('$')) {
    return user.cert_hash === group.slice(1);
  }

  // 令牌组 #token
  if (group.startsWith('#')) {
    const token = group.slice(1);
    return user.groups?.includes(token) ?? false;
  }

  // 普通用户组：与 session.groups 匹配
  return user.groups?.includes(group) ?? false;
}

// ────────────────────────────────────────────────────────────────────────────
// 频道链构建（从目标频道到根，再反转）
// ────────────────────────────────────────────────────────────────────────────

function buildChannelChain(
  channelId: number,
  channelMap: Map<number, PermWorkerChannel>
): PermWorkerChannel[] {
  const chain: PermWorkerChannel[] = [];
  let current = channelMap.get(channelId) ?? null;
  while (current) {
    chain.unshift(current);
    if (current.id === 0 || current.parent_id === undefined || current.parent_id < 0) break;
    current = channelMap.get(current.parent_id) ?? null;
  }
  return chain;
}

// ────────────────────────────────────────────────────────────────────────────
// 单频道权限计算
// ────────────────────────────────────────────────────────────────────────────

function calculatePermission(
  channelId: number,
  user: PermWorkerUserInfo,
  channelMap: Map<number, PermWorkerChannel>,
  aclMap: Map<number, PermWorkerACLEntry[]>
): number {
  const channel = channelMap.get(channelId);
  if (!channel) return 0;

  // SuperUser 检查
  const isSuperUser = user.groups?.includes('admin') || user.groups?.includes('superuser');
  if (isSuperUser) {
    return channelId === 0 ? 0xf0fff : 0xfff;
  }

  const chain = buildChannelChain(channelId, channelMap);
  const origChannel = channel;

  let granted = DEFAULT_PERMISSIONS;
  let traverse = true;
  let write = false;

  for (const ctx of chain) {
    if (!ctx.inherit_acl) {
      granted = DEFAULT_PERMISSIONS;
    }

    const acls = aclMap.get(ctx.id) ?? [];

    for (const acl of acls) {
      const applyFromSelf  = (ctx.id === origChannel.id) && acl.apply_here;
      const applyInherited = (ctx.id !== origChannel.id) && acl.apply_subs;
      const apply          = applyFromSelf || applyInherited;
      const applyTraverse  = applyInherited || acl.apply_here;

      if (!apply && !applyTraverse) continue;

      const matchUser  = acl.user_id !== undefined && acl.user_id > 0 && acl.user_id === user.user_id;
      const matchGroup = acl.group ? groupMatchesUser(acl.group, user) : false;

      if (matchUser || matchGroup) {
        if (applyTraverse) {
          if (acl.allow & PERM_TRAVERSE) traverse = true;
          if (acl.deny  & PERM_TRAVERSE) traverse = false;
        }

        if (apply) {
          if (acl.allow & PERM_WRITE) write = true;
          if (acl.deny  & PERM_WRITE) write = false;

          const rootOnlyPerms = 0x10000 | 0x20000 | 0x40000 | 0x80000;
          if (ctx.id === 0 && applyFromSelf) {
            granted |= (acl.allow & rootOnlyPerms);
          }
          granted |= (acl.allow & ~rootOnlyPerms);
          granted &= ~acl.deny;
        }
      }
    }

    if (!traverse && !write) {
      granted = 0;
      break;
    }
  }

  // Write 权限隐含大部分权限
  if (granted & PERM_WRITE) {
    granted |= PERM_TRAVERSE | PERM_ENTER | 0x10 | 0x20 | 0x40 | 0x80 | 0x200 | 0x400 | 0x800;
    if (channelId === 0) granted |= 0x10000 | 0x20000 | 0x40000 | 0x80000;
  }

  return granted;
}

// ────────────────────────────────────────────────────────────────────────────
// is_enter_restricted：该频道是否有任何 deny Enter 的 ACL 条目（包含继承链）
// 对目标频道本身：检查所有直接 ACL（无需过滤 apply_here，与 C++ 行为一致）
// 对父频道：只检查 apply_subs=true 的 ACL；遍到 inherit_acl=false 时重置
// ────────────────────────────────────────────────────────────────────────────

function isEnterRestricted(
  channelId: number,
  channelMap: Map<number, PermWorkerChannel>,
  aclMap: Map<number, PermWorkerACLEntry[]>
): boolean {
  const chain = buildChannelChain(channelId, channelMap);
  let hasRestriction = false;

  for (const ctx of chain) {
    // 如果该频道设置了 inherit_acl=false，则其上方所有父频道的 ACL 对它不生效 —— 重置
    if (!ctx.inherit_acl) {
      hasRestriction = false;
    }

    const acls = aclMap.get(ctx.id) ?? [];
    const isTarget = ctx.id === channelId;

    if (isTarget) {
      // 目标频道自身：检查所有直接 ACL（与 C++ isChannelEnterRestricted 一致，不过滤 apply_here）
      if (acls.some(acl => (acl.deny & PERM_ENTER) !== 0)) {
        hasRestriction = true;
      }
    } else {
      // 父频道：只有 apply_subs=true 的 ACL 才会影响子频道
      if (acls.some(acl => acl.apply_subs && (acl.deny & PERM_ENTER) !== 0)) {
        hasRestriction = true;
      }
    }
  }

  return hasRestriction;
}

// ────────────────────────────────────────────────────────────────────────────
// 消息处理入口
// ────────────────────────────────────────────────────────────────────────────

if (!parentPort) {
  throw new Error('permission-worker must run as a Worker thread');
}

parentPort.on('message', (req: PermWorkerRequest) => {
  try {
    const channelMap = new Map<number, PermWorkerChannel>(
      req.channels.map(ch => [ch.id, ch])
    );
    const aclMap = new Map<number, PermWorkerACLEntry[]>(
      Object.entries(req.aclMap).map(([k, v]) => [Number(k), v])
    );

    const results: PermWorkerChannelResult[] = req.channels.map(ch => {
      const perms = calculatePermission(ch.id, req.user, channelMap, aclMap);
      return {
        channel_id: ch.id,
        can_enter:            (perms & PERM_ENTER) !== 0,
        is_enter_restricted:  isEnterRestricted(ch.id, channelMap, aclMap),
      };
    });

    const response: PermWorkerResponse = { id: req.id, success: true, results };
    parentPort!.postMessage(response);
  } catch (err) {
    const response: PermWorkerResponse = {
      id: req.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort!.postMessage(response);
  }
});
