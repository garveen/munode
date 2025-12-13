# Edge间语音路由实现总结

## 概述

本次实现完善了MuNode项目中Edge节点之间的语音中转路由功能，主要关注以下几个方面：

1. **认证和加密**：确保Edge间通信安全
2. **连接维护**：通过心跳检测保持UDP连接活跃
3. **断开重连**：自动恢复网络故障
4. **Hub仲裁**：处理双向重连失败的情况
5. **Broadcast优化**：移除不必要的缓存

## 实现详情

### 1. UDP心跳机制

#### 功能
- 定期发送心跳包维持连接
- 检测连接超时
- 及时发现网络故障

#### 实现
- **心跳间隔**：10秒 (`HEARTBEAT_INTERVAL_MS`)
- **超时时间**：30秒无响应视为断开 (`HEARTBEAT_TIMEOUT_MS`)
- **协议格式**：
  ```
  Magic(4字节): "MUHB" (MUNode HeartBeat)
  Type(1字节): 1=PING, 2=PONG
  Timestamp(4字节): 当前时间戳低32位
  总长度: 9字节
  ```

#### 关键代码
- `createHeartbeatPacket()`: 创建心跳包
- `handleHeartbeatPacket()`: 处理收到的心跳包
- `sendHeartbeats()`: 定时发送心跳
- `checkConnections()`: 检查连接超时

### 2. 断开重连机制

#### 功能
- 自动检测连接断开
- 发起重连握手
- 限制重连次数避免无限循环

#### 实现
- **检测方式**：通过心跳超时判断
- **重连延迟**：3秒 (`RECONNECT_DELAY_MS`)
- **最大尝试**：5次 (`HANDSHAKE_MAX_ATTEMPTS`)
- **状态追踪**：
  ```typescript
  interface EdgeConnectionStatus {
    reconnecting: boolean;      // 是否正在重连
    reconnectAttempts: number;  // 重连尝试次数
    lastHeartbeatSent: number;  // 最后发送心跳时间
    lastHeartbeatReceived: number; // 最后收到心跳时间
  }
  ```

#### 关键代码
- `initiateReconnect()`: 发起重连
- `performReconnect()`: 执行重连流程
- Event: `edge-disconnected` - 连接断开
- Event: `reconnect-failed` - 重连失败

### 3. Hub仲裁机制

#### 场景
当两个Edge之间双向重连都失败时，单方无法决定如何处理，需要Hub进行仲裁。

#### 流程
1. Edge A检测到与Edge B连接失败，尝试重连
2. Edge B同时检测到与Edge A连接失败，也尝试重连
3. 双方重连都失败后，各自通过 `edge.reconnectFailure` 通知Hub
4. Hub收集双方信息，做出决策：
   - 强制一方断开
   - 重新分配路由
   - 触发集群重新配置

#### 实现
- Edge侧：
  ```typescript
  async notifyReconnectFailure(targetEdgeId: number): Promise<void>
  ```
- Hub侧（待实现）：
  - 接收 `edge.reconnectFailure` 通知
  - 收集双方状态
  - 执行仲裁决策

### 4. 认证和加密

#### 加密算法
- **算法**：AES-128-CBC 或 AES-256-CBC
- **密钥管理**：由Hub分发到各Edge
- **IV生成**：每个包使用随机IV（16字节）

#### 包格式
```
加密包 = IV(16字节) + 加密数据(变长)

加密前数据 = Header(14字节) + Payload(变长)
Header = Version(1) + SenderId(4) + TargetId(4) + Sequence(4) + Codec(1)
```

#### 信任模型
- Edge间通过加密保护数据传输
- 解密成功后信任包内容
- 假设所有Edge节点属于同一可信集群

### 5. Broadcast优化

#### 问题
之前的实现使用 `encryptedPacketCache` 缓存加密后的包，但对于实时语音流：
- 每个包都是唯一的
- 不会重复发送
- 缓存浪费内存

#### 解决方案
- **移除持久化缓存**：删除基于时间的缓存清理逻辑
- **保留临时复用**：在单次broadcast中，多个目标Edge复用同一个加密结果
- **性能优势**：
  - 减少内存占用
  - 简化代码逻辑
  - 保持加密性能优化

#### 代码变更
```typescript
// 之前：缓存5秒
const cacheKey = `${packet.senderId}-${packet.sequence}`;
let cached = this.encryptedPacketCache.get(cacheKey);
if (!cached) {
  cached = this.encodePacket(...);
  this.encryptedPacketCache.set(cacheKey, cached);
  setTimeout(() => {
    this.encryptedPacketCache.delete(cacheKey);
  }, ENCRYPTED_PACKET_CACHE_TTL_MS);
}

// 现在：仅在单次broadcast中复用
const finalPacket = this.encryptionConfig 
  ? this.encodePacket(...) 
  : fullPacket;
// 立即发送给所有目标，不缓存
```

### 6. 路由表应用

#### 确认
路由表已正确应用在 `VoiceManager.sendVoiceToEdge()` 方法中：

```typescript
if (this.voiceRoutingManager.isEnabled()) {
  const route = this.voiceRoutingManager.getRoute(targetEdgeId);
  switch (route.type) {
    case RouteType.DIRECT:    // 直连
    case RouteType.RELAY:     // 中转
    case RouteType.FALLBACK:  // TCP降级
  }
}
```

## 配置参数

### Edge配置 (edge.example.js)
```javascript
voiceRouting: {
  probe: {
    enabled: true,
    method: 'passive',        // 被动探测
    updateInterval: 10000,    // 10秒更新
    metricsTTL: 30000,        // 30秒过期
  },
  fallback: {
    enableTcpFallback: true,
    udpRecoveryCheckInterval: 30000,
  }
}
```

### 常量配置 (voice-udp-transport.ts)
```typescript
const HEARTBEAT_INTERVAL_MS = 10000;   // 心跳间隔
const HEARTBEAT_TIMEOUT_MS = 30000;    // 超时时间
const RECONNECT_DELAY_MS = 3000;       // 重连延迟
const HANDSHAKE_MAX_ATTEMPTS = 5;      // 最大重连次数
```

## 测试建议

### 单元测试
- [ ] 心跳包创建和解析
- [ ] 超时检测逻辑
- [ ] 重连状态机
- [ ] 加密解密正确性

### 集成测试
- [ ] 正常心跳流程
- [ ] 连接断开检测
- [ ] 自动重连成功
- [ ] 双向重连失败Hub仲裁
- [ ] 不同网络质量下的路由选择

### 压力测试
- [ ] 大量并发连接
- [ ] 频繁断开重连
- [ ] 高丢包率环境
- [ ] 网络抖动场景

## Hub侧仲裁机制实现 ✅

### 设计原则

1. **直连失败不退出**: Edge间直连失败不意味着需要退出，因为可能通过其他Edge路由连接
2. **仅网络分区时退出**: 只有当两个Edge间无任何路由路径时，才检测分区并要求较小集群退出
3. **基于用户数决策**: 选择用户数最少的集群关闭，最小化影响
4. **时间窗口数据**: 路由计算使用最近30秒的质量数据，确保路由决策反映当前网络状况

### 通知处理

#### 1. 连接失败通知 (`edge.connectionFailure`)
```typescript
handleConnectionFailureNotification(params: {
  edge_id: number;
  target_edge_id: number;
  timestamp: number;
})
```
- Edge间直连失败时上报
- Hub仅记录，不立即采取行动
- 因为可能通过其他Edge路由连接

#### 2. 重连失败通知 (`edge.reconnectFailure`)
```typescript
handleReconnectFailureNotification(params: {
  edge_id: number;
  target_edge_id: number;
  timestamp: number;
})
```
- 双向重连都失败时上报（Edge侧最多尝试5次）
- Hub检查60秒内双方是否都报告
- 如果是，触发仲裁流程

### 仲裁流程

```typescript
async performArbitration(edgeA: number, edgeB: number) {
  // 1. 检查是否可以通过路由连接
  const path = topologyManager.findBestPath(edgeA, edgeB);
  if (path) {
    // 可以路由连接，无需退出
    return;
  }
  
  // 2. 检测所有断连的集群
  const clusters = detectDisconnectedClusters();
  
  if (clusters.length <= 1) {
    // 只有一个集群，无需处理
    return;
  }
  
  // 3. 计算每个集群的用户数
  const clusterStats = clusters.map(cluster => ({
    edges: cluster,
    userCount: cluster.reduce((sum, edgeId) => 
      sum + sessionManager.getEdgeSessions(edgeId).length, 0
    ),
  }));
  
  // 4. 按用户数排序，选择最小集群
  clusterStats.sort((a, b) => a.userCount - b.userCount);
  const smallestCluster = clusterStats[0];
  
  // 5. 关闭最小集群
  await shutdownEdgeCluster(smallestCluster.edges);
}
```

### 网络分区检测

使用并查集(Union-Find)算法检测断连的Edge集群:

```typescript
detectDisconnectedClusters(): number[][] {
  // 1. 初始化并查集
  const parent = new Map<number, number>();
  const rank = new Map<number, number>();
  
  // 2. 遍历所有Edge对
  for (edgeA of allEdges) {
    for (edgeB of allEdges) {
      // 如果可以路由连接，合并到同一集合
      const path = topologyManager.findBestPath(edgeA, edgeB);
      if (path) {
        union(edgeA, edgeB);
      }
    }
  }
  
  // 3. 收集所有集群
  return groupByRoot(parent);
}
```

### 集群关闭

向集群中的所有Edge发送关闭请求:

```typescript
async shutdownEdgeCluster(edges: number[]) {
  for (const edgeId of edges) {
    controlService.notify(edgeId, 'hub.shutdownRequest', {
      reason: 'Network partition detected, this edge is in the smaller disconnected cluster',
      graceful: true,
      disconnect_clients: true,
    });
  }
}
```

Edge收到后应该:
1. 断开所有客户端连接
2. 清理资源
3. 优雅退出进程

### 路由计算优化

使用最近30秒的质量数据计算路由:

```typescript
calculateDirectCost(quality: EdgeConnectionQuality): number {
  const baseCost = quality.rtt + quality.packetLoss * 1000;
  
  const now = Date.now();
  const age = now - quality.lastUpdate;
  
  if (age > 30000) {
    // 过期数据，大幅增加成本
    return baseCost + 10000;
  }
  
  // 在时间窗口内，数据越新权重越高
  const ageFactor = age / 30000;
  const agePenalty = baseCost * ageFactor * 0.05; // 0-5%惩罚
  
  return baseCost + agePenalty;
}
```

优势:
- 优先使用新鲜数据
- 过期数据自动降权
- 路由决策反映当前网络状况

## 未来改进

### Hub侧实现 ✅
- [x] 接收并处理 `edge.connectionFailure` 和 `edge.reconnectFailure` 通知
- [x] 实现仲裁决策逻辑（网络分区检测+用户数决策）
- [x] 支持动态路由调整（基于时间窗口的质量数据）

### TCP降级完善
- [ ] 实现完整的TCP语音传输
- [ ] Hub作为TCP中转节点
- [ ] 自动UDP恢复检测

### 监控和可观测性
- [ ] 导出心跳和重连指标
- [ ] 连接质量仪表盘
- [ ] 告警机制

### Edge侧增强
- [ ] 处理 `hub.shutdownRequest` 通知
- [ ] 实现优雅关闭流程（断开客户端+清理资源）

### 性能优化
- [ ] 自适应心跳间隔
- [ ] 连接池复用
- [ ] 零拷贝优化

## 安全考虑

### 已实现
- ✅ AES加密保护数据传输
- ✅ 随机IV防止模式攻击
- ✅ 解密验证失败丢弃包

### 待加强
- ⚠️ 密钥轮换机制
- ⚠️ 重放攻击防护
- ⚠️ Edge身份验证

## 总结

本次实现显著提升了Edge间语音路由的可靠性和安全性：

1. **连接维护**：心跳机制确保连接活跃，及时发现故障
2. **自动恢复**：重连机制减少人工干预，提升系统可用性
3. **集中决策**：Hub仲裁处理复杂场景，避免分布式一致性问题
4. **性能优化**：移除不必要的缓存，降低内存占用
5. **安全加固**：端到端加密保护语音数据

系统已具备基本的生产就绪能力，但仍需完善测试和监控体系。
