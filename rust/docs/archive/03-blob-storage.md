# 03 - Blob 存储服务

## 状态: ❌ 未实现

当前 RequestBlob 仅返回频道描述，不支持用户纹理/评论的上传和检索。

## 当前实现

- Edge 处理 RequestBlob 时仅查找频道描述 (来自 ChannelManager)
- 无用户纹理 (avatar) 存储
- 无用户评论存储
- Hub 无 Blob 相关 RPC

## 目标功能

### Blob 类型

| 类型 | 说明 | 触发方式 |
|------|------|----------|
| 用户纹理 (texture) | PNG/JPEG 头像数据 | UserState.texture 字段 |
| 用户评论 (comment) | UTF-8 文本 | UserState.comment 字段 |
| 频道描述 (description) | UTF-8 文本 | ChannelState.description 字段 |

### Hub 存储

```rust
// 扩展 munode-hub/src/database.rs

// 新表
CREATE TABLE blobs (
    hash TEXT PRIMARY KEY,        -- SHA-256 hex
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE user_blobs (
    user_id INTEGER NOT NULL,
    blob_type TEXT NOT NULL,       -- 'texture' | 'comment'
    blob_hash TEXT,
    UNIQUE(user_id, blob_type),
    FOREIGN KEY (blob_hash) REFERENCES blobs(hash)
);
```

### Hub RPC 方法

```
blob.put(data: bytes) → { hash: string }
blob.get(hash: string) → { data: bytes }
blob.getUserTexture(user_id: i32) → { hash: string, data: bytes }
blob.getUserComment(user_id: i32) → { hash: string, data: bytes }
blob.setUserTexture(user_id: i32, data: bytes) → { hash: string }
blob.setUserComment(user_id: i32, data: bytes) → { hash: string }
```

### Edge 集成

1. **UserState 处理**: 客户端设置 texture/comment 时:
   - 如果数据 > 128 字节，上传到 Hub blob storage
   - 广播 UserState 时包含 texture_hash / comment_hash
   - 其他客户端通过 RequestBlob 按需拉取
   
2. **RequestBlob 处理**: 
   - session_texture → 从 Hub 拉取用户纹理，发送 UserState
   - session_comment → 从 Hub 拉取用户评论，发送 UserState
   - channel_description → 从 ChannelManager 获取 (已实现)

### 影响范围

- `munode-hub/src/database.rs` - 新增 blobs/user_blobs 表和 CRUD
- `munode-hub/src/rpc_handler.rs` - 新增 blob.* RPC 方法
- `munode-edge/src/server.rs` - 扩展 RequestBlob 和 UserState 处理
- `munode-edge/src/hub_client.rs` - 新增 blob RPC 调用
