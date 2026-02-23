# 08 - Edge 健康监控

## 状态: ✅ 已实现

Hub 接收心跳但不检测超时或清理断连 Edge。

## 当前实现

- Edge 发送 Heartbeat，Hub 回复 HeartbeatAck
- Hub 不追踪 Edge 最后心跳时间
- Edge 断连时 WebSocket 关闭触发 cleanup_edge
- 无主动健康检查

## 目标功能

### 心跳超时检测

```rust
// 在 HubState 中追踪
struct EdgeHealth {
    edge_id: u32,
    last_heartbeat: Instant,
    user_count: u32,
    channel_count: u32,
    cpu_usage: f32,
    memory_usage: f32,
    bandwidth_usage: f32,
}

// Hub 定期检查 (每 heartbeat_timeout / 2 秒)
async fn health_check_loop(state: Arc<HubState>) {
    loop {
        let now = Instant::now();
        let timeout = Duration::from_secs(state.config.heartbeat_timeout * 2);
        
        for (edge_id, health) in state.edge_health.read().await.iter() {
            if now.duration_since(health.last_heartbeat) > timeout {
                warn!("Edge {} heartbeat timeout", edge_id);
                // 触发 Edge 清理流程
                cleanup_edge(state.clone(), *edge_id).await;
            }
        }
        
        tokio::time::sleep(Duration::from_secs(state.config.heartbeat_timeout)).await;
    }
}
```

### 心跳数据扩展

```
Edge → Hub: Heartbeat { 
    user_count, channel_count,
    cpu_usage, memory_usage, bandwidth_usage,
    uptime_seconds
}
Hub → Edge: HeartbeatAck { server_time }
```

### Edge 断连清理

1. 检测到 Edge 超时/断连
2. 获取该 Edge 的所有会话
3. 广播 UserRemove 到其他 Edge (批量)
4. 从 SessionManager 删除所有相关会话
5. 从 Edge 注册表移除
6. 更新拓扑 (如果有集群管理)
7. 日志记录

### 影响范围

- `munode-hub/src/server.rs` - 启动健康检查定时器
- `munode-hub/src/rpc_handler.rs` - 更新心跳处理，记录统计
- `munode-hub/src/session_manager.rs` - 批量删除 Edge 会话
- `munode-edge/src/hub_client.rs` - 心跳发送增加统计数据
