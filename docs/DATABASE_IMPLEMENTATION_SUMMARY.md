# 数据库和数据同步实现总结

## 已完成的工作

### 1. Hub Server 数据库结构 (Go 兼容)

**文件**: `node/packages/hub-server/src/database.ts`

#### Go 兼容的表结构

已实现与 Go 版本完全兼容的数据库表：

1. **bans** - 封禁表
   - 兼容 Go 的 `Ban` struct + `gorm.Model`
   - 支持软删除 (deleted_at)
   - IP 地址存储为 BLOB
   - 支持证书哈希封禁

2. **channels** - 频道表
   - 兼容 Go 的 `Channel` struct
   - 支持父子关系 (parent_id)
   - 支持 ACL 继承 (inherit_acl)
   - 包含描述和管理标记

3. **channel_links** - 频道链接表
   - 多对多关系表
   - 兼容 GORM 的关联表结构

4. **acls** - 访问控制列表
   - 兼容 Go 的 `ACL` struct + `gorm.Model`
   - 支持软删除
   - 支持用户和组权限
   - Permission 以 INTEGER 存储

5. **user_last_channels** - 用户最后频道
   - 兼容 Go 的 `UserLastChannel` struct
   - 简单的键值对结构

#### Hub Server 专用表

6. **edges** - Edge 服务器注册表
7. **sessions** - 全局会话管理
8. **voice_targets** - 语音目标注册
9. **configs** - 配置存储
10. **audit_logs** - 审计日志

#### 实现的方法

**封禁管理**:
- `getAllBans()` - 获取所有活跃封禁
- `addBan(ban)` - 添加封禁
- `deleteBan(id)` - 软删除封禁
- `purgeBans()` - 清空所有封禁
- `isCertHashBanned(hash)` - 检查证书封禁
- `isIPBanned(ip)` - 检查 IP 封禁

**频道管理**:
- `getAllChannels()` - 获取所有频道
- `getChannel(id)` - 获取单个频道
- `createChannel(channel)` - 创建频道
- `updateChannel(id, updates)` - 更新频道
- `deleteChannel(id)` - 删除频道
- `getChildChannels(parentId)` - 获取子频道
- `getChannelLinks(channelId)` - 获取频道链接
- `linkChannels(id1, id2)` - 链接频道
- `unlinkChannels(id1, id2)` - 取消链接
- `initRootChannel(name)` - 初始化根频道

**ACL 管理**:
- `getChannelACLs(channelId)` - 获取频道 ACL
- `addACL(acl)` - 添加 ACL
- `updateACL(id, updates)` - 更新 ACL
- `deleteACL(id)` - 软删除 ACL
- `clearChannelACLs(channelId)` - 清空频道 ACL

**用户最后频道**:
- `getUserLastChannel(userId)` - 获取用户最后频道
- `setUserLastChannel(userId, channelId)` - 设置用户最后频道

### 2. 数据同步架构设计

**文件**: `node/docs/10-数据同步架构.md`

#### 核心原则

1. **单一数据源**: Hub Server 是唯一的持久化存储
2. **Edge 无数据库**: Edge Server 仅使用内存，不使用 SQLite
3. **推送式同步**: Hub 主动推送变更到 Edge
4. **最终一致性**: 通过增量同步和定期校验保证

#### 同步机制

1. **初始化同步 (Full Sync)**
   - Edge 启动时请求完整快照
   - 包含所有频道、ACL、封禁数据
   - 加载到内存缓存

2. **增量同步 (Incremental Sync)**
   - Hub 广播数据变更
   - gRPC Server Streaming
   - 按序列号保证顺序

3. **容错机制**
   - 断线重连（指数退避）
   - 丢失检测和补偿
   - 定期一致性校验

### 3. gRPC 同步协议

**文件**: `node/packages/protocol/proto/sync.proto`

#### 服务定义

```protobuf
service SyncService {
  rpc RequestFullSnapshot(SnapshotRequest) returns (FullSnapshot);
  rpc SubscribeUpdates(SubscribeRequest) returns (stream SyncUpdate);
  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);
  rpc RequestMissingUpdates(MissingUpdatesRequest) returns (MissingUpdatesResponse);
  rpc GetChecksum(ChecksumRequest) returns (ChecksumResponse);
}
```

#### 更新类型

- `CHANNEL_CREATE` - 频道创建
- `CHANNEL_UPDATE` - 频道更新
- `CHANNEL_DELETE` - 频道删除
- `CHANNEL_LINK` - 频道链接
- `CHANNEL_UNLINK` - 频道取消链接
- `ACL_UPDATE` - ACL 更新
- `BAN_ADD` - 封禁添加
- `BAN_REMOVE` - 封禁移除
- `CONFIG_UPDATE` - 配置更新

### 4. Edge Server 状态管理

**文件**: `node/packages/edge-server/src/state-manager.ts`

#### EdgeStateManager 类

**内存数据结构**:
- `channels: Map<number, ChannelData>` - 频道映射
- `channelTree: ChannelNode` - 频道树结构
- `channelLinks: Map<number, Set<number>>` - 频道链接
- `acls: Map<number, ACLData[]>` - ACL 映射
- `bans: BanCache` - 封禁缓存
- `configs: Map<string, any>` - 配置映射

**核心方法**:
- `loadSnapshot(snapshot)` - 加载完整快照
- `handleUpdate(update)` - 处理单个更新
- `handleBatchUpdates(updates)` - 批量处理更新
- `checkBan(ip, certHash)` - 检查封禁（内存查询）
- `getChannel(id)` - 获取频道（内存查询）
- `getChannelACLs(id)` - 获取 ACL（内存查询）
- `calculateChecksum()` - 计算数据校验和

#### BanCache 类

**功能**:
- 证书哈希快速查找 (`Map<hash, banId>`)
- IP CIDR 匹配
- 自动过期检查
- IPv4/IPv6 支持

### 5. 数据迁移支持

**文件**: 
- `node/docs/DATABASE_MIGRATION.md` - 迁移文档
- `node/scripts/migrate-from-go.ts` - 迁移脚本

#### 迁移脚本功能

```bash
# 从 Go 数据库迁移到 Hub Server
pnpm run migrate -- --from=/path/to/go/data.db --to=/path/to/hub/data.db

# 支持的选项
--backup        # 创建备份
--dry-run       # 模拟运行
--verbose       # 详细日志
```

**迁移内容**:
- bans 表（含软删除处理）
- channels 表
- channel_links 表
- acls 表（含软删除处理）
- user_last_channels 表

**数据验证**:
- 孤立 ACL 检查
- 无效父频道检查
- 频道链接完整性检查

## 架构优势

### 性能

1. **低延迟**: Edge 从内存读取，无数据库 I/O
2. **高并发**: 支持大量 Edge 并发连接
3. **批量处理**: 减少频道树重建次数

### 可靠性

1. **数据一致性**: 定期校验和补偿机制
2. **容错性**: 断线重连、丢失检测
3. **可恢复**: 完整快照支持灾难恢复

### 可维护性

1. **清晰的职责**: Hub 持久化，Edge 缓存
2. **易于调试**: 丰富的日志和监控
3. **兼容性**: 与 Go 版本数据库完全兼容

## 下一步实现

### Hub Server 端

1. **SyncService 实现**
   ```typescript
   class HubSyncService implements SyncService {
     async requestFullSnapshot(request): Promise<FullSnapshot>
     async *subscribeUpdates(request): AsyncGenerator<SyncUpdate>
     async heartbeat(request): Promise<HeartbeatResponse>
   }
   ```

2. **数据变更广播**
   ```typescript
   class HubBroadcaster {
     broadcastChannelUpdate(update)
     broadcastACLUpdate(channelId, acls)
     broadcastBanUpdate(action, ban)
   }
   ```

3. **序列号管理**
   - 全局递增序列号
   - 持久化到数据库
   - 用于丢失检测

### Edge Server 端

1. **SyncClient 实现**
   ```typescript
   class EdgeSyncClient {
     async connect()
     async requestFullSnapshot()
     async subscribeToUpdates()
     async handleReconnect()
   }
   ```

2. **更新处理器**
   ```typescript
   class UpdateProcessor {
     async processUpdate(update)
     async processBatch(updates)
     detectMissingSequences()
   }
   ```

3. **一致性检查器**
   ```typescript
   class ConsistencyChecker {
     async performCheck()
     async compareWithHub()
     async requestFullResync()
   }
   ```

### 集成和测试

1. **单元测试**
   - EdgeStateManager 功能测试
   - BanCache 匹配逻辑测试
   - 频道树构建测试

2. **集成测试**
   - Hub-Edge 同步测试
   - 断线重连测试
   - 数据一致性测试

3. **性能测试**
   - 大量 Edge 并发测试
   - 高频更新压力测试
   - 内存使用监控

## 使用示例

### Hub Server 初始化

```typescript
import { HubDatabase } from './database';

const db = new HubDatabase({
  path: './data/hub.db',
  backupDir: './data/backups',
  backupInterval: 3600000, // 1小时
});

// 初始化根频道
db.initRootChannel('My Server');

// 添加频道
const channelId = db.createChannel({
  name: 'General',
  parentId: 0,
});

// 添加 ACL
db.addACL({
  channel_id: channelId,
  user_id: -1, // 组 ACL
  group: 'admin',
  apply_here: true,
  apply_subs: true,
  allow: 0x1ff, // 所有权限
  deny: 0,
});
```

### Edge Server 初始化

```typescript
import { EdgeStateManager } from './state-manager';

const stateManager = new EdgeStateManager();

// 连接到 Hub 并同步
const snapshot = await hubClient.requestFullSnapshot({
  edgeServerId: config.serverId,
});

stateManager.loadSnapshot(snapshot);

// 订阅更新
for await (const update of hubClient.subscribeUpdates({})) {
  stateManager.handleUpdate(update);
}

// 使用内存数据
const banned = stateManager.checkBan(clientIp, clientCertHash);
if (banned.banned) {
  connection.close(`Banned: ${banned.reason}`);
}
```

## 配置建议

### Hub Server

```json
{
  "database": {
    "path": "./data/hub.db",
    "backupInterval": 3600000,
    "backupDir": "./data/backups"
  },
  "sync": {
    "port": 50051,
    "maxEdges": 100,
    "heartbeatInterval": 30000
  }
}
```

### Edge Server

```json
{
  "hub": {
    "host": "hub.example.com",
    "port": 50051,
    "reconnectAttempts": 10,
    "reconnectDelay": 1000
  },
  "sync": {
    "checksumInterval": 300000,
    "fullResyncThreshold": 10
  }
}
```

## 监控指标

### Hub Server

- `sync.connected_edges` - 已连接的 Edge 数量
- `sync.broadcast_latency` - 广播延迟
- `sync.update_queue_size` - 更新队列大小
- `db.query_time` - 数据库查询时间

### Edge Server

- `sync.last_update_time` - 最后更新时间
- `sync.update_latency` - 更新延迟
- `sync.missing_updates` - 丢失的更新数
- `cache.memory_usage` - 缓存内存使用

## 注意事项

1. **内存使用**: Edge Server 内存使用与数据量成正比，需要监控
2. **网络带宽**: 大量 Edge 同时同步会占用带宽
3. **时钟同步**: Hub 和 Edge 的系统时钟应该同步（NTP）
4. **日志管理**: 增量更新可能产生大量日志，需要合理配置
5. **备份策略**: Hub 数据库需要定期备份

## 文档和参考

- [数据同步架构](./docs/10-数据同步架构.md)
- [数据库迁移指南](./docs/DATABASE_MIGRATION.md)
- [Protobuf 定义](./packages/protocol/proto/sync.proto)
- [Go 数据结构参考](../ban.go, ../channel.go, ../acl.go)
