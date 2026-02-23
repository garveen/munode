# 05 - 用户密码认证

## 状态: 🔶 部分实现

Hub 认证目前支持访客模式 (无密码) 和服务器密码验证，但不支持个人用户密码验证。

## 当前实现

- `handle_authenticate_user` 检查:
  - 用户名非空
  - 服务器密码匹配 (如果配置了)
  - 查找数据库用户获取 user_id 和 last_channel
  - 如果用户不存在则创建新用户 (user_id = -1 表示访客)
- 无密码哈希存储/验证

## 目标功能

### 认证流程

```
客户端 → Edge: Authenticate { username, password, tokens, celt_versions, opus }
Edge → Hub: edge.authenticateUser { username, password, cert_hash, ip, ... }
Hub:
  1. 查找用户 (username)
  2. 如果用户存在且有密码:
     a. 验证 password 与 pw_hash (argon2 或 bcrypt)
     b. 失败则拒绝
  3. 如果用户存在且无密码:
     a. 允许登录 (访客模式)
  4. 如果用户不存在:
     a. 根据配置决定是否允许访客
     b. 允许则创建临时会话
  5. 检查证书哈希 (如果 cert_required)
  6. 返回认证结果
Hub → Edge: { success, user_id, channel_id, groups, is_admin, ... }
```

### 密码存储

```rust
// 使用 argon2 进行密码哈希
use argon2::{self, Config, Variant, Version};

fn hash_password(password: &str) -> String {
    let salt = rand::random::<[u8; 16]>();
    let config = Config {
        variant: Variant::Argon2id,
        version: Version::Version13,
        mem_cost: 65536,
        time_cost: 3,
        lanes: 4,
        ..Default::default()
    };
    argon2::hash_encoded(password.as_bytes(), &salt, &config).unwrap()
}

fn verify_password(hash: &str, password: &str) -> bool {
    argon2::verify_encoded(hash, password.as_bytes()).unwrap_or(false)
}
```

### 数据库增强

```sql
-- users 表已有 pw_hash 列
-- 需确保 pw_hash 存储 argon2 编码的哈希
-- 需新增:
ALTER TABLE users ADD COLUMN cert_hash TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT 0;
ALTER TABLE users ADD COLUMN groups TEXT DEFAULT '[]';  -- JSON array
```

### 新增 RPC

- `edge.registerUser` - 用户自注册 (需 SelfRegister 权限)
- `edge.changePassword` - 修改密码
- Hub 通知: 认证失败时返回 Reject 原因 (WrongUserPW, InvalidUsername, AuthenticatorFail)

### 依赖

```toml
argon2 = "0.5"    # 密码哈希
```

### 影响范围

- `munode-hub/src/rpc_handler.rs` - 增强 authenticate_user
- `munode-hub/src/database.rs` - 密码哈希 CRUD
- `munode-edge/src/server.rs` - 处理认证拒绝 (Reject 消息)
- `munode-edge/src/handler.rs` - 认证失败的 Reject 消息构建
