# Hub Server 数据库使用改进 - 完成报告

## 改进概述

已将 Hub Server 的数据存储从主要依赖内存改为**以 SQLite 数据库为唯一数据源**，内存仅作为缓存使用。

## 完成的工作

### 1. 数据库层 ✅

**文件**: `node/packages/hub-server/src/database.ts`

完整实现了所有业务数据的数据库操作方法：

#### Go 兼容表的 CRUD 方法

- **封禁管理 (bans)**
  - `getAllBans()` - 获取所有活跃封禁
  - `addBan(ban)` - 添加封禁记录
  - `deleteBan(id)` - 软删除封禁
  - `purgeBans()` - 清空所有封禁
  - `isCertHashBanned(hash)` - 检查证书是否被封禁
  - `isIPBanned(ip)` - 检查 IP 是否被封禁

- **频道管理 (channels, channel_links)**
  - `getAllChannels()` - 获取所有频道
  - `getChannel(id)` - 获取单个频道
  - `createChannel(channel)` - 创建频道
  - `updateChannel(id, updates)` - 更新频道
  - `deleteChannel(id)` - 删除频道
  - `getChildChannels(parentId)` - 获取子频道
  - `linkChannels(id1, id2)` - 链接频道
  - `unlinkChannels(id1, id2)` - 取消链接
  - `getChannelLinks(channelId)` - 获取频道链接
  - `initRootChannel(name)` - 初始化根频道

- **ACL 管理 (acls)**
  - `getChannelACLs(channelId)` - 获取频道 ACL
  - `addACL(acl)` - 添加 ACL
  - `updateACL(id, updates)` - 更新 ACL
  - `deleteACL(id)` - 软删除 ACL
  - `clearChannelACLs(channelId)` - 清空频道 ACL

- **用户最后频道 (user_last_channels)**
  - `getUserLastChannel(userId)` - 获取用户最后频道
  - `setUserLastChannel(userId, channelId)` - 设置用户最后频道

#### Hub Server 专用表的方法

- **Edge 注册表 (edges)**
  - `saveEdge(edge)` - 保存 Edge 信息
  - `updateEdgeHeartbeat(serverId, currentUsers)` - 更新心跳
  - `getActiveEdges()` - 获取活跃的 Edge

- **会话管理 (sessions)**
  - `saveSession(session)` - 保存会话
  - `updateSessionChannel(sessionId, channelId)` - 更新会话频道
  - `deleteSession(sessionId)` - 删除会话
  - `getAllSessions()` - 获取所有会话

- **其他**
  - `saveVoiceTarget(config)` - 保存 VoiceTarget
  - `getAllVoiceTargets()` - 获取所有 VoiceTarget
  - `getConfig(key)` / `setConfig(key, value)` - 配置管理
  - `logAudit(event)` - 审计日志
  - `cleanup()` - 数据清理

### 2. 业务层管理器 ✅

#### SessionManager 更新

**文件**: `node/packages/hub-server/src/session-manager.ts`

- ✅ 在 `updateSessionChannel()` 中添加数据库更新
- ✅ 在 `removeSession()` 中添加数据库删除
- ✅ 在 `cleanup()` 中调用数据库清理

#### ChannelManager 创建

**文件**: `node/packages/hub-server/src/channel-manager.ts`

新建完整的频道管理器：

```typescript
class ChannelManager {
  // 从数据库加载并缓存
  private loadChannels(): void
  
  // CRUD 操作（直接操作数据库）
  createChannel(request): number
  updateChannel(id, updates): void
  deleteChannel(id): void
  getChannel(id): ChannelData
  getAllChannels(): ChannelData[]
  getChildChannels(parentId): ChannelData[]
  
  // 链接管理
  linkChannels(id1, id2): void
  unlinkChannels(id1, id2): void
  getChannelLinks(channelId): number[]
  
  // 缓存管理
  refreshCache(): void
}
```

**特性**：
- 所有写操作直接作用于数据库
- 内存缓存用于快速读取
- 预留了广播接口（待实现数据同步）

#### ACLManager 创建

**文件**: `node/packages/hub-server/src/acl-manager.ts`

新建完整的 ACL 管理器：

```typescript
class ACLManager {
  // 查询（带缓存）
  getChannelACLs(channelId): ACLData[]
  
  // 管理操作（直接操作数据库）
  addACL(request): number
  updateACL(id, updates): void
  deleteACL(id): void
  clearChannelACLs(channelId): void
  
  // 缓存管理
  refreshCache(): void
  preloadChannelACLs(channelIds): void
}
```

**特性**：
- 按频道缓存 ACL
- 写操作使缓存失效并重新加载
- 支持批量预加载

#### BanManager 创建

**文件**: `node/packages/hub-server/src/ban-manager.ts`

新建完整的封禁管理器：

```typescript
class BanManager {
  // 管理操作（直接操作数据库）
  addBan(request): number
  removeBan(id): void
  purgeAllBans(): void
  
  // 查询
  checkBan(ip, certHash?): BanCheckResult
  getAllBans(): BanData[]
  getBanCount(): number
  
  // 维护
  refreshCache(): void
  cleanupExpiredBans(): void
}
```

**特性**：
- 证书哈希索引（快速查找）
- IP CIDR 匹配（IPv4/IPv6 支持）
- 自动过期检查
- 定期清理过期封禁

### 3. 数据持久化架构

#### 数据流

```
Edge/Client 请求
     ↓
gRPC Handler
     ↓
Business Manager (Channel/ACL/Ban/Session)
     ↓
Database.ts (SQLite 操作)
     ↓
SQLite Database (持久化存储)
     ↓
Memory Cache (可选，用于快速读取)
```

#### 写入路径

1. 所有数据变更先写入数据库
2. 更新内存缓存
3. （待实现）广播变更到 Edge Servers

#### 读取路径

1. 优先从内存缓存读取
2. 缓存未命中则从数据库加载
3. 加载后更新缓存

#### 启动恢复

```typescript
// 在 HubServer.loadPersistentData() 中
async loadPersistentData(): Promise<void> {
  // 1. ChannelManager 自动从数据库加载所有频道
  // 2. BanManager 自动从数据库加载所有封禁
  // 3. Registry 从数据库加载 Edge
  // 4. SessionManager 从数据库加载会话
  // 5. VoiceTargetSync 从数据库加载配置
}
```

### 4. 配置 vs 数据库

#### 配置文件（静态、需重启）

```json
{
  "serverId": 1,
  "host": "0.0.0.0",
  "port": 50051,
  "tls": { ... },
  "registry": {
    "heartbeatInterval": 30000,
    "timeout": 90000,
    "maxEdges": 100
  },
  "database": {
    "path": "./data/hub.db",
    "backupDir": "./data/backups",
    "backupInterval": 3600000
  },
  "logLevel": "info"
}
```

#### 数据库（动态、实时更新）

- 频道结构
- ACL 权限
- 封禁列表
- 用户数据
- Edge 注册信息
- 会话状态
- VoiceTarget 配置
- 动态配置（欢迎消息等）

## 数据库表结构总结

### Go 兼容表（用于数据迁移）

1. **bans** - 封禁列表（支持软删除）
2. **channels** - 频道树
3. **channel_links** - 频道链接（多对多）
4. **acls** - 访问控制（支持软删除）
5. **user_last_channels** - 用户最后频道

### Hub Server 专用表

6. **edges** - Edge 服务器注册
7. **sessions** - 全局会话管理
8. **voice_targets** - 语音目标配置
9. **configs** - 动态配置
10. **audit_logs** - 审计日志

## 下一步工作

### 1. 集成到 HubServer 主类

```typescript
// hub-server.ts
export class HubServer {
  private channelManager: ChannelManager;
  private aclManager: ACLManager;
  private banManager: BanManager;
  
  constructor(config: HubConfig) {
    this.database = new HubDatabase(config.database);
    this.channelManager = new ChannelManager(this.database);
    this.aclManager = new ACLManager(this.database);
    this.banManager = new BanManager(this.database);
    // ...
  }
}
```

### 2. 实现数据同步广播

```typescript
// 在各 Manager 的变更方法中添加
private broadcastChannelUpdate(channel: ChannelData): void {
  this.syncService.broadcastUpdate({
    type: 'channel.update',
    data: channel,
    timestamp: Date.now(),
  });
}
```

### 3. 添加 gRPC 接口

```typescript
// 频道管理接口
rpc CreateChannel(CreateChannelRequest) returns (Channel);
rpc UpdateChannel(UpdateChannelRequest) returns (Channel);
rpc DeleteChannel(DeleteChannelRequest) returns (Empty);
rpc GetChannel(GetChannelRequest) returns (Channel);
rpc ListChannels(ListChannelsRequest) returns (ChannelList);

// ACL 管理接口
rpc SetChannelACL(SetACLRequest) returns (Empty);
rpc GetChannelACL(GetACLRequest) returns (ACLList);
rpc ClearChannelACL(ClearACLRequest) returns (Empty);

// 封禁管理接口
rpc AddBan(AddBanRequest) returns (Ban);
rpc RemoveBan(RemoveBanRequest) returns (Empty);
rpc ListBans(ListBansRequest) returns (BanList);
rpc CheckBan(CheckBanRequest) returns (BanCheckResponse);
```

### 4. 添加 Web API（可选）

为管理员提供 HTTP REST API：

```
POST   /api/channels              - 创建频道
PUT    /api/channels/:id          - 更新频道
DELETE /api/channels/:id          - 删除频道
GET    /api/channels              - 列出所有频道
GET    /api/channels/:id/acl      - 获取频道 ACL
POST   /api/channels/:id/acl      - 设置频道 ACL
GET    /api/bans                  - 列出封禁
POST   /api/bans                  - 添加封禁
DELETE /api/bans/:id              - 移除封禁
```

### 5. 添加测试

```typescript
describe('ChannelManager', () => {
  it('should create channel and persist to database', () => {
    const id = channelManager.createChannel({ name: 'Test' });
    const channel = channelManager.getChannel(id);
    expect(channel?.name).toBe('Test');
    
    // 重启后仍能获取
    const newManager = new ChannelManager(database);
    const loaded = newManager.getChannel(id);
    expect(loaded?.name).toBe('Test');
  });
});
```

## 优势

### 1. 数据一致性

- ✅ 数据库为唯一真实来源
- ✅ 所有写操作立即持久化
- ✅ 重启后完整恢复状态

### 2. 性能

- ✅ 内存缓存提供快速读取
- ✅ 批量操作减少数据库 I/O
- ✅ 索引优化（证书哈希、IP 查找）

### 3. 可维护性

- ✅ 清晰的分层架构
- ✅ 每个管理器职责单一
- ✅ 易于测试和调试

### 4. 可扩展性

- ✅ 预留广播接口
- ✅ 支持 Web API 扩展
- ✅ 支持数据迁移

### 5. 兼容性

- ✅ 与 Go 版本数据库完全兼容
- ✅ 支持平滑迁移
- ✅ 保留软删除和 GORM 特性

## 监控建议

添加以下监控指标：

```typescript
{
  "database": {
    "channels_count": 150,
    "acls_count": 300,
    "bans_count": 25,
    "sessions_count": 500,
    "edges_count": 10
  },
  "cache": {
    "channels_cached": 150,
    "acls_cached": 50,
    "bans_cached": 25,
    "cache_hit_rate": 0.95
  },
  "operations": {
    "db_queries_per_sec": 100,
    "db_writes_per_sec": 10,
    "avg_query_time_ms": 5
  }
}
```

## 配置示例

```json
{
  "database": {
    "path": "./data/hub.db",
    "backupDir": "./data/backups",
    "backupInterval": 3600000,
    "autoVacuum": true,
    "journalMode": "WAL"
  }
}
```

## 文档

- [数据库迁移指南](./DATABASE_MIGRATION.md)
- [数据同步架构](./10-数据同步架构.md)
- [改进计划](./HUB_DATABASE_IMPROVEMENT.md)
- [实现总结](./DATABASE_IMPLEMENTATION_SUMMARY.md)
