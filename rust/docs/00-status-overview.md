# MuNode Rust 实现状态总览

> 最后更新: 2026-02-23

## 架构概述

```
┌─────────────────────────────────────────────────────┐
│                    Mumble 客户端                     │
│        (TLS TCP + UDP 语音 → Edge 服务器)            │
└──────────────────┬──────────────────────────────────┘
                   │
      ┌────────────┴────────────┐
      │                         │
   ┌──▼───────────────┐   ┌────▼──────────────┐
   │  Edge Server 1   │   │  Edge Server 2    │
   │ (Rust/Tokio)     │   │ (Rust/Tokio)      │
   │ TLS + UDP        │   │ TLS + UDP         │
   │ 客户端管理       │   │ 客户端管理        │
   │ 频道缓存         │   │ 频道缓存          │
   └────────┬─────────┘   └────────┬──────────┘
            │ WebSocket (protobuf) │
            └──────────┬───────────┘
                       │
            ┌──────────▼──────────┐
            │   Hub Server        │
            │  (Rust/Tokio)       │
            │ 会话管理            │
            │ 频道树 + ACL        │
            │ SQLite 持久化       │
            └─────────────────────┘
```

## Crate 结构

| Crate | 状态 | 说明 |
|-------|------|------|
| `munode-protocol` | ✅ 完成 | Protobuf 类型定义、消息帧编解码、UDP 语音头 |
| `munode-common` | ✅ 完成 | 配置、日志、错误类型 |
| `munode-edge` | 🔶 基本完成 | Mumble 协议前端，缺语音加密、高级用户状态权限检查 |
| `munode-hub` | 🔶 基本完成 | 中心协调，缺集群管理、Blob存储、高级用户状态 |

## 已实现功能

### Edge Server ✅
- TLS 客户端连接接受
- Mumble 登录流程 (Version → Authenticate → CryptSetup → CodecVersion → ChannelState → UserState → ServerSync → ServerConfig)
- Hub WebSocket 连接 (protobuf RPC)
- Hub 注册 (HMAC 挑战-应答)
- 心跳循环
- 用户认证 (edge.authenticateUser RPC)
- 完整同步 (edge.fullSync RPC)
- 会话 ID 分配 (edge.allocateSessionId RPC)
- 客户端管理器 (广播/频道广播/定向发送)
- 频道管理器 (BFS 遍历，远程用户追踪)
- UserState 处理和广播
- TextMessage 路由 (会话/频道/频道树目标)
- UDPTunnel 语音路由 (TCP 回退)
- VoiceTarget 处理和同步
- PermissionQuery 转发
- UserStats 基本响应
- CryptSetup 同步
- UserRemove 转发 (踢出/封禁)
- ChannelState 转发 (创建/编辑)
- ChannelRemove 转发
- ✅ BanList 查询/更新 (通过 Hub RPC)
- QueryUsers 处理
- RequestBlob 处理 (频道描述)
- Hub 事件监听器 (远程用户/频道变更广播)
- Hub 文字消息转发
- ✅ ACL 消息处理 (查询/更新通过 Hub RPC)
- ✅ PluginDataTransmission 处理 (本地 + 跨 Edge 路由)
- ✅ Hub pluginDataBroadcast 事件处理

### Hub Server ✅
- WebSocket 服务器接受 Edge 连接
- Edge 连接处理器 (RPC 分发，心跳确认)
- 会话管理器 (原子 ID 分配，会话注册表)
- 频道存储 (内存树 + BFS + CRUD + 链接管理)
- SQLite 数据库 (users, channels, channel_links, acls, bans 表)
- RPC: edge.register (HMAC)
- RPC: edge.allocateSessionId
- RPC: edge.authenticateUser (访客 + 密码模式)
- RPC: edge.fullSync
- ✅ RPC: edge.handlePermissionQuery (基于 ACL 权限计算)
- RPC: edge.syncVoiceTarget
- RPC: edge.saveChannel
- ✅ RPC: edge.handleACL (查询/更新 + ACL 变更广播)
- ✅ RPC: edge.saveACL (类型化 ACL 条目保存)
- ✅ RPC: edge.getBanList (数据库查询)
- ✅ RPC: edge.updateBanList (批量替换)
- 通知处理: handleUserLeft, handleUserRemove, handleUserMoved, handleUserStateChanged
- ✅ 通知处理: handlePluginDataTransmission (跨 Edge 路由)
- 文字消息转发 (跨 Edge)
- 频道状态通知 (hub.channelUpdated)
- 频道删除通知 (hub.channelRemoved)
- ✅ 用户断连时保存 last_channel
- 广播: 全部/特定/排除 Edge
- 优雅关闭

### ACL 权限系统 ✅
- 权限位定义 (Write, Traverse, Enter, Speak, MuteDeafen, Move, MakeChannel, LinkChannel, Whisper, TextMessage, TempChannel, Listen, Kick, Ban, Register, SelfRegister)
- 默认权限: Traverse + Enter + Speak + Whisper + TextMessage + Listen
- 频道继承: 父→子 ACL 链, inherit_acl 开关
- 用户组匹配: @all, @auth, 自定义组
- apply_here / apply_subs 作用域控制
- Write 隐含大多数权限
- Traverse 门控 (无 Traverse+Write = 无访问)
- 权限缓存 + 失效机制
- 超级用户 (admin/superuser 组) 获得所有权限

### 封禁管理 ✅
- 封禁记录: IP 地址 (16字节 IPv4/IPv6) + 掩码 + 证书哈希 + 原因 + 时间 + 持续时间
- 数据库 CRUD: 加载/添加/批量替换/过期清理
- Hub RPC 查询和更新

## 未实现功能

参见各功能的详细概设文档:

| # | 功能 | 优先级 | 状态 | 文档 |
|---|------|--------|------|------|
| 1 | ACL 权限系统 | P0 | ✅ 已实现 | [01-acl-permission-system.md](01-acl-permission-system.md) |
| 2 | OCB2-AES128 语音加密 | P0 | ❌ 未实现 | [02-voice-encryption.md](02-voice-encryption.md) |
| 3 | Blob 存储服务 | P1 | ❌ 未实现 | [03-blob-storage.md](03-blob-storage.md) |
| 4 | 封禁管理系统 | P1 | ✅ 已实现 | [04-ban-management.md](04-ban-management.md) |
| 5 | 用户密码认证 | P1 | 🔶 部分实现 | [05-user-authentication.md](05-user-authentication.md) |
| 6 | 集群管理与拓扑 | P2 | ❌ 未实现 | [06-cluster-management.md](06-cluster-management.md) |
| 7 | 高级消息处理 | P2 | 🔶 PluginData已实现 | [07-advanced-message-handling.md](07-advanced-message-handling.md) |
| 8 | Edge 健康监控 | P2 | ❌ 未实现 | [08-edge-health-monitoring.md](08-edge-health-monitoring.md) |
| 9 | 高级用户状态管理 | P2 | 🔶 部分实现 | [09-advanced-user-state.md](09-advanced-user-state.md) |

## 测试状态

- Protocol transport: 3 测试 ✅
- Edge client manager: 6 测试 ✅
- Edge handler: 5 测试 ✅
- Edge channel manager: 4 测试 ✅
- Hub session manager: 4 测试 ✅
- Hub channel store: 5 测试 ✅
- Hub database: 5 测试 ✅
- Hub ACL manager: 11 测试 ✅
- **总计: 42 测试通过, 0 警告**
