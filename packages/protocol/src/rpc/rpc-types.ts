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
 * 支持两阶段认证：
 * 1. 不传 challenge_response 时，Hub 返回 challenge
 * 2. 传 challenge_response 时，Hub 验证并完成注册
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
    
    // HMAC 挑战-响应认证
    challenge?: string; // Hub 返回的挑战码
    challenge_response?: string; // Edge 计算的 HMAC 签名
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
 * Edge 请求用户认证
 */
export interface EdgeAuthenticateUserMethod {
  method: 'edge.authenticateUser';
  params: {
    session_id: number;
    server_id: number;
    username: string;
    password: string;
    tokens: string[];
    client_info: {
      ip_address: string;
      ip_version: string; // 'ipv4' or 'ipv6'
      release: string; // 客户端版本
      version?: number; // 客户端版本号（数字格式）
      os: string; // 操作系统
      os_version: string; // 操作系统版本
      certificate_hash?: string; // 证书哈希
    };
  };
  result: {
    success: boolean;
    user_id?: number;
    username?: string;
    displayName?: string;
    groups?: string[];
    reason?: string;
    rejectType?: number; // mumbleproto.Reject.RejectType
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
    version?: string; // 客户端版本
    release?: string; // 客户端名称
    os?: string; // 操作系统
    os_version?: string; // 操作系统版本
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
  params: {
    // Optional: If provided, filter sessions based on ninja channel visibility for this user
    for_user_id?: number;
    for_user_groups?: string[];
    for_user_channel_id?: number;
    for_user_cert_hash?: string;
  };
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
 * Edge 处理 PermissionQuery 消息
 */
export interface EdgeHandlePermissionQueryMethod {
  method: 'edge.handlePermissionQuery';
  params: {
    edge_id: number;
    actor_session: number;
    actor_user_id: number;
    actor_username: string;
    channel_id: number;
  };
  result: {
    success: boolean;
    permissions?: number; // 计算出的权限值
    error?: string;
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
 * Edge 上报网络质量信息到 Hub
 */
export interface EdgeReportQualityMethod {
  method: 'edge.reportQuality';
  params: {
    edge_id: number;
    target_edge_id: number;
    quality: {
      rtt: number;
      packetLoss: number;
      jitter: number;
      samples: number;
    };
  };
  result: {
    success: boolean;
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
// Edge -> Hub Notification Methods (不需要响应的通知)
// ============================================================================

/**
 * Edge 通知 Hub 用户状态变更
 */
export interface EdgeUserStateNotification {
  method: 'edge.userStateNotification';
  params: {
    edge_id: number;
    actor_session: number;
    actor_username: string;
    userState: {
      session?: number;
      actor?: number;
      name?: string;
      user_id?: number;
      channel_id?: number;
      mute?: boolean;
      deaf?: boolean;
      suppress?: boolean;
      self_mute?: boolean;
      self_deaf?: boolean;
      priority_speaker?: boolean;
      recording?: boolean;
      listening_channel_add?: number[];
      listening_channel_remove?: number[];
      temporary_access_tokens?: string[];
      texture?: Buffer;
      plugin_context?: Buffer;
      plugin_identity?: string;
    };
  };
}

/**
 * Edge 通知 Hub 用户离开
 */
export interface EdgeUserLeftNotification {
  method: 'edge.userLeftNotification';
  params: {
    edge_id: number;
    session_id: number;
    reason?: string;
  };
}

/**
 * Edge 通知 Hub 频道状态变更
 */
export interface EdgeChannelStateNotification {
  method: 'edge.channelStateNotification';
  params: {
    edge_id: number;
    actor_session: number;
    actor_user_id: number;
    actor_username: string;
    channelState: {
      channel_id?: number;
      parent?: number;
      name?: string;
      description?: string;
      description_hash?: Buffer;
      temporary?: boolean;
      position?: number;
      max_users?: number;
      links_add?: number[];
      links_remove?: number[];
    };
    has_channel_id: boolean; // protobuf optional field indicator
    raw_data?: string; // base64 encoded raw protobuf data
  };
}

/**
 * Edge 通知 Hub 频道移除
 */
export interface EdgeChannelRemoveNotification {
  method: 'edge.channelRemoveNotification';
  params: {
    edge_id: number;
    actor_session: number;
    actor_user_id: number;
    actor_username: string;
    channel_id: number;
  };
}

/**
 * Edge 通知 Hub 用户移除
 */
export interface EdgeUserRemoveNotification {
  method: 'edge.userRemoveNotification';
  params: {
    edge_id: number;
    actor_session: number;
    actor_user_id: number;
    actor_username: string;
    target_session: number;
    reason?: string;
    ban?: boolean;
  };
}

/**
 * Edge 通知 Hub 文本消息
 */
export interface EdgeTextMessageNotification {
  method: 'edge.textMessageNotification';
  params: {
    edge_id: number;
    actor_session: number;
    actor_user_id: number;
    actor_username: string;
    session?: number[];
    channel_id?: number[];
    tree_id?: number[];
    message: string;
  };
}

/**
 * Edge 通知 Hub 插件数据传输
 */
export interface EdgePluginDataTransmissionNotification {
  method: 'edge.pluginDataTransmissionNotification';
  params: {
    edge_id: number;
    actor_session: number;
    actor_username: string;
    sender_session: number;
    dataID: string;
    data: Buffer;
    receiver_sessions?: number[];
    pluginData?: {
      dataID: string;
      data: Buffer;
    };
  };
}

/**
 * Edge 通知 Hub 用户统计
 */
export interface EdgeUserStatsNotification {
  method: 'edge.userStatsNotification';
  params: {
    edge_id: number;
    actor_session: number;
    actor_user_id: number;
    actor_username: string;
    target_session: number;
    stats_only: boolean;
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

/**
 * Hub 通知 Edge 用户状态广播
 */
export interface HubUserStateBroadcastNotification {
  method: 'hub.userStateBroadcast';
  params: {
    session: number;
    actor: number;
    name?: string;
    user_id?: number;
    channel_id?: number;
    mute?: boolean;
    deaf?: boolean;
    suppress?: boolean;
    self_mute?: boolean;
    self_deaf?: boolean;
    priority_speaker?: boolean;
    recording?: boolean;
    listening_channel_add?: number[];
    listening_channel_remove?: number[];
    temporary_access_tokens?: string[];
    texture?: Buffer;
    plugin_context?: Buffer;
    plugin_identity?: string;
    target_sessions?: number[]; // Optional: for Channel Ninja filtered broadcast
  };
}

/**
 * Hub 通知 Edge 用户状态响应
 */
export interface HubUserStateResponseNotification {
  method: 'hub.userStateResponse';
  params: {
    success: boolean;
    actor_session: number;
    target_session?: number;
    error?: string;
    permission_denied?: boolean;
    permission_type?: string;
    // The actual UserState data to send back to the client
    userState?: {
      session: number;
      actor: number;
      name?: string;
      user_id?: number;
      channel_id?: number;
      mute?: boolean;
      deaf?: boolean;
      suppress?: boolean;
      self_mute?: boolean;
      self_deaf?: boolean;
      priority_speaker?: boolean;
      recording?: boolean;
      listening_channel_add?: number[];
      listening_channel_remove?: number[];
      temporary_access_tokens?: string[];
      texture?: Buffer;
      plugin_context?: Buffer;
      plugin_identity?: string;
    };
  };
}

/**
 * Hub 通知 Edge 频道状态广播
 */
export interface HubChannelStateBroadcastNotification {
  method: 'hub.channelStateBroadcast';
  params: {
    channel_id: number;
    parent?: number;
    name?: string;
    description?: string;
    description_hash?: Buffer;
    temporary?: boolean;
    position?: number;
    max_users?: number;
    is_enter_restricted?: boolean;
    can_enter?: boolean;
    // Channel link fields for managing linked channels
    links?: number[];        // Complete list of linked channels (replaces current links)
    links_add?: number[];    // Channels to add to current links (incremental update)
    links_remove?: number[]; // Channels to remove from current links (incremental update)
    inherit_acl?: boolean;   // Whether the channel inherits ACL from parent
  };
}

/**
 * Hub 通知 Edge 频道状态响应
 */
export interface HubChannelStateResponseNotification {
  method: 'hub.channelStateResponse';
  params: {
    success: boolean;
    actor_session: number;
    error?: string;
    permission_denied?: boolean;
  };
}

/**
 * Hub 通知 Edge 用户移除广播
 */
export interface HubUserRemoveBroadcastNotification {
  method: 'hub.userRemoveBroadcast';
  params: {
    session: number;
    actor: number;
    reason?: string;
    ban?: boolean;
  };
}

/**
 * Hub 通知 Edge 用户移除响应
 */
export interface HubUserRemoveResponseNotification {
  method: 'hub.userRemoveResponse';
  params: {
    success: boolean;
    actor_session: number;
    error?: string;
  };
}

/**
 * Hub 通知 Edge 频道移除广播
 */
export interface HubChannelRemoveBroadcastNotification {
  method: 'hub.channelRemoveBroadcast';
  params: {
    channel_id: number;
  };
}

/**
 * Hub 通知 Edge 频道移除响应
 */
export interface HubChannelRemoveResponseNotification {
  method: 'hub.channelRemoveResponse';
  params: {
    success: boolean;
    actor_session: number;
    error?: string;
  };
}

/**
 * Hub 通知 Edge 文本消息广播
 */
export interface HubTextMessageBroadcastNotification {
  method: 'hub.textMessageBroadcast';
  params: {
    actor: number;
    session?: number[];
    channel_id?: number[];
    tree_id?: number[];
    message: string;
  };
}

/**
 * Hub 通知 Edge 文本消息被拒绝
 */
export interface HubTextMessageDeniedNotification {
  method: 'hub.textMessageDenied';
  params: {
    actor_session: number;
    reason: string;
  };
}

/**
 * Hub 通知 Edge 权限被拒绝
 */
export interface HubPermissionDeniedNotification {
  method: 'hub.permissionDenied';
  params: {
    actor_session: number;
    permission: number;
    channel_id: number;
    reason: string;
  };
}

/**
 * Hub 通知 Edge 插件数据广播
 */
export interface HubPluginDataBroadcastNotification {
  method: 'hub.pluginDataBroadcast';
  params: {
    sender_session: number;
    dataID: string;
    data: Buffer;
  };
}

/**
 * Hub 通知 Edge 用户统计响应
 */
export interface HubUserStatsResponseNotification {
  method: 'hub.userStatsResponse';
  params: {
    success: boolean;
    actor_session: number;
    error?: string;
    // The actual UserStats data to send back to the client
    userStats?: {
      session: number;
      onlinesecs?: number;
      idlesecs?: number;
      stats_only?: boolean;
      strong_certificate?: boolean;
      address?: string;
      version?: {
        major?: number;
        minor?: number;
        patch?: number;
      };
      certificates?: Buffer[];
      from_client?: {
        good?: number;
        late?: number;
        lost?: number;
        resync?: number;
      };
      from_server?: {
        good?: number;
        late?: number;
        lost?: number;
        resync?: number;
      };
      udp_packets?: number;
      tcp_packets?: number;
      udp_ping_avg?: number;
      udp_ping_var?: number;
      tcp_ping_avg?: number;
      tcp_ping_var?: number;
    };
  };
}

/**
 * Hub 通知 Edge 用户加入
 */
export interface HubUserJoinedNotification {
  method: 'hub.userJoined';
  params: {
    session_id: number;
    edge_id: number;
    user_id: number;
    username: string;
    channel_id: number;
    cert_hash?: string;
    target_sessions?: number[]; // Optional: for ninja channel filtering
  };
}

/**
 * Hub 通知 Edge 可见用户列表（用于 Channel Ninja）
 */
export interface HubVisibleUsersNotification {
  method: 'hub.visibleUsers';
  params: {
    new_session_id: number;
    visible_sessions: number[];
  };
}

/**
 * Hub 通知 Edge 用户状态变更（通用）
 */
export interface HubUserStateChangedNotification {
  method: 'hub.userStateChanged';
  params: {
    session_id: number;
    changes: Record<string, unknown>;
  };
}

/**
 * Hub 通知 Edge 用户离开
 */
export interface HubUserLeftNotification {
  method: 'hub.userLeft';
  params: {
    session_id: number;
    reason?: string;
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
  | EdgeAuthenticateUserMethod
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
  | EdgeHandlePermissionQueryMethod
  | EdgeJoinMethod
  | EdgeJoinCompleteMethod
  | EdgeReportPeerDisconnectMethod
  | EdgeReportQualityMethod
  | ClusterGetStatusMethod
  | BlobPutMethod
  | BlobGetMethod
  | BlobGetUserTextureMethod
  | BlobGetUserCommentMethod
  | BlobSetUserTextureMethod
  | BlobSetUserCommentMethod;

/**
 * 所有 Edge -> Hub 的通知方法（不需要响应）
 */
export type EdgeToHubNotifications =
  | EdgeUserStateNotification
  | EdgeUserLeftNotification
  | EdgeChannelStateNotification
  | EdgeChannelRemoveNotification
  | EdgeUserRemoveNotification
  | EdgeTextMessageNotification
  | EdgePluginDataTransmissionNotification
  | EdgeUserStatsNotification;

/**
 * 所有 Hub -> Edge 的通知方法
 */
export type HubToEdgeNotifications =
  | HubVoiceDataNotification
  | HubForceDisconnectNotification
  | HubPeerJoinedNotification
  | HubACLResponseNotification
  | HubUserStateBroadcastNotification
  | HubUserStateResponseNotification
  | HubChannelStateBroadcastNotification
  | HubChannelStateResponseNotification
  | HubUserRemoveBroadcastNotification
  | HubUserRemoveResponseNotification
  | HubChannelRemoveBroadcastNotification
  | HubChannelRemoveResponseNotification
  | HubTextMessageBroadcastNotification
  | HubTextMessageDeniedNotification
  | HubPermissionDeniedNotification
  | HubPluginDataBroadcastNotification
  | HubUserStatsResponseNotification
  | HubUserJoinedNotification
  | HubVisibleUsersNotification
  | HubUserStateChangedNotification
  | HubUserLeftNotification;

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
 * 通知方法名到类型的映射 (Hub -> Edge)
 */
export type HubToEdgeNotificationMethodMap = {
  [K in HubToEdgeNotifications as K['method']]: K;
};

/**
 * 通知方法名到类型的映射 (Edge -> Hub)
 */
export type EdgeToHubNotificationMethodMap = {
  [K in EdgeToHubNotifications as K['method']]: K;
};

/**
 * 根据通知方法名获取参数类型 (Hub -> Edge)
 */
export type HubNotificationParams<M extends HubToEdgeNotifications['method']> =
  HubToEdgeNotificationMethodMap[M]['params'];

/**
 * 根据通知方法名获取参数类型 (Edge -> Hub)
 */
export type EdgeNotificationParams<M extends EdgeToHubNotifications['method']> =
  EdgeToHubNotificationMethodMap[M]['params'];

// Deprecated: 保持向后兼容
export type NotificationMethodMap = HubToEdgeNotificationMethodMap;
export type NotificationParams<M extends HubToEdgeNotifications['method']> =
  HubNotificationParams<M>;
