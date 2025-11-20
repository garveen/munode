# Edge 间语音包传输优化

## 优化内容

### 1. 精确的 Edge 目标选择

**之前的实现：**
- 向所有 Edge 广播语音包（使用 `broadcast` 方法）
- 无论目标频道是否有远程用户

**优化后的实现：**
- 追踪每个频道中有用户的 Edge 列表
- 只向有该频道用户的特定 Edge 发送（使用 `sendToEdge` 方法）
- 显著减少不必要的网络传输

### 2. 数据结构优化

**远程用户追踪：**
```typescript
// 用户 -> Edge 和频道的映射
remoteUsers: Map<number, { edge_id: number; channel_id: number }>

// 频道 -> Edge 集合的映射（关键优化）
channelRemoteUsers: Map<number, Set<number>>  // channel_id => Set<edge_id>
```

### 3. 智能广播逻辑

```typescript
// 获取该频道中有用户的 Edge 列表
const targetEdges = stateManager.getEdgesInChannel(channel_id);

// 只向这些 Edge 发送
for (const targetEdgeId of targetEdges) {
  voiceTransport.sendToEdge(targetEdgeId, voicePacket, voiceData);
}
```

## 带宽节省场景

### 场景 1: 用户分布不均
- **集群配置**: 3 个 Edge (A, B, C)
- **用户分布**: 
  - Edge A: 频道 1 有 10 个用户
  - Edge B: 频道 2 有 10 个用户
  - Edge C: 频道 3 有 10 个用户

**之前**: 频道 1 的语音包会广播到 Edge B 和 C（浪费 2/3 带宽）
**优化后**: 频道 1 的语音包不会发送到 Edge B 和 C（节省 2/3 带宽）

### 场景 2: 单 Edge 频道
- **集群配置**: 5 个 Edge
- **用户分布**: 某个频道的所有用户都在同一个 Edge

**之前**: 语音包会广播到其他 4 个 Edge（浪费 100% 跨 Edge 带宽）
**优化后**: 语音包不会发送到任何其他 Edge（节省 100% 跨 Edge 带宽）

### 场景 3: 跨 Edge 频道
- **集群配置**: 3 个 Edge (A, B, C)
- **用户分布**: 频道 1 在 Edge A 和 B 都有用户

**之前**: 语音包会广播到 Edge B 和 C
**优化后**: 语音包只发送到 Edge B（节省 1/2 带宽）

## 实现细节

### EdgeStateManager 新增方法

```typescript
// 添加远程用户时，记录其 Edge 和频道
addRemoteUser(session_id: number, edge_id: number, channel_id: number): void

// 移除远程用户时，检查该 Edge 在频道中是否还有其他用户
removeRemoteUser(session_id: number): void

// 更新用户频道时，正确维护 Edge 集合
updateRemoteUserChannel(session_id: number, new_channel_id: number): void

// 获取频道中有用户的 Edge 列表
getEdgesInChannel(channel_id: number): Set<number>

// 检查频道是否有远程用户
hasRemoteUsersInChannel(channel_id: number): boolean
```

### 状态维护

**用户加入时：**
```typescript
stateManager.addRemoteUser(session_id, edge_id, channel_id);
// channelRemoteUsers[channel_id] 添加 edge_id
```

**用户离开时：**
```typescript
stateManager.removeRemoteUser(session_id);
// 如果该 Edge 在此频道没有其他用户，从 channelRemoteUsers[channel_id] 移除 edge_id
```

**用户切换频道时：**
```typescript
stateManager.updateRemoteUserChannel(session_id, new_channel_id);
// 从旧频道的 Edge 集合移除（如果没有其他用户）
// 添加到新频道的 Edge 集合
```

## 日志输出

优化后的日志会显示：

```
Skip voice broadcast: no remote users in channel 1
Forwarded voice to 2 edges in channel 1: sender=5, codec=4, packet_size=104, targets=[2,3]
```

清楚地展示：
- 哪些广播被跳过（没有远程用户）
- 语音包发送到了哪些特定的 Edge
- 发送了多少个 Edge（而不是"所有 peers"）

## 性能影响

**内存开销**：
- 额外的 Map 结构：`channelRemoteUsers`
- 每个频道 O(E) 空间，E 为该频道涉及的 Edge 数量
- 总体可忽略不计

**CPU 开销**：
- 用户状态变更时需要检查 Edge 集合
- O(U) 复杂度，U 为该 Edge 在该频道的用户数
- 通常很小，可接受

**网络节省**：
- 大幅减少不必要的 UDP 传输
- 在用户分布不均的场景下效果显著
- 可节省 50%-90% 的跨 Edge 语音带宽

## 测试建议

1. **单频道测试**: 所有用户在同一频道，验证语音包正确路由
2. **多频道测试**: 用户分布在不同频道，验证只向相关 Edge 发送
3. **频道切换测试**: 用户在频道间移动，验证 Edge 集合正确更新
4. **边界情况**: Edge 在频道中的最后一个用户离开时，验证 Edge 从集合中移除
