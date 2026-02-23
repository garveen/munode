# 04 - 封禁管理系统

## 状态: ❌ 未实现

当前 BanList 查询返回空列表，UserRemove 的 ban 标志被转发但 Hub 不执行封禁。

## 当前实现

- Edge 收到 BanList 查询时返回空列表
- Edge 收到 UserRemove (ban=true) 时转发到 Hub
- Hub on_user_remove 广播 UserRemove 但不记录封禁

## 目标功能

### 封禁记录结构

```rust
struct BanRecord {
    address: [u8; 16],     // IPv4 (4字节, 后12字节为0) 或 IPv6 (16字节)
    mask: u32,              // CIDR 子网掩码长度
    name: String,           // 被封禁用户名 (参考)
    hash: String,           // 证书 SHA-256 哈希
    reason: String,         // 封禁原因
    start: i64,             // 开始时间 (Unix 秒)
    duration: u32,          // 持续时间 (秒, 0=永久)
}
```

### 数据库 Schema

```sql
CREATE TABLE bans (
    id INTEGER PRIMARY KEY,
    address BLOB NOT NULL,       -- 16 bytes
    mask INTEGER NOT NULL DEFAULT 128,
    name TEXT NOT NULL DEFAULT '',
    cert_hash TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    start_time INTEGER NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0
);
```

### Hub 功能

- `ban_manager.rs`: BanManager 封禁管理器
  - `add_ban(record)` - 添加封禁记录
  - `remove_ban(id)` - 删除封禁记录  
  - `check_ban(ip, cert_hash)` - 检查 IP 或证书是否被封禁
  - `get_bans()` - 获取所有封禁列表
  - `cleanup_expired()` - 清理过期封禁
  
- 新 RPC: `edge.getBanList` → 返回所有封禁
- 新 RPC: `edge.updateBanList` → 批量更新封禁列表
- 通知: `hub.banListUpdated` → 广播到所有 Edge

### Edge 集成

1. **BanList 查询**: 从 Hub 拉取封禁列表返回给客户端 (需 Ban 权限)
2. **BanList 更新**: 将客户端提交的封禁列表转发给 Hub (需 Ban 权限)
3. **UserRemove (ban)**: Hub 添加封禁记录后广播
4. **连接检查**: Edge 收到新 TLS 连接时，检查 IP 和证书哈希 (需缓存封禁列表或查询 Hub)

### 影响范围

- 新建 `munode-hub/src/ban_manager.rs`
- `munode-hub/src/database.rs` - bans 表 CRUD
- `munode-hub/src/rpc_handler.rs` - 新增 ban RPC + 增强 on_user_remove
- `munode-edge/src/server.rs` - BanList 查询/更新，连接时封禁检查
- `munode-edge/src/hub_client.rs` - 新增 ban RPC
