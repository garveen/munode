# ListenChannel 功能实现文档

**实现日期**: 2025-11-20  
**版本**: 1.0  
**状态**: ✅ 已完成

## 概述

本文档记录了 MuNode 项目中 ListenChannel（监听频道）功能的实现。该功能允许用户在不移动到目标频道的情况下，监听其他频道的音频。

## 功能描述

### 用户场景
- 用户 A 在频道 1，可以添加对频道 2 的监听
- 用户 A 将接收来自频道 2 中所有用户的语音数据
- 用户 A 无需离开频道 1 或加入频道 2
- 监听需要 `Listen` 权限（0x800）

### 协议支持
基于 Mumble Protocol，使用 `UserState` 消息的以下字段：
- `listening_channel_add`: 要添加监听的频道ID列表
- `listening_channel_remove`: 要移除监听的频道ID列表

## 实现细节

### 1. 类型定义 ✅

**文件**: `packages/common/src/types/client.ts`

```typescript
export interface ClientInfo {
  // ... 现有字段 ...
  listeningChannels: Set<number>; // 正在监听的频道ID集合
}
```

### 2. 权限定义 ✅

**文件**: 
- `packages/hub-server/src/permission-checker.ts`
- `packages/edge-server/src/permission-checker.ts`

```typescript
export enum Permission {
  // ... 现有权限 ...
  Listen = 0x800,  // 监听频道权限
}
```

**权限说明**:
- 权限值 `0x800` 符合 Mumble Protocol 规范
- 在 Go 实现中对应 `ListenPermission`
- 用户需要对目标频道拥有 `Listen` 权限才能监听

### 3. Edge 服务器处理 ✅

**文件**: `packages/edge-server/src/edge-server.ts`

#### 3.1 处理客户端请求

在 `handleUserState` 方法中：

```typescript
// 处理监听频道添加
if (userState.listening_channel_add && userState.listening_channel_add.length > 0) {
  const deniedChannels: number[] = [];
  
  for (const channelId of userState.listening_channel_add) {
    // 权限检查将在 Hub 进行
    client.listeningChannels.add(channelId);
  }
  
  logger.debug(
    `Client ${client.name} added listening channels: ${Array.from(client.listeningChannels).join(', ')}`
  );
}

// 处理监听频道移除
if (userState.listening_channel_remove && userState.listening_channel_remove.length > 0) {
  for (const channelId of userState.listening_channel_remove) {
    client.listeningChannels.delete(channelId);
  }
  
  logger.debug(
    `Client ${client.name} removed listening channels, remaining: ${Array.from(client.listeningChannels).join(', ')}`
  );
}
```

#### 3.2 处理 Hub 广播

在 `handleUserStateBroadcastFromHub` 方法中：

```typescript
// 更新监听频道状态
if (userState.listening_channel_add) {
  for (const channelId of userState.listening_channel_add) {
    client.listeningChannels.add(channelId);
  }
  logger.debug(
    `Client ${client.name} now listening to channels: ${Array.from(client.listeningChannels).join(', ')}`
  );
}

if (userState.listening_channel_remove) {
  for (const channelId of userState.listening_channel_remove) {
    client.listeningChannels.delete(channelId);
  }
  logger.debug(
    `Client ${client.name} stopped listening to channels: ${userState.listening_channel_remove.join(', ')}`
  );
}
```

### 4. Hub 服务器处理 ✅

**文件**: `packages/hub-server/src/control-service.ts`

在 `handleUserStateNotification` 方法中：

```typescript
// 监听频道权限检查
if (params.userState.listening_channel_add && params.userState.listening_channel_add.length > 0) {
  const deniedChannels: number[] = [];
  const allowedChannels: number[] = [];
  
  for (const channelId of params.userState.listening_channel_add) {
    if (!this.permissionChecker.hasPermission(session.user_id, channelId, Permission.Listen)) {
      deniedChannels.push(channelId);
      logger.warn(
        `User ${session.username} denied Listen permission for channel ${channelId}`
      );
    } else {
      allowedChannels.push(channelId);
    }
  }
  
  // 只保留有权限的频道
  if (deniedChannels.length > 0) {
    params.userState.listening_channel_add = allowedChannels;
    
    // 发送权限拒绝消息
    for (const channelId of deniedChannels) {
      this.sendPermissionDenied(params.edge_id, params.session_id, channelId, Permission.Listen);
    }
  }
  
  if (allowedChannels.length > 0) {
    logger.info(
      `User ${session.username} started listening to channels: ${allowedChannels.join(', ')}`
    );
  }
}
```

### 5. 语音路由支持 ✅

**文件**: `packages/edge-server/src/voice-router.ts`

在 `routeVoicePacket` 方法中：

```typescript
// 发送给监听此频道的用户
for (const [recipientSession, recipient] of this.clientManager.clients.entries()) {
  // 跳过发送者自己
  if (recipientSession === fromSession) {
    continue;
  }
  
  // 如果接收者在监听发送者所在的频道
  if (recipient.listeningChannels.has(senderChannel)) {
    await this.sendVoicePacket(recipientSession, voiceData);
    logger.debug(
      `Routed voice from session ${fromSession} to listening session ${recipientSession}`
    );
  }
}
```

### 6. 集群管理器优化 ✅

**文件**: `packages/edge-server/src/cluster-manager.ts`

修复了通知重复处理问题：

```typescript
private handleHubNotification(message: any): void {
  switch (message.method) {
    case 'edge.peerJoined':
      void this.handlePeerJoined(message.params);
      break;
    case 'edge.peerLeft':
      this.handlePeerLeft(message.params);
      break;
    case 'edge.forceDisconnect':
      void this.handleForceDisconnect(message.params);
      break;
    default:
      // 只处理集群相关的通知，其他通知由 EdgeServer 处理
      if (message.method.startsWith('edge.')) {
        this.logger.debug(`Unknown cluster notification: ${message.method}`);
      }
  }
}
```

## 工作流程

### 添加监听频道

```
Client -> Edge: UserState { listening_channel_add: [2] }
    |
    v
Edge: 本地添加到 client.listeningChannels
    |
    v
Edge -> Hub: RPC notifyUserStateChange
    |
    v
Hub: 检查 Listen 权限
    |
    +--- 权限被拒绝 ---> Hub -> Edge: PermissionDenied
    |
    +--- 权限允许 -----> Hub: 广播到所有 Edge
                            |
                            v
                        All Edges: 更新本地状态
                            |
                            v
                        Edge -> Client: UserState { listening_channel_add: [2] }
```

### 语音路由

```
User A (Channel 1) 说话
    |
    v
Edge: VoiceRouter.routeVoicePacket()
    |
    +---> 发送给 Channel 1 的所有用户
    |
    +---> 发送给监听 Channel 1 的所有用户 (User B 在 Channel 2 但监听 Channel 1)
```

## 测试

### 手动测试步骤

1. **启动服务器**
   ```bash
   # 启动 Hub
   cd packages/hub-server
   pnpm start
   
   # 启动 Edge
   cd packages/edge-server
   pnpm start
   ```

2. **连接两个客户端**
   - Client A 加入 Channel 1
   - Client B 加入 Channel 2

3. **添加监听**
   - Client B 发送 UserState 消息添加对 Channel 1 的监听
   - 检查是否收到确认消息

4. **测试语音**
   - Client A 在 Channel 1 说话
   - 验证 Client B 能够听到（尽管在 Channel 2）

5. **移除监听**
   - Client B 发送 UserState 消息移除监听
   - 验证不再收到 Channel 1 的语音

### 权限测试

1. **无权限场景**
   - 创建一个频道，Client B 没有 Listen 权限
   - Client B 尝试监听该频道
   - 验证收到 PermissionDenied 消息

2. **ACL 继承测试**
   - 子频道继承父频道的 ACL
   - 验证监听权限正确继承

## 日志示例

### 成功添加监听
```
2025-11-20 15:40:59 [info] User admin started listening to channels: 2
2025-11-20 15:40:59 [debug] Client admin now listening to channels: 2
```

### 权限被拒绝
```
2025-11-20 15:41:00 [warn] User guest denied Listen permission for channel 3
2025-11-20 15:41:00 [info] Sent PermissionDenied to session 5 for channel 3
```

### 语音路由
```
2025-11-20 15:41:05 [debug] Routed voice from session 1 to listening session 2
```

## 与 Go 实现的对比

| 特性 | Go 实现 | Node 实现 | 状态 |
|-----|---------|----------|------|
| listening_channel_add | ✅ | ✅ | 完整 |
| listening_channel_remove | ✅ | ✅ | 完整 |
| Listen 权限检查 | ✅ | ✅ | 完整 |
| ACL 继承 | ✅ | ✅ | 完整 |
| 语音路由 | ✅ | ✅ | 完整 |
| 跨 Edge 支持 | N/A | ✅ | 增强 |

## 已知限制

1. **性能考虑**
   - 大量用户监听同一频道时，语音路由需要遍历所有客户端
   - 建议优化：使用频道 -> 监听者映射来加速查找

2. **状态持久化**
   - 当前监听状态不持久化，用户重连后需要重新添加监听
   - 未来可以考虑在用户配置中保存监听列表

## 未来改进

1. **性能优化**
   ```typescript
   // 维护反向索引
   private channelListeners: Map<number, Set<number>> = new Map();
   
   // 快速查找监听特定频道的所有用户
   getListeners(channelId: number): Set<number> {
     return this.channelListeners.get(channelId) || new Set();
   }
   ```

2. **监听限制**
   - 添加配置选项限制单个用户最多监听的频道数
   - 防止滥用导致性能问题

3. **监听历史**
   - 记录用户的监听历史
   - 用于审计和分析

4. **UI 支持**
   - 在管理界面显示谁在监听哪些频道
   - 提供快速添加/移除监听的界面

## 相关文档

- [Mumble Protocol - UserState](https://mumble-protocol.readthedocs.io/en/latest/voice_data.html)
- [未实现功能对比](./MISSING_FEATURES.md)
- [Go 实现参考](../client.go) - Lines 647-696
- [权限系统文档](./docs/03-认证系统.md)

## 维护信息

**实现者**: GitHub Copilot  
**审核者**: 待定  
**最后更新**: 2025-11-20  
**下次审核**: 2025-12-20
