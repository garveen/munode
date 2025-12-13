# Hub-Edge 连接池与重连机制

## 概述

本文档描述了 MuNode 中 Hub 和 Edge 服务器之间的连接池和延迟清理机制的实现。

## 背景

原有系统使用单个 WebSocket 连接进行 Hub-Edge 通信。当连接断开时，Hub 会立即清理 Edge 的所有会话数据，导致短暂的网络波动就会造成所有客户端断开。

## 改进目标

1. **连接池**：使用多个 WebSocket 连接提高可靠性
2. **延迟清理**：给 Edge 重连一个宽限期，避免瞬时故障导致会话丢失
3. **冷启动**：当会话已被清理时，Edge 执行完整的冷启动流程

## 架构设计

### 连接池（Connection Pool）

#### 核心特性

- **多连接管理**：默认维护 2 个 WebSocket 连接
- **独立处理**：每个连接独立接收和处理消息，保证时序
- **负载均衡**：发送时使用 Round-robin 选择可用连接
- **自动重连**：单个连接断开时自动重连，不影响其他连接
- **池状态**：只要有一个连接存活，池就处于"已连接"状态

#### 实现类：ConnectionPool

```typescript
class ConnectionPool extends EventEmitter {
  // 配置
  private config: {
    host: string;
    port: number;
    poolSize: number;     // 默认 2
    reconnectInterval: number;  // 基础重连间隔，默认 5000ms
  };
  
  // 连接列表
  private connections: PooledConnection[];
  
  // 关键方法
  async connect(): Promise<void>
  async call(method, request): Promise<response>
  notify(method, params): void
  isConnected(): boolean
  getStats(): ConnectionStats
}
```

#### 重连策略

使用**指数退避算法**避免过载：
- 第 1 次重连：5 秒后
- 第 2 次重连：10 秒后
- 第 3 次重连：20 秒后
- 第 4 次重连：40 秒后
- 第 5+ 次重连：60 秒后（上限）

公式：`delay = min(baseInterval * 2^(attempts-1), 60000)`

### Hub 延迟清理

#### 连接状态管理

定义三种 Edge 连接状态：

```typescript
enum EdgeConnectionState {
  CONNECTED = 'connected',              // 正常连接
  DISCONNECTED_WAITING = 'disconnected_waiting',  // 等待重连
  DISCONNECTED_TIMEOUT = 'disconnected_timeout',  // 超时已清理
}
```

#### 状态转换流程

```
CONNECTED
    |
    | Edge 断开
    v
DISCONNECTED_WAITING
    |
    +--> [宽限期内重连] --> CONNECTED (会话恢复)
    |
    +--> [超时] --> DISCONNECTED_TIMEOUT --> 清理会话
```

#### 关键实现

**Registry.handleEdgeDisconnect()**
```typescript
handleEdgeDisconnect(edgeId: number, onCleanup: Function): void {
  const edge = this.edges.get(edgeId);
  
  // 设置状态和时间戳
  edge.connectionState = EdgeConnectionState.DISCONNECTED_WAITING;
  edge.disconnectedAt = Date.now();
  
  // 设置清理定时器（默认 30 秒）
  edge.cleanupTimer = setTimeout(() => {
    edge.connectionState = EdgeConnectionState.DISCONNECTED_TIMEOUT;
    onCleanup(edgeId);  // 清理会话、通知其他 Edge
    this.unregister(edgeId);
  }, this.config.edgeReconnectGracePeriod);
}
```

**Registry.register() - 处理重连**
```typescript
async register(request: RegisterRequest): Promise<RegisterResponse> {
  const existingEdge = this.edges.get(serverId);
  
  if (existingEdge.connectionState === EdgeConnectionState.DISCONNECTED_WAITING) {
    // 宽限期内重连 - 恢复会话
    clearTimeout(existingEdge.cleanupTimer);
    existingEdge.connectionState = EdgeConnectionState.CONNECTED;
    return { success: true, reconnected: true, ... };
  }
  
  if (existingEdge.connectionState === EdgeConnectionState.DISCONNECTED_TIMEOUT) {
    // 会话已清理 - 拒绝重连
    return { 
      success: false, 
      session_expired: true,
      error: 'Session timeout - cold restart required'
    };
  }
  
  // 正常注册流程...
}
```

### Edge 冷启动

#### 触发条件

当 Edge 尝试重连但收到 `session_expired: true` 响应时触发。

#### 冷启动流程

```typescript
async handleSessionExpired(): Promise<void> {
  // 1. 断开所有客户端（并行处理）
  const clients = this.clientManager.getAllClients();
  await Promise.all(
    clients.map(client => disconnectClient(client))
  );
  
  // 2. 清理本地状态
  for (const client of remainingClients) {
    this.clientManager.removeClient(client.session);
  }
  
  // 3. 重新加入集群
  await this.clusterManager.joinCluster();
}
```

#### 事件流

```
Edge 尝试注册
    |
    v
Hub 检查状态: DISCONNECTED_TIMEOUT
    |
    v
返回 { success: false, session_expired: true }
    |
    v
Edge 触发 'session-expired' 事件
    |
    v
EdgeServer.handleSessionExpired()
    |
    +-> 断开所有客户端
    +-> 清理本地状态
    +-> 重新加入集群
```

## 配置

### Edge 配置 (config/edge.json)

```json
{
  "hubServer": {
    "host": "localhost",
    "controlPort": 8443,
    "poolSize": 2,  // 连接池大小，默认 2
    "reconnectInterval": 5000,  // 基础重连间隔（毫秒）
    "reconnectionTimeout": 30000  // 参考值，实际由 Hub 控制
  }
}
```

### Hub 配置 (config/hub.json)

```json
{
  "registry": {
    "edgeReconnectGracePeriod": 30000  // Edge 断开后的宽限期（毫秒）
  }
}
```

## 使用示例

### 启用连接池（默认行为）

```typescript
// Edge 配置
const config: EdgeConfig = {
  hubServer: {
    poolSize: 2,  // 使用 2 个连接
  }
};
```

### 禁用连接池（单连接模式）

```typescript
// Edge 配置
const config: EdgeConfig = {
  hubServer: {
    poolSize: 1,  // 单连接，向后兼容
  }
};
```

### 调整宽限期

```typescript
// Hub 配置
const config: HubConfig = {
  registry: {
    edgeReconnectGracePeriod: 60000,  // 60 秒宽限期
  }
};
```

## 监控和调试

### 连接池统计

```typescript
const stats = controlClient.getConnectionStats();
console.log(stats);
// {
//   poolSize: 2,
//   connectedCount: 2,
//   reconnectingCount: 0,
//   totalReconnectAttempts: 0
// }
```

### 日志关键字

**连接池事件：**
- `Initializing connection pool with N connections`
- `Connection N established`
- `Connection N closed`
- `Scheduling reconnect for connection N (attempt X) in Yms`

**Hub 延迟清理：**
- `Edge Server X disconnected, waiting 30000ms for reconnection...`
- `Edge Server X reconnected within grace period`
- `Edge Server X reconnection timeout, cleaning up sessions...`

**Edge 冷启动：**
- `=== Session expired on Hub, performing cold restart ===`
- `Disconnecting all clients...`
- `Clearing local state...`
- `Rejoining cluster with cold start...`
- `=== Cold restart completed successfully ===`

## 测试验证

### 集成测试覆盖

1. **hub-restart.test.ts**
   - 验证 Hub 重启后 Edge 重连
   - 确认延迟清理机制工作

2. **edge-connection-user-sync.test.ts**
   - 验证用户状态同步
   - 多 Edge 场景测试

3. **voice.test.ts**
   - 验证语音路由不受影响

4. **auth.test.ts**
   - 验证认证流程正常

### 手动测试场景

#### 场景 1：短暂网络中断

```bash
# 1. 启动 Hub 和 Edge
# 2. 连接客户端
# 3. 模拟网络中断（iptables 或断开 WebSocket）
# 4. 在 30 秒内恢复网络
# 预期：Edge 重连成功，客户端会话保持
```

#### 场景 2：长时间网络中断

```bash
# 1. 启动 Hub 和 Edge
# 2. 连接客户端
# 3. 模拟网络中断
# 4. 等待 > 30 秒
# 5. 恢复网络
# 预期：Edge 冷启动，客户端被断开
```

#### 场景 3：单个连接故障

```bash
# 1. 启动带连接池的 Edge（poolSize=2）
# 2. 手动关闭一个 WebSocket 连接
# 预期：另一个连接继续工作，断开的连接自动重连
```

## 性能影响

### 连接池开销

- **内存**：每个连接约增加 100KB 内存（WebSocket + 缓冲区）
- **CPU**：可忽略不计
- **带宽**：心跳消息翻倍（但总量很小）

### 延迟清理影响

- **内存**：断开期间保留 Edge 和会话数据
- **清理延迟**：最多 30 秒（可配置）
- **重连成功率**：显著提高，避免频繁冷启动

### 冷启动开销

- **时间**：取决于客户端数量，通常 1-5 秒
- **客户端体验**：所有客户端需要重新连接

## 故障排查

### 问题：Edge 频繁重连

**症状**：日志中大量 "Scheduling reconnect" 消息

**可能原因**：
1. Hub 服务器不可达
2. 认证失败（HMAC 配置错误）
3. 证书问题

**解决方法**：
1. 检查 Hub 服务器状态
2. 验证 `hmacSecret` 配置一致
3. 检查 TLS 证书有效性

### 问题：会话意外清理

**症状**：客户端在短暂中断后被断开

**可能原因**：
1. `edgeReconnectGracePeriod` 设置过短
2. 连接池未启用（单连接模式）
3. 所有连接同时断开

**解决方法**：
1. 增加宽限期到 60 秒
2. 启用连接池（poolSize >= 2）
3. 检查网络稳定性

### 问题：冷启动失败

**症状**：Edge 无法重新加入集群

**可能原因**：
1. Hub 仍在清理过程中
2. 注册失败（认证、配置问题）
3. 资源耗尽（端口、文件描述符）

**解决方法**：
1. 等待 Hub 完成清理
2. 检查认证配置
3. 检查系统资源限制

## 最佳实践

### 生产环境建议

1. **启用连接池**：`poolSize: 2` 或更多
2. **适当的宽限期**：`edgeReconnectGracePeriod: 30000` (30秒)
3. **监控指标**：
   - 连接池健康状态
   - 重连频率
   - 冷启动次数
4. **告警设置**：
   - 连接池所有连接断开
   - 频繁冷启动（> 1次/小时）
   - 重连失败率 > 10%

### 开发环境配置

```json
{
  "hubServer": {
    "poolSize": 1,  // 简化调试
    "reconnectInterval": 2000  // 更快的重连测试
  },
  "registry": {
    "edgeReconnectGracePeriod": 10000  // 更短的等待时间
  }
}
```

## 向后兼容性

- 设置 `poolSize: 1` 完全向后兼容
- 不配置 `edgeReconnectGracePeriod` 使用 30 秒默认值
- 现有配置文件无需修改即可工作

## 未来改进

### 可能的增强

1. **动态连接池大小**：根据负载自动调整
2. **智能重连**：根据失败原因选择策略
3. **连接健康检查**：主动探测连接质量
4. **优雅降级**：连接池部分故障时降低服务质量而非完全断开

### 性能优化

1. **批量消息**：多个连接上批量发送以减少开销
2. **压缩支持**：启用 WebSocket 压缩扩展
3. **连接复用**：更高效的消息路由算法

## 相关文档

- [Hub-Edge 通信协议](./hub-edge-protocol.md)
- [集群架构设计](./cluster-architecture.md)
- [故障恢复指南](./disaster-recovery.md)

## 版本历史

- **v0.1.0** (2025-12): 初始实现
  - 连接池基础功能
  - 延迟清理机制
  - 冷启动流程
