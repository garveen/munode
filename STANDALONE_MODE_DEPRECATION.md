# 独立模式废弃说明

## 概述

Edge Server不再支持独立模式(standalone mode),必须在集群模式(cluster mode)下运行并连接到Hub Server。

## 更改日期

2025-11-20

## 背景

之前的架构支持两种模式:
1. **独立模式**: Edge自行处理所有业务逻辑(用户状态、频道管理、权限检查等)
2. **集群模式**: Edge转发控制消息到Hub,由Hub统一处理业务逻辑并广播

为了简化架构、保证数据一致性和便于扩展,决定仅保留集群模式。

## 架构变更

### 之前的流程(独立模式)
```
Client → Edge → 本地处理 → 本地广播
```

### 现在的流程(仅集群模式)
```
Client → Edge → Hub处理 → 广播到所有Edge → 转发给Client
```

## 代码更改

### 1. Hub中的业务逻辑实现

#### handleUserStateNotification (control-service.ts)
完整实现了UserState的业务逻辑:
- ✅ 频道移动权限检查
- ✅ Self Mute/Deaf状态控制及联动
  - SelfDeaf自动SelfMute
  - Un-SelfMute自动Un-SelfDeaf
- ✅ Mute/Deaf/Suppress/PrioritySpeaker管理员操作
  - Deaf自动Mute
  - Un-Mute自动Un-Deaf
  - Suppress只能由服务器设置
- ✅ Recording状态变化处理
- ✅ 防止actor!=target时应用self-fields
- ✅ 状态更新到SessionManager
- ✅ 响应机制(成功/失败)
- ✅ 广播到所有Edge

**TODO项**:
- [ ] 完整的ACL权限系统(目前使用简化的权限检查)
- [ ] 从数据库查询用户组和权限

#### handleChannelStateNotification (control-service.ts)
实现了ChannelState的核心业务逻辑:
- ✅ 频道创建
- ✅ 频道编辑(名称/描述/位置/最大用户数)
- ✅ 数据库持久化
- ✅ 响应机制
- ✅ 广播到所有Edge

**TODO项**:
- [ ] MakeChannel权限检查
- [ ] Write权限检查
- [ ] 同级频道名称重复检测
- [ ] 父频道移动及循环引用检测
- [ ] 频道链接管理(LinkChannel权限)
- [ ] ACL自动创建(创建者获得Write权限)
- [ ] 受影响频道的级联广播

#### handleUserRemoveNotification (control-service.ts)
实现了UserRemove的业务逻辑:
- ✅ Kick/Ban处理
- ✅ 会话移除
- ✅ 响应机制
- ✅ 广播到所有Edge

**TODO项**:
- [ ] Kick/Ban权限检查
- [ ] Ban数据库持久化

### 2. Edge中的更改

#### handleUserState (edge-server.ts)
- ✅ 移除了独立模式的fallback逻辑
- ✅ 增加了Hub连接检查
- ✅ 如果没有Hub连接,返回PermissionDenied
- ✅ 转发到Hub使用notify(不等待响应)

#### handleChannelState (edge-server.ts)
- ✅ 移除了独立模式的fallback逻辑
- ✅ 增加了Hub连接检查
- ✅ 如果没有Hub连接,返回PermissionDenied
- ✅ 转发到Hub使用notify

#### handleUserRemove (edge-server.ts)
- ✅ 移除了独立模式的fallback逻辑
- ✅ 增加了Hub连接检查
- ✅ 如果没有Hub连接,返回PermissionDenied
- ✅ 转发到Hub使用notify

#### handleUserStateLocal_DEPRECATED (edge-server.ts)
- ✅ 标记为`TODO_DELETE_STANDALONE`
- ✅ 添加`@ts-expect-error`忽略未使用警告
- ✅ 详细注释保留的业务逻辑供参考
- ⚠️ 暂时保留,待确认后删除

包含的业务逻辑:
- 频道移动权限检查 (Move/Enter Permission)
- Self Mute/Deaf 状态控制及联动
- Mute/Deaf/Suppress/PrioritySpeaker 管理员操作
- Recording 状态变化处理
- 状态广播给所有已认证客户端

#### handleChannelStateLocal_DEPRECATED (edge-server.ts)
- ✅ 标记为`TODO_DELETE_STANDALONE`
- ✅ 添加`@ts-expect-error`忽略未使用警告
- ✅ 详细注释保留的业务逻辑供参考
- ⚠️ 暂时保留,待确认后删除

包含的业务逻辑:
- 频道创建 (MakeChannel Permission)
- 频道编辑 (Write Permission) - 名称/描述/位置/最大用户数
- 频道移动 (Write + MakeChannel Permission)
- 频道链接管理 (LinkChannel Permission)
- ACL自动创建 (创建者获得Write权限)
- 循环引用检测
- 同级频道名称重复检测
- Hub数据库同步
- 受影响频道的级联广播

### 3. 其他地方的mode检查

以下代码仍然检查`config.mode === 'cluster'`:
- 构造函数中的集群组件初始化 (line 110)
- 用户离开通知 (line 993)
- StateManager相关 (lines 1042, 3093)
- handleChannelStateLocal_DEPRECATED内部 (lines 1813, 2075, 2112, 2238, 2461, 2532, 2926)
- 频道树发送 (line 3053)
- 集群管理器相关 (lines 3828, 3879)

**建议**:
- 可以保留这些检查以便在未初始化集群组件时优雅降级
- 或者在构造函数中强制要求mode='cluster'

## 配置要求

### 必需的配置
```json
{
  "mode": "cluster",
  "hubServer": {
    "host": "hub.example.com",
    "port": 8443,
    "controlPort": 8443,
    "tls": {
      "rejectUnauthorized": false
    },
    "connectionType": "websocket",
    "reconnectInterval": 5000,
    "heartbeatInterval": 10000
  }
}
```

### 不再支持
```json
{
  "mode": "standalone"  // ❌ 不再支持
}
```

## 迁移指南

如果你之前使用独立模式:

1. **部署Hub Server**
   ```bash
   cd packages/hub-server
   pnpm start
   ```

2. **更新Edge配置**
   ```json
   {
     "mode": "cluster",
     "hubServer": {
       "host": "your-hub-host",
       "port": 8443,
       "controlPort": 8443
     }
   }
   ```

3. **启动Edge Server**
   ```bash
   cd packages/edge-server
   pnpm start
   ```

4. **验证连接**
   - 检查Edge日志中的"Successfully registered with Hub"
   - 检查Hub日志中的"Edge X registered successfully"

## 待办事项

### 高优先级
- [ ] 在Hub中实现完整的ACL权限检查系统
- [ ] 实现频道链接管理逻辑
- [ ] 实现Ban数据库持久化
- [ ] 添加循环引用检测
- [ ] 添加同级频道名称重复检测

### 中优先级
- [ ] 在构造函数中添加mode检查,拒绝standalone模式启动
- [ ] 简化代码中的`config.mode === 'cluster'`检查
- [ ] 更新配置类型,移除standalone选项
- [ ] 更新文档

### 低优先级
- [ ] 删除handleUserStateLocal_DEPRECATED
- [ ] 删除handleChannelStateLocal_DEPRECATED
- [ ] 清理其他独立模式相关代码

## 测试清单

- [ ] 用户状态变更(频道移动、mute/deaf等)
- [ ] 频道创建
- [ ] 频道编辑
- [ ] 频道删除
- [ ] 用户踢出(kick)
- [ ] 用户封禁(ban)
- [ ] 权限拒绝的错误处理
- [ ] Hub响应机制
- [ ] 多Edge广播
- [ ] Edge断线重连

## 影响范围

### 受影响的功能
- ✅ 用户状态同步 - 已完成
- ✅ 频道管理 - 已完成
- ✅ Kick/Ban - 已完成
- ⚠️ ACL管理 - 需要完善
- ⚠️ 权限检查 - 需要完善

### 不受影响的功能
- ✅ 语音包转发(仍然在Edge本地处理)
- ✅ UDP加密
- ✅ 用户认证
- ✅ 证书验证

## 性能影响

### 优势
- ✅ 数据一致性保证(单一真相来源)
- ✅ 便于扩展和维护
- ✅ 状态集中管理

### 劣势
- ⚠️ 增加了Hub的负载
- ⚠️ 增加了一次网络往返(Edge → Hub → Edge)
- ✅ 语音包仍然在本地处理,不受影响

### 优化建议
- [ ] Hub使用批量广播
- [ ] Hub实现消息队列缓冲
- [ ] 考虑Hub水平扩展方案

## 回滚方案

如果需要回滚到支持独立模式:

1. 恢复`handleUserState`等方法中的fallback逻辑
2. 取消`handleUserStateLocal_DEPRECATED`的注释
3. 移除Hub连接强制检查
4. 恢复Git commit: [待添加]

## 相关文档

- [集群架构文档](./docs/10-数据同步架构.md)
- [Hub Server文档](./docs/04-中心服务器.md)
- [Edge Server文档](./docs/05-边缘服务器.md)

## 作者

- GitHub Copilot
- 日期: 2025-11-20
