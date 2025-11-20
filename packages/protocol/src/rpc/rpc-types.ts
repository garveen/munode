/**
 * RPC Method Type System
 * 定义所有 Hub-Edge RPC 方法的强类型映射
 */

import type {
  RPCResponse,
  ChannelsResponse,
  ACLsResponse,
  SaveChannelResponse,
  ChannelData,
  ACLData,
  BanData,
  VoiceTargetConfig,
  GlobalSession,
  ServerStats,
  RegisterResponse,
  HeartbeatResponse,
} from '../hub-edge-types.js';

// ============================================================================
// Edge -> Hub RPC Methods
// ============================================================================

/**
 * Edge 注册到 Hub
 */
export interface EdgeRegisterMethod {
  method: 'edge.register';
  params: {
    server_id: number;
    name: string;
    host: string;
    port: number;
    region?: string;
    capacity: number;
    certificate: string;
    metadata?: Record<string, unknown>;
  };
  result: RegisterResponse;
}

/**
 * Edge 发送心跳
 */
export interface EdgeHeartbeatMethod {
  method: 'edge.heartbeat';
  params: {
    server_id: number;
    stats: ServerStats;
  };
  result: HeartbeatResponse;
}

/**
 * Edge 分配 Session ID
 */
export interface EdgeAllocateSessionIdMethod {
  method: 'edge.allocateSessionId';
  params: {
    edge_id: number;
  };
  result: {
    session_id: number;
  };
}

/**
 * Edge 上报用户会话
 */
export interface EdgeReportSessionMethod {
  method: 'edge.reportSession';
  params: {
    session_id: number;
    user_id: number;
    username: string;
    edge_server_id: number;
    channel_id?: number;
    startTime: Date;
    ip_address: string;
    groups?: string[]; // 用户所属的组
    cert_hash?: string; // 证书哈希
  };
  result: RPCResponse;
}

/**
 * Edge 同步语音目标配置
 */
export interface EdgeSyncVoiceTargetMethod {
  method: 'edge.syncVoiceTarget';
  params: {
    edge_id: number;
    client_session: number;
    target_id: number;
    config: VoiceTargetConfig['config'];
    timestamp: number;
  };
  result: RPCResponse;
}

/**
 * Edge 获取语音目标配置
 */
export interface EdgeGetVoiceTargetsMethod {
  method: 'edge.getVoiceTargets';
  params: {
    edge_id?: number;
  };
  result: {
    voiceTargets: VoiceTargetConfig[];
  };
}

/**
 * Edge 请求路由语音数据
 */
export interface EdgeRouteVoiceMethod {
  method: 'edge.routeVoice';
  params: {
    fromEdgeId: number;
    fromSessionId: number;
    target_id: number;
    voiceData: Buffer;
    timestamp: number;
  };
  result: {
    success: boolean;
    routedTo: Array<{
      session_id: number;
      edge_id: number;
    }>;
  };
}

/**
 * Edge 执行管理操作
 */
export interface EdgeAdminOperationMethod {
  method: 'edge.adminOperation';
  params: {
    operation: string;
    data?: unknown;
  };
  result: RPCResponse & {
    message?: string;
    stats?: {
      edges: number;
      sessions: number;
      voiceTargets: number;
      channels: number;
    };
  };
}

/**
 * Edge 交换证书
 */
export interface EdgeExchangeCertificatesMethod {
  method: 'edge.exchangeCertificates';
  params: {
    server_id: number;
    certificate: string;
  };
  result: RPCResponse;
}

/**
 * Edge 请求完整同步
 */
export interface EdgeFullSyncMethod {
  method: 'edge.fullSync';
  params: Record<string, never>; // 空参数
  result: {
    channels: ChannelData[];
    channelLinks?: Array<{ channel_id: number; target_id: number }>;
    acls: ACLData[];
    bans: BanData[];
    sessions: GlobalSession[];
    configs?: Record<string, string>;
    timestamp: number;
    sequence: number;
    edges: Array<{
      server_id: number;
      name: string;
      host: string;
      port: number;
      region?: string;
      current_load: number;
      capacity: number;
    }>;
  };
}

/**
 * Edge 获取频道列表
 */
export interface EdgeGetChannelsMethod {
  method: 'edge.getChannels';
  params: Record<string, never>; // 空参数
  result: ChannelsResponse;
}

/**
 * Edge 获取 ACL 列表
 */
export interface EdgeGetACLsMethod {
  method: 'edge.getACLs';
  params: {
    channel_id: number;
  };
  result: ACLsResponse;
}

/**
 * Edge 保存频道
 */
export interface EdgeSaveChannelMethod {
  method: 'edge.saveChannel';
  params: {
    channel: {
      id?: number;
      name?: string;
      position?: number;
      max_users?: number;
      parent_id?: number;
      inherit_acl?: boolean;
      description?: string;
      description_blob?: string;
    };
  };
  result: SaveChannelResponse;
}

/**
 * Edge 保存 ACL
 */
export interface EdgeSaveACLMethod {
  method: 'edge.saveACL';
  params: {
    channel_id: number;
    acls: Array<{
      id?: number;
      channel_id?: number; // 可选，因为已经在params中指定
      user_id?: number;
      group?: string;
      apply_here: boolean;
      apply_subs: boolean;
      allow: number;
      deny: number;
    }>;
  };
  result: {
    success: boolean;
    aclIds: number[]; // 返回保存的ACL ID数组
  };
}

/**
 * Edge 请求加入集群
 */
export interface EdgeJoinMethod {
  method: 'edge.join';
  params: {
    server_id: number;
    name: string;
    host: string;
    port: number;
    voicePort: number;
    capacity: number;
  };
  result: {
    success: boolean;
    token: string;
    peers: Array<{
      id: number;
      name: string;
      host: string;
      port: number;
      voicePort: number;
    }>;
    timeout: number;
  };
}

/**
 * Edge 完成集群加入
 */
export interface EdgeJoinCompleteMethod {
  method: 'edge.joinComplete';
  params: {
    server_id: number;
    token: string;
    connectedPeers: number[];
  };
  result: RPCResponse;
}

/**
 * Edge 处理 ACL 消息（查询或更新）
 */
export interface EdgeHandleACLMethod {
  method: 'edge.handleACL';
  params: {
    edge_id: number;
    actor_session: number;
    actor_user_id: number;
    actor_username: string;
    channel_id: number;
    query: boolean;
    raw_data: string; // base64 encoded ACL message
  };
  result: {
    success: boolean;
    error?: string;
    permission_denied?: boolean; // 是否是权限拒绝
    channel_id?: number; // 返回的频道 ID
    raw_data?: string; // base64 encoded ACL response (for query)
  };
}

/**
 * Edge 报告 Peer 断开连接
 */
export interface EdgeReportPeerDisconnectMethod {
  method: 'edge.reportPeerDisconnect';
  params: {
    localEdgeId: number;
    remoteEdgeId: number;
    localClientCount: number;
  };
  result: {
    action: 'disconnect' | 'wait';
  };
}

/**
 * 获取集群状态
 */
export interface ClusterGetStatusMethod {
  method: 'cluster.getStatus';
  params: Record<string, never>; // 空参数
  result: {
    edges: Array<{
      id: number;
      name: string;
      host: string;
      port: number;
      clientCount: number;
      status: 'online' | 'offline';
      lastSeen?: number;
    }>;
  };
}

// ============================================================================
// Blob Storage RPC Methods
// ============================================================================

/**
 * 存储 Blob 数据
 */
export interface BlobPutMethod {
  method: 'blob.put';
  params: {
    data: Buffer;
  };
  result: {
    success: boolean;
    hash?: string; // SHA1 hash
    error?: string;
  };
}

/**
 * 获取 Blob 数据
 */
export interface BlobGetMethod {
  method: 'blob.get';
  params: {
    hash: string; // SHA1 hash
  };
  result: {
    success: boolean;
    data?: Buffer;
    error?: string;
  };
}

/**
 * 获取用户纹理
 */
export interface BlobGetUserTextureMethod {
  method: 'blob.getUserTexture';
  params: {
    user_id: number;
  };
  result: {
    success: boolean;
    data?: Buffer;
    hash?: string;
    error?: string;
  };
}

/**
 * 获取用户评论
 */
export interface BlobGetUserCommentMethod {
  method: 'blob.getUserComment';
  params: {
    user_id: number;
  };
  result: {
    success: boolean;
    data?: Buffer;
    hash?: string;
    error?: string;
  };
}

/**
 * 设置用户纹理
 */
export interface BlobSetUserTextureMethod {
  method: 'blob.setUserTexture';
  params: {
    user_id: number;
    data: Buffer;
  };
  result: {
    success: boolean;
    hash?: string;
    error?: string;
  };
}

/**
 * 设置用户评论
 */
export interface BlobSetUserCommentMethod {
  method: 'blob.setUserComment';
  params: {
    user_id: number;
    data: Buffer;
  };
  result: {
    success: boolean;
    hash?: string;
    error?: string;
  };
}

// ============================================================================
// Hub -> Edge RPC Methods (Notifications)
// ============================================================================

/**
 * Hub 通知 Edge 有语音数据
 */
export interface HubVoiceDataNotification {
  method: 'voice.data';
  params: {
    fromSessionId: number;
    targetSessionId: number;
    voiceData: Buffer;
    timestamp: number;
  };
}

/**
 * Hub 通知 Edge 强制断开连接
 */
export interface HubForceDisconnectNotification {
  method: 'edge.forceDisconnect';
  params: {
    reason: string;
  };
}

/**
 * Hub 通知 Edge 有新成员加入
 */
export interface HubPeerJoinedNotification {
  method: 'edge.peerJoined';
  params: {
    id: number;
    name: string;
    host: string;
    port: number;
    voicePort: number;
  };
}

/**
 * Hub 向 Edge 返回 ACL 查询结果
 */
export interface HubACLResponseNotification {
  method: 'hub.aclResponse';
  params: {
    edge_id: number;
    actor_session: number;
    success: boolean;
    channel_id?: number;
    raw_data?: string; // base64 encoded ACL message (for query success)
    error?: string;
    permission_denied?: boolean;
  };
}

// ============================================================================
// Type Union & Mapping
// ============================================================================

/**
 * 所有 Edge -> Hub 的 RPC 方法
 */
export type EdgeToHubMethods =
  | EdgeRegisterMethod
  | EdgeHeartbeatMethod
  | EdgeAllocateSessionIdMethod
  | EdgeReportSessionMethod
  | EdgeSyncVoiceTargetMethod
  | EdgeGetVoiceTargetsMethod
  | EdgeRouteVoiceMethod
  | EdgeAdminOperationMethod
  | EdgeExchangeCertificatesMethod
  | EdgeFullSyncMethod
  | EdgeGetChannelsMethod
  | EdgeGetACLsMethod
  | EdgeSaveChannelMethod
  | EdgeSaveACLMethod
  | EdgeHandleACLMethod
  | EdgeJoinMethod
  | EdgeJoinCompleteMethod
  | EdgeReportPeerDisconnectMethod
  | ClusterGetStatusMethod
  | BlobPutMethod
  | BlobGetMethod
  | BlobGetUserTextureMethod
  | BlobGetUserCommentMethod
  | BlobSetUserTextureMethod
  | BlobSetUserCommentMethod;

/**
 * 所有 Hub -> Edge 的通知方法
 */
export type HubToEdgeNotifications =
  | HubVoiceDataNotification
  | HubForceDisconnectNotification
  | HubPeerJoinedNotification
  | HubACLResponseNotification;

/**
 * 方法名到类型的映射
 */
export type RPCMethodMap = {
  [K in EdgeToHubMethods as K['method']]: K;
};

/**
 * 根据方法名获取参数类型
 */
export type RPCParams<M extends EdgeToHubMethods['method']> = RPCMethodMap[M]['params'];

/**
 * 根据方法名获取返回类型
 */
export type RPCResult<M extends EdgeToHubMethods['method']> = RPCMethodMap[M]['result'];

/**
 * 通知方法名到类型的映射
 */
export type NotificationMethodMap = {
  [K in HubToEdgeNotifications as K['method']]: K;
};

/**
 * 根据通知方法名获取参数类型
 */
export type NotificationParams<M extends HubToEdgeNotifications['method']> =
  NotificationMethodMap[M]['params'];
