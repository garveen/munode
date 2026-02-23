# 09 - 高级用户状态管理

## 状态: 🔶 部分实现

基本的用户状态变更 (频道移动、自静音/耳聋) 已实现，但缺少权限检查和高级功能。

## 当前实现

- Edge 处理 UserState 并转发到 Hub
- Hub 广播状态变更到所有 Edge
- Edge 在客户端加入/离开时广播
- 远程用户通过 fullSync 同步

## 未实现功能

### 9.1 频道移动权限检查

当前用户可以移动到任何频道。需要:
- 检查目标频道 Enter 权限
- 检查源频道 Move 权限 (被他人移动时)
- 检查目标频道 Traverse 权限 (路径穿过)
- 超出 max_users 时拒绝
- 依赖: [01-acl-permission-system.md](01-acl-permission-system.md)

### 9.2 管理员静音/屏蔽

当前仅处理 self_mute/self_deaf。需要:
- 管理员设置 mute/deaf (需 MuteDeafen 权限)
- suppress 状态 (基于 Speak 权限，无法由客户端设置为 true)
- 权限变更时自动更新 suppress

### 9.3 优先发言者 / 录音

```
UserState.priority_speaker: 标记优先发言者 (需权限)
UserState.recording: 标记正在录音 (广播通知)
```

### 9.4 监听频道

```
UserState.listening_channel_add: 添加监听频道 (需 Listen 权限)
UserState.listening_channel_remove: 移除监听频道
```

客户端可以同时监听多个频道的语音，语音路由需要考虑监听频道。

### 9.5 Last Channel 持久化

当用户断连时保存最后所在频道，重新登录时恢复:
```
Hub: 用户认证成功后查找 last_channel
Hub: 验证频道存在且有 Enter 权限
Hub: 设置为初始频道
Hub: 用户断连时保存当前频道
```

当前 Hub 在认证时查找 last_channel 但不在断连时保存。

### 9.6 Channel Ninja

高级可见性控制 (可选功能):
- 配置 ninja_channels 列表
- ninja 频道中的用户仅对有权限的用户可见
- fullSync 根据每用户可见性过滤
- 状态广播根据可见性过滤

### 影响范围

- `munode-hub/src/rpc_handler.rs` - 权限检查、suppress 计算、last_channel 保存
- `munode-hub/src/session_manager.rs` - 监听频道追踪
- `munode-edge/src/server.rs` - 状态验证
- 依赖 ACL 系统 (01)
