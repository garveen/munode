# 移除会话持久化

## 修改日期
2025-11-20

## 修改原因
Hub 服务端不应该持久化用户会话列表。重启后所有用户连接都已断开，持久化的会话数据已经无效，所有用户都需要重新登录。

## 修改内容

### 1. session-manager.ts
- 移除 `HubDatabase` 依赖
- `reportSession()` 不再调用 `database.saveSession()`
- `updateSessionChannel()` 不再调用 `database.updateSessionChannel()`
- `removeSession()` 不再调用 `database.deleteSession()`
- `cleanup()` 不再调用 `database.cleanup()`
- 添加注释说明会话仅保存在内存中

### 2. hub-server.ts
- 创建 `GlobalSessionManager` 时不再传递 database 参数
- `loadPersistentData()` 方法不再加载会话数据
- `loadPersistentData()` 方法不再加载 VoiceTarget 数据（也是运行时状态）
- 添加注释说明重启后用户需要重新登录

### 3. control-service.ts
- `handleFullSync()` 方法从 `sessionManager` 获取活跃会话，而不是从数据库
- 添加注释说明返回的是当前运行时的活跃会话

## 影响范围

### 行为变更
- **Hub 重启后**：所有用户会话丢失，用户需要重新连接和认证
- **VoiceTarget 配置**：重启后丢失，用户需要重新配置
- **Edge 全量同步**：`edge.fullSync` 只返回当前活跃的会话，而不是历史会话

### 保留功能
- 会话的内存管理（运行时状态跟踪）
- 会话 ID 分配
- 频道/用户会话索引
- 会话查询和管理 API

### 数据库影响
- `sessions` 表的相关方法 (`saveSession`, `deleteSession`, `getAllSessions`) 保留在数据库层，但不再被调用
- 可以考虑将这些方法用于未来的审计日志功能
- 或者在后续清理中完全移除这些方法和表

## 设计原则
- **运行时状态不持久化**：会话、VoiceTarget 等运行时状态只存在于内存中
- **持久化配置和数据**：频道、ACL、权限组、封禁等配置和管理数据继续持久化
- **重启即清空**：所有用户连接状态在服务重启时清空，符合预期行为

## 后续考虑
1. 可以考虑移除 database.ts 中不再使用的会话相关方法
2. 可以考虑在 cleanup() 中也清理 Edge 服务器的过期注册
3. 考虑添加会话活动监控（如最后活跃时间）以便更好地管理内存
