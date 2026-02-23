# 01 - ACL 权限系统

## 状态: ❌ 未实现

当前 Hub 的 `handle_permission_query` 是桩实现，返回所有权限 (0x7FFFFFFF)。

## 当前实现

- 数据库有 `acls` 表但未使用
- Edge 转发 PermissionQuery 到 Hub 并中继响应
- 无 ACL 查询/更新处理 (`edge.handleACL` RPC 不存在)
- 无频道继承逻辑

## 目标功能

### 权限位定义

```rust
pub struct Permission(u32);

impl Permission {
    const NONE: u32        = 0x0;
    const WRITE: u32       = 0x1;       // 管理员编辑
    const TRAVERSE: u32    = 0x2;       // 穿过频道
    const ENTER: u32       = 0x4;       // 进入频道
    const SPEAK: u32       = 0x8;       // 语音传输
    const MUTE_DEAFEN: u32 = 0x10;      // 静音/屏蔽他人
    const MOVE: u32        = 0x20;      // 移动用户
    const MAKE_CHANNEL: u32 = 0x40;     // 创建临时频道
    const LINK_CHANNEL: u32 = 0x80;     // 创建频道链接
    const WHISPER: u32     = 0x100;     // 私密语音
    const TEXT_MESSAGE: u32 = 0x200;    // 发送文字消息
    const TEMP_CHANNEL: u32 = 0x400;    // 创建/修改临时频道
    const LISTEN: u32      = 0x800;     // 监听其他频道
    const KICK: u32        = 0x10000;   // 踢出 (仅根频道)
    const BAN: u32         = 0x20000;   // 封禁 (仅根频道)
    const REGISTER: u32    = 0x40000;   // 注册用户 (仅根频道)
    const SELF_REGISTER: u32 = 0x80000; // 自注册 (仅根频道)
}
```

### ACL 条目结构

```rust
struct AclEntry {
    channel_id: u32,
    user_id: Option<i32>,       // 针对特定用户
    group: Option<String>,       // 针对用户组
    deny: u32,                   // 拒绝的权限位
    grant: u32,                  // 授予的权限位
    apply_here: bool,            // 在当前频道生效
    apply_subs: bool,            // 在子频道生效
    priority: i32,               // 规则优先级
}
```

### 权限计算流程

1. 从根频道开始，沿频道树向下到目标频道
2. 在每个层级，如果 `inherit_acl = true`，应用父频道 ACL
3. 按优先级排序 ACL 条目
4. 对每条 ACL，检查是否匹配用户 (user_id 或 group)
5. 应用 grant/deny 位掩码
6. `Write` 权限隐含除 Speak/Whisper 外的所有权限
7. 默认权限: Traverse + Enter + Speak + Whisper + TextMessage + Listen

### 需要权限检查的操作

| 操作 | 所需权限 | 频道 |
|------|----------|------|
| 进入频道 | Enter | 目标频道 |
| 移动用户 | Enter(目标) + Move(源) + Traverse(目标) | — |
| 静音/屏蔽他人 | MuteDeafen | 目标用户频道 |
| 创建频道 | MakeChannel | 父频道 |
| 删除频道 | Write | 目标频道 |
| 编辑 ACL | Write | 目标频道 |
| 发送文字 | TextMessage | 目标频道 |
| 踢出用户 | Kick | 根频道 |
| 封禁用户 | Ban | 根频道 |
| 注册用户 | Register | 根频道 |
| 监听频道 | Listen | 目标频道 |

### Hub 侧实现

```
新文件: munode-hub/src/acl_manager.rs

struct AclManager {
    db: Arc<Database>,
    cache: RwLock<HashMap<(u32, u32), u32>>, // (channel_id, user_id) → permission bits
}

impl AclManager {
    fn calculate_permissions(&self, user_id: i32, channel_id: u32, groups: &[String]) -> u32;
    fn get_channel_acls(&self, channel_id: u32) -> Vec<AclEntry>;
    fn save_acl(&self, channel_id: u32, entries: &[AclEntry]) -> Result<()>;
    fn invalidate_cache(&self, channel_id: u32);
    fn check_permission(&self, user_id: i32, channel_id: u32, permission: u32) -> bool;
}
```

### Edge 侧实现

- 新增 `MessageType::ACL` 处理器
- ACL 查询: 转发到 Hub `edge.handleACL` RPC
- ACL 更新: 转发到 Hub `edge.saveACL` RPC
- 收到 Hub 的 `hub.aclUpdated` 通知后，刷新本地客户端权限

### 数据库 Schema

```sql
-- 已存在但需扩展
CREATE TABLE acls (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL,
    user_id INTEGER,
    group_name TEXT,
    deny INTEGER NOT NULL DEFAULT 0,
    grant_perm INTEGER NOT NULL DEFAULT 0,
    apply_here BOOLEAN NOT NULL DEFAULT 1,
    apply_subs BOOLEAN NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

-- 默认 ACL: 根频道给所有人基本权限
INSERT INTO acls (channel_id, group_name, grant_perm, apply_here, apply_subs)
VALUES (0, '@all', 0xF8E, 1, 1); -- Traverse+Enter+Speak+Whisper+TextMessage+Listen
```

## 影响范围

- `munode-hub/src/rpc_handler.rs` - 替换桩实现
- `munode-hub/src/database.rs` - ACL CRUD 方法
- 新建 `munode-hub/src/acl_manager.rs`
- `munode-edge/src/server.rs` - 添加 ACL 消息处理
- `munode-edge/src/hub_client.rs` - 添加 handleACL/saveACL RPC
