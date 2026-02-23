# 06 - 集群管理与拓扑

## 状态: ❌ 未实现

当前 Hub 接受多个 Edge 连接但没有集群协调逻辑。

## 当前实现

- Hub 接受多个 Edge WebSocket 连接
- Hub 在 fullSync 中发送所有频道和远程用户
- Hub 广播消息到所有 Edge
- 无 peer-to-peer 协调，无网络拓扑管理

## 目标功能

### 集群加入流程

```
Edge → Hub: edge.join { server_id, name, host, port, cert_hash, cold_restart }
Hub → Edge: { peers: [{ edge_id, host, port, cert_hash }] }
Edge → Hub: edge.joinComplete { }
Hub → 其他 Edge: hub.peerJoined { edge_id, host, port, cert_hash }
```

### 拓扑管理

```rust
// 新文件: munode-hub/src/topology_manager.rs

struct TopologyManager {
    edges: HashMap<u32, EdgeInfo>,
    link_quality: HashMap<(u32, u32), LinkQuality>,
}

struct LinkQuality {
    rtt_ms: f64,
    packet_loss: f64,
    jitter_ms: f64,
    samples: u32,
    last_update: Instant,
}

impl TopologyManager {
    /// 报告链路质量
    fn report_quality(&mut self, from: u32, to: u32, quality: LinkQuality);
    
    /// 查找两个 Edge 间的最优路径 (Dijkstra)
    fn find_best_path(&self, from: u32, to: u32) -> Vec<u32>;
    
    /// 检测网络分区 (Union-Find)
    fn detect_partitions(&self) -> Vec<HashSet<u32>>;
    
    /// 处理 Edge 断连仲裁
    fn arbitrate_disconnect(&self, edge_a: u32, edge_b: u32) -> ArbitrationResult;
}
```

### RPC 方法

| RPC | 方向 | 说明 |
|-----|------|------|
| `edge.join` | Edge→Hub | 加入集群 |
| `edge.joinComplete` | Edge→Hub | 加入完成确认 |
| `edge.reportPeerDisconnect` | Edge→Hub | 报告 peer 断连 |
| `edge.reportQuality` | Edge→Hub | 链路质量报告 |
| `cluster.getStatus` | Edge→Hub | 获取集群状态 |
| `edge.connectionFailure` | Edge→Hub | 连接失败通知 |
| `edge.reconnectFailure` | Edge→Hub | 重连失败通知 |

### Edge 间通信

- 证书交换: `edge.exchangeCertificates`
- 语音 TCP 中继: `edge.relayVoiceViaTcp` (Hub 转发，当 Edge 间 UDP 不通时)
- 直连 UDP: Edge 间直接 UDP 语音转发 (可选)

### 影响范围

- 新建 `munode-hub/src/topology_manager.rs`
- `munode-hub/src/rpc_handler.rs` - 新增集群 RPC
- `munode-hub/src/server.rs` - Edge 断连时更新拓扑
- `munode-edge/src/hub_client.rs` - 集群加入流程
