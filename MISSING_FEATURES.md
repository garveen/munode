# MuNode 未实现功能对比分析

**生成时间**: 2025-11-20  
**基准**: Mumble.proto + Go实现 (shitspeak.go)

## 概述

本文档详细列出了 Node.js 实现相对于 Mumble Protocol 和 Go 参考实现尚未完成的功能。这些功能按优先级分类，并提供了实现建议。

---

## 一、已实现的核心功能 ✅

### 1.1 基础协议消息
- ✅ Version
- ✅ Authenticate
- ✅ Ping
- ✅ Reject
- ✅ ServerSync
- ✅ ServerConfig
- ✅ ChannelState
- ✅ ChannelRemove
- ✅ UserState
- ✅ UserRemove
- ✅ BanList
- ✅ TextMessage
- ✅ PermissionDenied
- ✅ ACL
- ✅ QueryUsers
- ✅ CryptSetup
- ✅ ContextAction
- ✅ ContextActionModify
- ✅ VoiceTarget
- ✅ PermissionQuery
- ✅ UserStats
- ✅ RequestBlob (部分)
- ✅ UserList (部分)
- ✅ SuggestConfig
- ✅ CodecVersion (基础)

### 1.2 核心系统
- ✅ 用户认证
- ✅ 频道管理
- ✅ ACL 权限系统
- ✅ ACL 继承机制
- ✅ 加密系统 (OCB2-AES128)
- ✅ 语音路由 (基础)
- ✅ Hub-Edge 分布式架构
- ✅ 类型安全的 RPC 通信
- ✅ UDP 和 TCP 传输
- ✅ TLS 连接

---

## 二、未实现的功能（按优先级）

### 2.1 高优先级（影响核心功能）

#### 2.1.1 PluginDataTransmission 消息处理 ❌
**状态**: 完全未实现  
**协议定义**: Mumble.proto:1658-1669  
**Go实现**: 无专门的处理函数（可能是因为较新的协议特性）

**用途**: 在客户端之间传输插件数据，用于位置音频、游戏集成等插件功能

**实现需求**:
```typescript
// packages/edge-server/src/edge-server.ts
private async handlePluginDataTransmission(session_id: number, data: Buffer): Promise<void> {
  const plugin = mumbleproto.PluginDataTransmission.deserialize(data);
  
  // 验证发送者
  if (plugin.senderSession !== session_id) {
    logger.warn(`Plugin data sender mismatch: claimed=${plugin.senderSession}, actual=${session_id}`);
    return;
  }
  
  // 转发到指定接收者
  if (plugin.receiverSessions && plugin.receiverSessions.length > 0) {
    for (const targetSession of plugin.receiverSessions) {
      const targetClient = this.clientManager.getClient(targetSession);
      if (targetClient) {
        this.messageHandler.sendMessage(
          targetSession, 
          MessageType.PluginDataTransmission, 
          data
        );
      }
    }
  }
}
```

**复杂度**: 低  
**影响**: 插件功能（位置音频、游戏覆盖等）完全无法工作

---

#### 2.1.2 用户列表管理（UserList）完整实现 ⏳
**状态**: 仅实现查询权限检查，未实现实际功能  
**协议定义**: Mumble.proto:1585-1594  
**Go实现**: message.go:1612-1676

**缺失功能**:
1. **查询注册用户列表**: 返回所有注册用户
2. **用户重命名**: 修改注册用户的用户名
3. **用户注销**: 删除用户注册

**实现需求**:
```typescript
// packages/hub-server/src/user-manager.ts
class UserManager {
  async listRegisteredUsers(): Promise<Array<{
    user_id: number;
    name: string;
    last_seen?: string;
    last_channel?: number;
  }>>;
  
  async renameUser(user_id: number, newName: string): Promise<void>;
  
  async unregisterUser(user_id: number): Promise<void>;
}

// packages/edge-server/src/edge-server.ts
private async handleUserList(session_id: number, data: Buffer): Promise<void> {
  const userlist = mumbleproto.UserList.deserialize(data);
  
  // 权限检查 (已实现)
  if (!this.hasPermission(session_id, rootChannelId, 'Register')) {
    return;
  }
  
  if (userlist.users.length === 0) {
    // 查询模式
    const users = await this.hubClient.rpc.getUserList();
    // 返回用户列表
  } else {
    // 修改模式: 重命名或注销
    for (const user of userlist.users) {
      if (user.name) {
        await this.hubClient.rpc.renameUser(user.user_id, user.name);
      } else {
        await this.hubClient.rpc.unregisterUser(user.user_id);
      }
    }
  }
}
```

**复杂度**: 中  
**影响**: 无法管理注册用户（查询、重命名、注销）

---

#### 2.1.3 Blob 存储系统完整实现 ⏳
**状态**: 仅实现频道描述请求  
**协议定义**: Mumble.proto:1531-1537  
**Go实现**: message.go:1528-1610 (大部分已注释掉)

**缺失功能**:
1. **用户纹理 (Texture)**: 用户头像/图片
2. **用户评论 (Comment)**: 用户个人资料评论
3. **频道描述 (Description)**: 大于128字节的频道描述

**当前状态**:
- ✅ 频道描述请求 (channelDescription) - 已实现
- ❌ 用户纹理请求 (sessionTexture) - 标记为 TODO
- ❌ 用户评论请求 (sessionComment) - 标记为 TODO

**实现需求**:
```typescript
// packages/common/src/blob-store.ts
class BlobStore {
  async put(data: Buffer): Promise<string>; // 返回 hash
  async get(hash: string): Promise<Buffer>;
  async exists(hash: string): Promise<boolean>;
}

// packages/hub-server/src/user-manager.ts
interface User {
  textureBlob?: string; // SHA1 hash
  commentBlob?: string; // SHA1 hash
}

// packages/edge-server/src/edge-server.ts
private async handleRequestBlob(session_id: number, data: Buffer): Promise<void> {
  const blobreq = mumbleproto.RequestBlob.deserialize(data);
  
  // 用户纹理
  if (blobreq.sessionTexture) {
    for (const targetSession of blobreq.sessionTexture) {
      const user = await this.hubClient.rpc.getUser(targetSession);
      if (user.textureBlob) {
        const texture = await this.blobStore.get(user.textureBlob);
        this.sendUserState(session_id, { 
          session: targetSession, 
          texture 
        });
      }
    }
  }
  
  // 用户评论
  if (blobreq.sessionComment) {
    for (const targetSession of blobreq.sessionComment) {
      const user = await this.hubClient.rpc.getUser(targetSession);
      if (user.commentBlob) {
        const comment = await this.blobStore.get(user.commentBlob);
        this.sendUserState(session_id, { 
          session: targetSession, 
          comment: comment.toString('utf-8')
        });
      }
    }
  }
}
```

**复杂度**: 中  
**影响**: 无法显示用户头像、个人资料、大型频道描述

---

#### 2.1.4 PreConnectUserState 处理 ✅
**状态**: 已实现  
**协议定义**: UserState 消息（在认证前发送）  
**Go实现**: message.go:583-618

**用途**: 允许客户端在认证完成前设置自己的初始状态（自我静音/自我耳聋等）

**实现位置**:
- `packages/edge-server/src/edge-server.ts` - handleUserState 方法
- `packages/edge-server/src/edge-server.ts` - handleAuthSuccess 方法

**实现说明**:
```typescript
// 在 handleUserState 中保存 PreConnect 状态
if (!actor.user_id || actor.user_id <= 0) {
  const preState = {
    self_mute: userState.self_mute,
    self_deaf: userState.self_deaf,
    plugin_context: userState.plugin_context,
    plugin_identity: userState.plugin_identity,
    comment: userState.comment,
  };
  this.preConnectUserState.set(session_id, preState);
}

// 在 handleAuthSuccess 中应用 PreConnect 状态
const preState = this.preConnectUserState.get(session_id);
if (preState) {
  this.clientManager.updateClient(session_id, preState);
  this.preConnectUserState.delete(session_id);
}
```

**测试文件**: `test-preconnect-permission-refresh.js`

**复杂度**: 低  
**影响**: 客户端连接时可以保持自定义的初始状态，改善用户体验

---

### 2.2 中优先级（增强功能）

#### 2.2.1 ListenChannel 功能 ❌
**状态**: 完全未实现  
**协议定义**: UserState.listening_channel_add/remove  
**Go实现**: message.go:929-955, client.go:647-696

**用途**: 允许用户监听其他频道的音频（不移动到该频道）

**实现需求**:
```typescript
// packages/common/src/types/client.ts
interface ClientInfo {
  // ... 现有字段 ...
  listeningChannels: Set<number>; // 正在监听的频道ID
}

// packages/edge-server/src/edge-server.ts
private async handleUserState(session_id: number, data: Buffer): Promise<void> {
  const userState = mumbleproto.UserState.deserialize(data);
  const client = this.clientManager.getClient(session_id);
  
  // 添加监听频道
  if (userState.listening_channel_add) {
    for (const channelId of userState.listening_channel_add) {
      // 检查 Listen 权限
      if (await this.checkPermission(session_id, channelId, 'Listen')) {
        client.listeningChannels.add(channelId);
      } else {
        this.sendPermissionDenied(session_id, channelId, 'Listen');
      }
    }
  }
  
  // 移除监听频道
  if (userState.listening_channel_remove) {
    for (const channelId of userState.listening_channel_remove) {
      client.listeningChannels.delete(channelId);
    }
  }
  
  // 广播状态变更
  await this.hubClient.rpc.notifyUserStateChange({
    session_id,
    listening_channel_add: userState.listening_channel_add,
    listening_channel_remove: userState.listening_channel_remove,
  });
}

// packages/edge-server/src/voice-router.ts
class VoiceRouter {
  routeVoice(fromSession: number, voiceData: Buffer, target: number): void {
    // ... 现有路由逻辑 ...
    
    // 添加监听者
    const sourceClient = this.clientManager.getClient(fromSession);
    const sourceChannel = sourceClient.channel_id;
    
    for (const [session, client] of this.clientManager.getAllClients()) {
      if (client.listeningChannels.has(sourceChannel)) {
        // 发送给监听此频道的用户
        this.sendVoicePacket(session, voiceData);
      }
    }
  }
}
```

**复杂度**: 中  
**影响**: 无法使用"监听频道"功能（重要的高级功能）

---

#### 2.2.2 临时访问令牌 (Temporary Access Tokens) ❌
**状态**: 完全未实现  
**协议定义**: UserState.temporary_access_tokens  
**Go实现**: 在 ACL 检查中使用

**用途**: 允许用户在移动频道等操作时临时获得额外权限

**实现需求**:
```typescript
// packages/common/src/types/client.ts
interface ClientInfo {
  // ... 现有字段 ...
  temporaryTokens: string[]; // 临时访问令牌
}

// packages/hub-server/src/acl-manager.ts
class ACLManager {
  checkPermission(
    userId: number, 
    channelId: number, 
    permission: string,
    temporaryTokens: string[] = []
  ): boolean {
    // ... 现有权限检查 ...
    
    // 检查临时令牌
    const channel = this.getChannel(channelId);
    for (const token of temporaryTokens) {
      if (channel.groups.some(g => g.name === token)) {
        // 临时令牌匹配组名，授予该组的权限
        return true;
      }
    }
    
    return false;
  }
}

// packages/edge-server/src/edge-server.ts
private async handleUserState(session_id: number, data: Buffer): Promise<void> {
  const userState = mumbleproto.UserState.deserialize(data);
  
  if (userState.temporary_access_tokens) {
    const client = this.clientManager.getClient(session_id);
    client.temporaryTokens = userState.temporary_access_tokens;
    
    // 在权限检查时传递这些令牌
  }
}
```

**复杂度**: 中  
**影响**: 无法使用临时权限功能（如临时访客通行证）

---

#### 2.2.3 CodecVersion 动态协商 ⏳
**状态**: 部分实现（固定配置）  
**协议定义**: Mumble.proto:1520-1528  
**Go实现**: server.go:977-1064

**缺失功能**:
1. 根据所有客户端支持自动选择编解码器
2. Opus 阈值检查和广播
3. 动态切换编解码器

**实现需求**:
```typescript
// packages/edge-server/src/codec-manager.ts
class CodecManager {
  private clientCodecs: Map<number, {
    celtVersions: number[];
    opus: boolean;
  }> = new Map();
  
  updateClientCodec(session_id: number, celtVersions: number[], opus: boolean): void {
    this.clientCodecs.set(session_id, { celtVersions, opus });
    this.recalculateBestCodec();
  }
  
  private recalculateBestCodec(): void {
    let opusCount = 0;
    let totalClients = 0;
    const celtAlpha = new Set<number>();
    const celtBeta = new Set<number>();
    
    for (const [, codec] of this.clientCodecs) {
      totalClients++;
      if (codec.opus) opusCount++;
      
      for (const version of codec.celtVersions) {
        if (version === CELT_ALPHA_VERSION) celtAlpha.add(version);
        if (version === CELT_BETA_VERSION) celtBeta.add(version);
      }
    }
    
    // 如果超过阈值的客户端支持 Opus，则使用 Opus
    const useOpus = opusCount >= totalClients * this.config.opusThreshold;
    
    // 广播新的编解码器版本
    this.broadcastCodecVersion({
      alpha: celtAlpha.size > 0 ? CELT_ALPHA_VERSION : 0,
      beta: celtBeta.size > 0 ? CELT_BETA_VERSION : 0,
      prefer_alpha: true,
      opus: useOpus,
    });
  }
}
```

**复杂度**: 中  
**影响**: 无法根据客户端能力优化音频质量

---

#### 2.2.4 统计数据完整实现 ⏳
**状态**: 部分实现（缺少实际计数器）  
**协议定义**: UserStats, Ping  
**Go实现**: message.go:1344-1450, client.go (各处)

**缺失功能**:
1. **加密统计**: good/late/lost/resync 实际计数
2. **UDP/TCP 数据包统计**: 实际数据包计数器
3. **证书验证链**: 完整证书和 StrongCertificate 标志
4. **带宽统计**: 实时带宽使用情况

**实现需求**:
```typescript
// packages/protocol/src/voice/voice-crypto.ts
class OCB2AES128 {
  private stats = {
    good: 0,
    late: 0,
    lost: 0,
    resync: 0,
  };
  
  decrypt(data: Buffer): Buffer | null {
    // ... 解密逻辑 ...
    
    if (decryptSuccess) {
      this.stats.good++;
    } else if (sequenceTooOld) {
      this.stats.late++;
    } else if (sequenceMissing) {
      this.stats.lost++;
    }
    
    return decrypted;
  }
  
  resync(): void {
    this.stats.resync++;
  }
  
  getStats() {
    return { ...this.stats };
  }
}

// packages/edge-server/src/edge-server.ts
private async handleUserStats(session_id: number, data: Buffer): Promise<void> {
  // ... 现有代码 ...
  
  if (local) {
    // 从加密器获取实际统计
    const cryptStats = this.voiceRouter.getCryptStats(targetSession);
    
    userStats.from_client = {
      good: cryptStats.good,
      late: cryptStats.late,
      lost: cryptStats.lost,
      resync: cryptStats.resync,
    };
    
    // 网络统计
    userStats.udp_packets = client.udpPacketCount;
    userStats.tcp_packets = client.tcpPacketCount;
    // ...
  }
}
```

**复杂度**: 中  
**影响**: 无法准确诊断网络问题、音频质量问题

---

### 2.3 低优先级（边缘功能）

#### 2.3.1 GeoIP 支持 ❌
**状态**: Go 实现中存在但未使用  
**Go实现**: geoip.go

**用途**: 显示用户地理位置信息

**复杂度**: 低  
**影响**: 无法显示用户国家/地区

---

#### 2.3.2 版本兼容性处理 ⏳
**状态**: 部分实现  
**Go实现**: 多处版本检查

**缺失功能**:
1. Recording 状态变更对旧版客户端的 TextMessage 通知
2. Blob hash vs 完整内容的版本检测
3. 不同版本客户端的消息格式适配

**影响**: 旧版客户端可能无法正确显示某些信息

---

#### 2.3.3 频道权限动态刷新 ✅
**状态**: 已实现  
**Go实现**: server.go:1774-1793

**用途**: ACL 变更后自动更新 suppress 状态

**实现位置**:
- `packages/edge-server/src/edge-server.ts` - refreshChannelPermissions 方法
- `packages/hub-server/src/control-service.ts` - handleACLRequest 方法（ACL 更新后广播）
- `packages/edge-server/src/edge-server.ts` - handleACLUpdatedNotification 方法

**实现说明**:
```typescript
// Hub: ACL 更新后广播通知
await this._aclManager.saveACLs(channel_id, aclData);
this.broadcast('edge.aclUpdated', {
  channel_id,
  timestamp: Date.now(),
});

// Edge: 收到通知后刷新权限
private handleACLUpdatedNotification(params) {
  void this.refreshChannelPermissions(params.channel_id);
}

// Edge: 重新计算频道内所有用户的 suppress 状态
private async refreshChannelPermissions(channel_id: number) {
  const clientsInChannel = this.clientManager.getClientsInChannel(channel_id);
  for (const client of clientsInChannel) {
    const hasSpeak = await this.checkPermission(client.session, channel_id, Permission.Speak);
    const newSuppress = !hasSpeak && !client.self_mute;
    if (client.suppress !== newSuppress) {
      // 更新并广播状态变更
    }
  }
}
```

**测试文件**: `test-preconnect-permission-refresh.js`

**影响**: ACL 变更后立即生效，无需用户重新进入频道

---

#### 2.3.4 最后活跃时间跟踪 ⏳
**状态**: 部分实现  
**Go实现**: 语音包处理时更新

**影响**: 无法准确显示用户最后活跃时间

---

## 三、架构差异

### 3.1 分布式架构特有挑战

Node 实现采用 Hub-Edge 分布式架构，与 Go 的单体架构不同。某些功能需要考虑跨节点同步：

#### 3.1.1 跨 Edge 的 PluginDataTransmission
**问题**: 发送者和接收者可能在不同的 Edge 节点

**解决方案**:
```typescript
// Hub 需要转发插件数据
async handlePluginDataFromEdge(params: {
  senderSession: number;
  receiverSessions: number[];
  data: Buffer;
  dataID: string;
}): Promise<void> {
  // 查找接收者所在的 Edge
  for (const receiverSession of params.receiverSessions) {
    const edge_id = this.sessionManager.getEdgeBySession(receiverSession);
    if (edge_id) {
      await this.notify(edge_id, 'plugin.forward', params);
    }
  }
}
```

#### 3.1.2 跨 Edge 的 ListenChannel
**问题**: 监听的频道可能在不同的 Edge 节点上有用户

**解决方案**: Hub 需要维护监听关系，并在语音路由时考虑跨 Edge 转发

---

## 四、实现路线图建议

### Phase 1: 核心功能完善（1-2周）
1. ✅ **PreConnectUserState** - 已完成
2. ✅ **频道权限动态刷新** - 已完成
3. ✅ **PluginDataTransmission** - 1天（待实现）
4. ✅ **UserList 完整实现** - 2天（待实现）
5. ✅ **Blob 存储系统** - 3-5天（待实现）

### Phase 2: 增强功能（2-3周）
1. **ListenChannel** - 3-5天
2. **临时访问令牌** - 2-3天
3. **CodecVersion 动态协商** - 2天
4. **统计数据完整实现** - 3天

### Phase 3: 优化与边缘功能（1-2周）
1. **版本兼容性处理** - 2-3天
2. **频道权限动态刷新** - 1天
3. **GeoIP 支持** - 1天
4. **性能优化和测试** - 持续

---

## 五、测试建议

### 5.1 功能测试
- 使用官方 Mumble 客户端测试所有消息类型
- 测试 Hub-Edge 跨节点场景
- 测试权限边界情况

### 5.2 兼容性测试
- 测试不同版本的 Mumble 客户端
- 测试不同平台（Windows、Linux、macOS、移动端）

### 5.3 压力测试
- 大量并发连接
- 高频语音包传输
- 跨 Edge 路由性能

---

## 六、总结

### 6.1 完成度评估
- **基础协议**: ~85% 完成
- **核心功能**: ~80% 完成
- **高级功能**: ~50% 完成
- **边缘功能**: ~30% 完成

### 6.2 关键缺失
1. **PluginDataTransmission** - 阻碍插件功能（待实现）
2. **Blob 存储** - 阻碍用户头像和大型内容（待实现）
3. **ListenChannel** - 阻碍监听功能（待实现）
4. **统计系统** - 阻碍诊断和监控（部分实现）

### 6.3 优先行动
1. ✅ 已实现 **PreConnectUserState** 和 **频道权限动态刷新**（低复杂度，高影响）
2. 立即实现 **PluginDataTransmission**（低复杂度，高影响）
3. 规划 **Blob 存储系统**（中复杂度，高影响）
4. 逐步添加增强功能（**ListenChannel**, **临时令牌**等）

### 6.4 长期目标
- 完整实现 Mumble Protocol 所有消息类型
- 达到与 Go 实现的功能对等
- 利用分布式架构优势提供更好的扩展性
- 添加 Go 实现中没有的现代化功能（监控、管理 API 等）

---

**文档版本**: 1.0  
**维护者**: GitHub Copilot  
**最后更新**: 2025-11-20
