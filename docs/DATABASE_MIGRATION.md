# 数据库迁移指南

## 概述

Hub Server 的数据库结构设计为与原始 Go 版本兼容，确保可以平滑迁移现有数据。

## Go 版本数据结构映射

### 1. Ban 表 (封禁管理)

**Go 定义** (`ban.go`):
```go
type Ban struct {
    gorm.Model              // ID, CreatedAt, UpdatedAt, DeletedAt
    Address  []byte         // IP地址 (二进制格式)
    Mask     int            // CIDR 掩码
    Name     string         // 用户名
    Hash     string         // 证书哈希
    Reason   string         // 封禁原因
    Start    int64          // 开始时间 (Unix timestamp)
    Duration int            // 持续时间(秒)
}
```

**SQLite 表结构**:
```sql
CREATE TABLE bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME,
    updated_at DATETIME,
    deleted_at DATETIME,
    address BLOB NOT NULL,
    mask INTEGER NOT NULL,
    name TEXT,
    hash TEXT,
    reason TEXT,
    start INTEGER,
    duration INTEGER
);
```

**迁移说明**:
- `address` 存储为 BLOB，兼容 Go 的 `[]byte`
- `gorm.Model` 的软删除字段 `deleted_at` 保留
- 时间戳使用 Unix 秒数格式

### 2. Channel 表 (频道管理)

**Go 定义** (`channel.go`):
```go
type Channel struct {
    ID       int
    Name     string
    Position int
    MaxUsers int
    ParentID int
    InheritACL bool
    Links []*Channel          // 多对多关系
    DescriptionBlob string
    Managed bool
}
```

**SQLite 表结构**:
```sql
CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    max_users INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER NOT NULL DEFAULT 0,
    inherit_acl INTEGER NOT NULL DEFAULT 1,
    description_blob TEXT,
    managed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE channel_links (
    channel_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY (channel_id, target_id)
);
```

**迁移说明**:
- `InheritACL` 映射为 `inherit_acl` (INTEGER: 0/1)
- `Links` 使用独立的 `channel_links` 表 (GORM 多对多)
- 根频道 `id=0`, `parent_id=-1`

### 3. ACL 表 (访问控制列表)

**Go 定义** (`acl.go`):
```go
type ACL struct {
    gorm.Model              // ID, CreatedAt, UpdatedAt, DeletedAt
    ChannelID int
    UserID int              // -1 表示组 ACL
    Group  string
    ApplyHere bool
    ApplySubs bool
    Allow     Permission    // uint32
    Deny      Permission    // uint32
}
```

**SQLite 表结构**:
```sql
CREATE TABLE acls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME,
    updated_at DATETIME,
    deleted_at DATETIME,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL DEFAULT -1,
    "group" TEXT,
    apply_here INTEGER NOT NULL,
    apply_subs INTEGER NOT NULL,
    allow INTEGER,
    deny INTEGER
);
```

**迁移说明**:
- `group` 是 SQL 关键字，需要加引号
- Permission 以 INTEGER 存储 (SQLite 支持 64 位整数)
- 布尔值映射为 INTEGER (0/1)

### 4. UserLastChannel 表 (用户最后频道)

**Go 定义** (`client.go`):
```go
type UserLastChannel struct {
    ID          uint32      // 用户 ID
    LastChannel int         // 最后所在频道 ID
}
```

**SQLite 表结构**:
```sql
CREATE TABLE user_last_channels (
    id INTEGER PRIMARY KEY,
    last_channel INTEGER
);
```

**迁移说明**:
- 简单的键值对结构
- `id` 为用户 ID (非自增)

## Hub Server 专用表

以下表为 TypeScript Hub Server 新增，不存在于 Go 版本中：

### 1. edges (Edge 服务器注册)
```sql
CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER UNIQUE NOT NULL,
    hostname TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    -- ... 其他字段
);
```

### 2. sessions (全局会话管理)
```sql
CREATE TABLE sessions (
    session_id INTEGER PRIMARY KEY,
    edge_id INTEGER NOT NULL,
    user_id INTEGER,
    -- ... 其他字段
);
```

### 3. voice_targets (语音目标注册)
```sql
CREATE TABLE voice_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    edge_id INTEGER NOT NULL,
    client_session INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    -- ... 其他字段
);
```

### 4. configs (配置存储)
```sql
CREATE TABLE configs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at INTEGER NOT NULL
);
```

### 5. audit_logs (审计日志)
```sql
CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    edge_id INTEGER,
    session_id INTEGER,
    message TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
);
```

## 数据迁移步骤

### 从 Go 迁移到 TypeScript Hub Server

1. **备份 Go 数据库**:
   ```bash
   cp data.db data.db.backup
   ```

2. **导出 Go 数据库结构和数据**:
   ```bash
   sqlite3 data.db .dump > go_data.sql
   ```

3. **初始化 Hub Server 数据库**:
   ```bash
   cd node
   pnpm run hub:init
   ```

4. **导入兼容表数据**:
   ```bash
   sqlite3 hub_data.db < go_migration.sql
   ```

   `go_migration.sql` 示例:
   ```sql
   -- 导入封禁数据
   INSERT INTO bans SELECT * FROM old_bans;
   
   -- 导入频道数据
   INSERT INTO channels SELECT * FROM old_channels;
   
   -- 导入 ACL 数据
   INSERT INTO acls SELECT * FROM old_acls;
   
   -- 导入用户最后频道
   INSERT INTO user_last_channels SELECT * FROM old_user_last_channels;
   
   -- 导入频道链接
   INSERT INTO channel_links SELECT * FROM old_channel_links;
   ```

5. **验证数据完整性**:
   ```bash
   sqlite3 hub_data.db
   SELECT COUNT(*) FROM bans;
   SELECT COUNT(*) FROM channels;
   SELECT COUNT(*) FROM acls;
   ```

## 注意事项

### 字段类型转换

1. **时间戳格式**:
   - Go: `time.Time` → SQLite: `DATETIME` 或 `INTEGER`
   - TypeScript: `Date` → Unix 秒数 (INTEGER)

2. **布尔值**:
   - Go: `bool` → SQLite: `INTEGER` (0/1)
   - TypeScript: `boolean` → SQLite: `INTEGER` (0/1)

3. **二进制数据**:
   - Go: `[]byte` → SQLite: `BLOB`
   - TypeScript: `Buffer` → SQLite: `BLOB`

### GORM 特性

1. **软删除**:
   - Go 使用 `gorm.Model` 的 `DeletedAt` 字段
   - 删除操作实际是 UPDATE 设置 `deleted_at`
   - 查询时自动过滤 `deleted_at IS NOT NULL`

2. **自动时间戳**:
   - `CreatedAt`: 插入时自动设置
   - `UpdatedAt`: 更新时自动设置

3. **外键约束**:
   - TypeScript 使用 `FOREIGN KEY ... ON DELETE CASCADE`
   - Go 可能不强制外键约束，需手动清理

### 数据一致性检查

迁移后建议运行以下检查：

```sql
-- 检查孤立的 ACL
SELECT COUNT(*) FROM acls 
WHERE channel_id NOT IN (SELECT id FROM channels);

-- 检查无效的父频道
SELECT COUNT(*) FROM channels 
WHERE parent_id > 0 AND parent_id NOT IN (SELECT id FROM channels);

-- 检查过期的封禁
SELECT COUNT(*) FROM bans 
WHERE duration > 0 AND (start + duration) < strftime('%s', 'now');

-- 检查频道链接的完整性
SELECT COUNT(*) FROM channel_links 
WHERE channel_id NOT IN (SELECT id FROM channels)
   OR target_id NOT IN (SELECT id FROM channels);
```

## 工具脚本

### 自动迁移脚本

```typescript
// scripts/migrate-from-go.ts
import Database from 'better-sqlite3';

interface MigrationConfig {
  goDbPath: string;
  hubDbPath: string;
}

async function migrateFromGo(config: MigrationConfig) {
  const goDb = new Database(config.goDbPath, { readonly: true });
  const hubDb = new Database(config.hubDbPath);

  // 迁移 bans
  const bans = goDb.prepare('SELECT * FROM bans WHERE deleted_at IS NULL').all();
  const insertBan = hubDb.prepare(`
    INSERT INTO bans (id, created_at, updated_at, address, mask, name, hash, reason, start, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const ban of bans) {
    insertBan.run(
      ban.id, ban.created_at, ban.updated_at,
      ban.address, ban.mask, ban.name, ban.hash,
      ban.reason, ban.start, ban.duration
    );
  }

  // 迁移 channels
  const channels = goDb.prepare('SELECT * FROM channels').all();
  const insertChannel = hubDb.prepare(`
    INSERT INTO channels (id, name, position, max_users, parent_id, inherit_acl, description_blob, managed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const ch of channels) {
    insertChannel.run(
      ch.id, ch.name, ch.position, ch.max_users,
      ch.parent_id, ch.inherit_acl, ch.description_blob, ch.managed
    );
  }

  // 迁移 ACLs
  const acls = goDb.prepare('SELECT * FROM acls WHERE deleted_at IS NULL').all();
  const insertAcl = hubDb.prepare(`
    INSERT INTO acls (id, created_at, updated_at, channel_id, user_id, "group", apply_here, apply_subs, allow, deny)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const acl of acls) {
    insertAcl.run(
      acl.id, acl.created_at, acl.updated_at,
      acl.channel_id, acl.user_id, acl.group,
      acl.apply_here, acl.apply_subs, acl.allow, acl.deny
    );
  }

  // 迁移 user_last_channels
  const userLastChannels = goDb.prepare('SELECT * FROM user_last_channels').all();
  const insertUlc = hubDb.prepare(`
    INSERT INTO user_last_channels (id, last_channel)
    VALUES (?, ?)
  `);
  
  for (const ulc of userLastChannels) {
    insertUlc.run(ulc.id, ulc.last_channel);
  }

  // 迁移 channel_links
  const links = goDb.prepare('SELECT * FROM channel_links').all();
  const insertLink = hubDb.prepare(`
    INSERT INTO channel_links (channel_id, target_id)
    VALUES (?, ?)
  `);
  
  for (const link of links) {
    insertLink.run(link.channel_id, link.target_id);
  }

  goDb.close();
  hubDb.close();

  console.log('Migration completed successfully');
}

// 使用示例
migrateFromGo({
  goDbPath: '../data.db',
  hubDbPath: './data/hub.db',
});
```

## 兼容性测试

创建测试用例验证数据结构兼容性：

```typescript
// tests/database-compatibility.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('Database Compatibility', () => {
  it('should have Go-compatible ban table structure', () => {
    const db = new Database(':memory:');
    // ... 创建表并验证
  });

  it('should support GORM soft delete', () => {
    const db = new Database(':memory:');
    // ... 测试软删除功能
  });

  it('should handle channel links correctly', () => {
    const db = new Database(':memory:');
    // ... 测试多对多关系
  });
});
```

## 参考资料

- [GORM 文档](https://gorm.io/)
- [SQLite 数据类型](https://www.sqlite.org/datatype3.html)
- [Mumble Protocol 文档](https://mumble-protocol.readthedocs.io/)
- [原项目数据结构](../../ban.go, ../../channel.go, ../../acl.go)
