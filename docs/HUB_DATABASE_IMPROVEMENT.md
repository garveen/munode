# Hub Server 数据存储改进计划

## 当前问题

Hub Server 目前的数据存储存在以下问题：

1. **Registry (registry.ts)** - Edge 服务器信息存储在内存 Map 中
   - ✅ 已部分持久化：`database.saveEdge()`, `database.updateEdgeHeartbeat()`
   - ❌ 启动时需要从数据库恢复所有 Edge 状态
   - ❌ 心跳超时处理需要更新数据库状态

2. **SessionManager (session-manager.ts)** - 会话信息存储在内存 Map 中
   - ✅ 已部分持久化：`database.saveSession()`
   - ❌ 缺少 `updateSessionChannel` 的数据库更新
   - ❌ 缺少 `removeSession` 的数据库更新
   - ❌ 启动时恢复会话数据的逻辑不完整

3. **缺少频道管理服务** - 目前没有频道管理的代码
   - ❌ 需要创建 `ChannelManager` 类
   - ❌ 频道的增删改查应该直接操作数据库
   - ❌ 需要在数据变更时广播给 Edge

4. **缺少 ACL 管理服务** - 目前没有 ACL 管理的代码
   - ❌ 需要创建 `ACLManager` 类
   - ❌ ACL 的管理应该直接操作数据库
   - ❌ 需要在 ACL 变更时广播给 Edge

5. **缺少封禁管理服务** - 目前没有封禁管理的代码
   - ❌ 需要创建 `BanManager` 类
   - ❌ 封禁的管理应该直接操作数据库
   - ❌ 需要在封禁变更时广播给 Edge

## 改进方案

### 原则

1. **数据库为唯一真实来源** - 所有业务数据必须持久化到 SQLite
2. **内存作为缓存** - 内存 Map 仅用于性能优化，数据必须从数据库加载
3. **写入即持久化** - 每次数据变更立即写入数据库
4. **启动时恢复** - 服务启动时从数据库完整恢复状态

### 具体改进

#### 1. Registry 改进

```typescript
class ServiceRegistry {
  // 启动时从数据库恢复
  async initialize(): Promise<void> {
    const edges = this.database.getActiveEdges();
    for (const edge of edges) {
      this.edges.set(edge.serverId, edge);
      this.startHeartbeatMonitor(edge.serverId);
    }
  }

  // 注销时更新数据库
  async unregister(serverId: number): Promise<void> {
    // ... existing code ...
    this.database.updateEdgeStatus(serverId, 'inactive');
  }

  // 心跳超时时更新数据库
  private async handleHeartbeatTimeout(serverId: number): Promise<void> {
    this.database.updateEdgeStatus(serverId, 'timeout');
    await this.unregister(serverId);
  }
}
```

#### 2. SessionManager 改进

```typescript
class GlobalSessionManager {
  // 更新频道时同步数据库
  updateSessionChannel(sessionId: number, newChannelId: number): void {
    // ... existing code ...
    this.database.updateSessionChannel(sessionId, newChannelId);
  }

  // 移除会话时同步数据库
  removeSession(sessionId: number): void {
    // ... existing code ...
    this.database.deleteSession(sessionId);
  }
}
```

#### 3. 新建 ChannelManager

```typescript
export class ChannelManager {
  private database: HubDatabase;
  private channelCache: Map<number, ChannelData> = new Map();

  constructor(database: HubDatabase) {
    this.database = database;
    this.loadChannels();
  }

  private loadChannels(): void {
    const channels = this.database.getAllChannels();
    for (const ch of channels) {
      this.channelCache.set(ch.id, ch);
    }
  }

  createChannel(channel: CreateChannelRequest): number {
    const id = this.database.createChannel(channel);
    const created = this.database.getChannel(id);
    if (created) {
      this.channelCache.set(id, created);
      // 广播变更
      this.broadcastChannelCreate(created);
    }
    return id;
  }

  updateChannel(id: number, updates: Partial<ChannelData>): void {
    this.database.updateChannel(id, updates);
    const updated = this.database.getChannel(id);
    if (updated) {
      this.channelCache.set(id, updated);
      // 广播变更
      this.broadcastChannelUpdate(updated);
    }
  }

  deleteChannel(id: number): void {
    this.database.deleteChannel(id);
    this.channelCache.delete(id);
    // 广播变更
    this.broadcastChannelDelete(id);
  }

  getChannel(id: number): ChannelData | undefined {
    return this.channelCache.get(id);
  }

  getAllChannels(): ChannelData[] {
    return Array.from(this.channelCache.values());
  }

  // 广播方法待实现
  private broadcastChannelCreate(channel: ChannelData): void { }
  private broadcastChannelUpdate(channel: ChannelData): void { }
  private broadcastChannelDelete(channelId: number): void { }
}
```

#### 4. 新建 ACLManager

```typescript
export class ACLManager {
  private database: HubDatabase;
  private aclCache: Map<number, ACLData[]> = new Map(); // channelId -> ACLs

  constructor(database: HubDatabase) {
    this.database = database;
  }

  getChannelACLs(channelId: number): ACLData[] {
    if (!this.aclCache.has(channelId)) {
      const acls = this.database.getChannelACLs(channelId);
      this.aclCache.set(channelId, acls);
    }
    return this.aclCache.get(channelId)!;
  }

  addACL(acl: CreateACLRequest): number {
    const id = this.database.addACL(acl);
    this.invalidateCache(acl.channel_id);
    // 广播变更
    this.broadcastACLUpdate(acl.channel_id);
    return id;
  }

  updateACL(id: number, updates: Partial<ACLData>): void {
    this.database.updateACL(id, updates);
    // 需要找到对应的 channelId
    // 广播变更
  }

  deleteACL(id: number): void {
    this.database.deleteACL(id);
    // 需要找到对应的 channelId 并广播
  }

  clearChannelACLs(channelId: number): void {
    this.database.clearChannelACLs(channelId);
    this.invalidateCache(channelId);
    this.broadcastACLUpdate(channelId);
  }

  private invalidateCache(channelId: number): void {
    this.aclCache.delete(channelId);
  }

  private broadcastACLUpdate(channelId: number): void { }
}
```

#### 5. 新建 BanManager

```typescript
export class BanManager {
  private database: HubDatabase;
  private banCache: Map<number, BanData> = new Map();
  private certBanIndex: Map<string, number> = new Map(); // hash -> ban.id

  constructor(database: HubDatabase) {
    this.database = database;
    this.loadBans();
  }

  private loadBans(): void {
    const bans = this.database.getAllBans();
    for (const ban of bans) {
      this.banCache.set(ban.id, ban);
      if (ban.hash) {
        this.certBanIndex.set(ban.hash, ban.id);
      }
    }
  }

  addBan(ban: CreateBanRequest): number {
    const id = this.database.addBan(ban);
    const created = this.database.getAllBans().find(b => b.id === id);
    if (created) {
      this.banCache.set(id, created);
      if (created.hash) {
        this.certBanIndex.set(created.hash, id);
      }
      // 广播变更
      this.broadcastBanAdd(created);
    }
    return id;
  }

  removeBan(id: number): void {
    const ban = this.banCache.get(id);
    if (ban) {
      this.database.deleteBan(id);
      this.banCache.delete(id);
      if (ban.hash) {
        this.certBanIndex.delete(ban.hash);
      }
      // 广播变更
      this.broadcastBanRemove(id);
    }
  }

  checkBan(ip: string, certHash?: string): BanCheckResult {
    // 检查证书封禁
    if (certHash && this.certBanIndex.has(certHash)) {
      const banId = this.certBanIndex.get(certHash)!;
      const ban = this.banCache.get(banId);
      if (ban && this.isBanActive(ban)) {
        return { banned: true, reason: ban.reason, banId: ban.id };
      }
    }

    // 检查 IP 封禁（需要实现 CIDR 匹配）
    // ...

    return { banned: false };
  }

  private isBanActive(ban: BanData): boolean {
    if (!ban.start || ban.duration === undefined) return true;
    if (ban.duration === 0) return true;
    const now = Math.floor(Date.now() / 1000);
    return (ban.start + ban.duration) > now;
  }

  private broadcastBanAdd(ban: BanData): void { }
  private broadcastBanRemove(banId: number): void { }
}
```

## 实施步骤

1. ✅ 数据库已有完整的 CRUD 方法
2. ⏳ 更新 SessionManager 补充数据库操作
3. ⏳ 更新 Registry 补充数据库操作
4. ⏳ 创建 ChannelManager
5. ⏳ 创建 ACLManager
6. ⏳ 创建 BanManager
7. ⏳ 在 HubServer 中集成新的管理器
8. ⏳ 实现数据变更广播机制（SyncService）
9. ⏳ 添加测试
10. ⏳ 更新文档

## 配置文件 vs 数据库

**应该使用配置文件的内容**：
- 服务器基础配置（host, port, serverId）
- TLS 证书路径
- 日志级别和日志文件路径
- 性能调优参数（心跳间隔、超时时间、最大连接数）
- 数据库文件路径和备份策略

**应该使用数据库的内容**：
- 频道结构和频道设置
- ACL 权限规则
- 封禁列表
- 用户最后所在频道
- Edge 服务器注册信息
- 用户会话信息
- VoiceTarget 配置
- 服务器欢迎消息等动态配置

**原则**：
- 静态的、需要重启生效的 → 配置文件
- 动态的、需要实时更新的 → 数据库
