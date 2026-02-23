# 07 - 高级消息处理

## 状态: 🔶 部分实现

基本的文字消息和插件数据转发已实现，但缺少插件数据、上下文操作、用户列表等功能。

## 未实现功能列表

### 7.1 PluginDataTransmission

**说明**: 插件自定义数据消息，允许客户端之间通过插件通道传输任意数据。

```
客户端 → Edge: PluginDataTransmission { 
    senderSession, dataId, data, receiverSessions[] 
}
Edge → Hub: hub.handlePluginDataTransmission { 同上 }
Hub: 按 receiverSessions 路由到对应 Edge (如果空则广播)
Hub → Edge(s): hub.pluginDataBroadcast { 同上 }
Edge → 客户端(s): PluginDataTransmission { 同上 }
```

**实现**: 
- `munode-edge/src/server.rs` - 新增 MessageType::PluginDataTransmission 处理
- `munode-hub/src/rpc_handler.rs` - 新增 on_plugin_data 通知处理

### 7.2 ContextAction / ContextActionModify

**说明**: 右键菜单扩展，支持自定义操作如群组喊话、批量移动。

```
Edge → 客户端: ContextActionModify { action, text, context }
客户端 → Edge: ContextAction { session, channel_id, action }
```

内置操作:
- **Group Shout**: 向同组用户广播语音
- **Members Move (moveto/movefrom)**: 批量移动频道成员
- **Promiscuous Mode**: 接收所有频道语音 (管理员)
- **Clear User Cache**: 清除客户端纹理/评论缓存

**实现复杂度**: 中等，需要用户组系统支持

### 7.3 UserList 管理

**说明**: 管理员查询/编辑注册用户列表。

```
客户端 → Edge: UserList { } (查询)
Edge → Hub: RPC edge.getUserList
Hub → Edge: 注册用户列表
Edge → 客户端: UserList { users[] }

客户端 → Edge: UserList { users[] } (更新)
Edge → Hub: RPC edge.updateUserList
Hub: 更新数据库
```

**权限**: 需要根频道 Register 权限

### 7.4 CodecVersion 协商

**说明**: 客户端发送支持的编解码器版本，服务端协商最优编解码器。

```
客户端 → Edge: CodecVersion { alpha, beta, prefer_alpha, opus }
Edge: 收集所有客户端的编解码器支持
Edge: 计算最优共同编解码器 (优先 Opus)
Edge → 所有客户端: CodecVersion { alpha, beta, prefer_alpha, opus }
```

当前 Edge 在登录时发送固定的 CodecVersion (Opus=true)，但不处理客户端的编解码器协商。

### 7.5 ServerConfig / SuggestConfig

**说明**: 
- ServerConfig: 服务端发送配置 (最大用户数、带宽、欢迎消息)
- SuggestConfig: 客户端建议配置变更

当前 ServerConfig 在登录时发送，但不处理客户端的 SuggestConfig。

## 影响范围

- `munode-edge/src/server.rs` - 新增消息类型处理
- `munode-hub/src/rpc_handler.rs` - 新增通知/RPC
- `munode-edge/src/client.rs` - 存储编解码器信息
- `munode-edge/src/state.rs` - 新增事件类型
