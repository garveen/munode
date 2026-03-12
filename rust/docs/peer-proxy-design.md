# Peer Edge 控制信道中继设计文档

## 1. 背景

在 MuNode Hub-Edge 集群中，每个 Edge 需要与 Hub 维持一条 WebSocket 控制信道连接。
当 Edge 所在网络存在防火墙限制或网络分区时，Edge 可能无法直接连接 Hub，但可以通过
集群内其他 Edge 中继控制信道流量，从而实现完整的集群功能。

## 2. 设计原则

### 自动路由（与语音路由类比）

| 语音路由层 | 控制信道中继层 |
|---|---|
| 直连 UDP（Edge A → Edge C） | 直连 Hub WebSocket |
| Hub TCP 中继 | ——（Hub 不可达时无意义） |
| 三跳 UDP relay（A→B→C） | Peer relay（A 通过 B 连接 Hub） |
| `PeerRegistry` 存 UDP 地址 | `PeerRegistry` 存 relay_port |

**关键原则**：
- **无需 opt-in 标志**：每个 Edge 自动启动 relay 服务器
- **静态 + 动态 peer 发现**：静态配置用于 Hub 完全不可达时的启动引导，动态发现用于正常运行
- **对 Hub 完全透明**：relay 服务器在传输层转发，Hub 感知不到中继的存在

## 3. 架构

```
Edge A（无法直连 Hub）
    │  ws://edge-b:relay_port/
    ▼
Edge B（relay server — relay_server.rs）
    │  ws://hub:control_port/
    ▼
Hub（看到的是一条普通 WebSocket 连接）
```

每个 Edge 的 relay 服务器：
- 监听 `0.0.0.0:{relay_port}`（默认 `edge_port + 2`，可通过 `hub_server.relay_port` 配置）
- 对每个传入连接，向 Hub 开一条新 WebSocket 连接
- 双向透明转发所有二进制帧
- 单跳限制：不接受来自其他 relay 的链式转发

## 4. 配置

### Edge 配置（`edge.json` 中的 `hub_server` 段）

```json
{
  "hub_server": {
    "host": "hub.example.com",
    "control_port": 8443,
    "hmac_secret": "...",
    "relay_port": 0,          // 0 = 自动 (edge_port + 2)；可显式指定
    "static_peers": [         // 可选：Hub 完全不可达时的启动 peer 列表
      { "host": "10.0.0.2", "relay_port": 19335 },
      { "host": "10.0.0.3", "relay_port": 19336 }
    ]
  }
}
```

### 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `relay_port` | `u16` | `0` | relay 监听端口；`0` = 自动使用 `edge_port + 2` |
| `static_peers` | `[]` | `[]` | 静态 peer 列表，用于 Hub 不可达时的启动引导 |
| `static_peers[].host` | `string` | — | peer Edge 的主机名或 IP |
| `static_peers[].relay_port` | `u16` | — | peer Edge 的 relay 端口 |

## 5. 协议变更

### Protobuf 字段（tag 不变，向后兼容）

| 消息 | 字段 | Tag | 说明 |
|------|------|-----|------|
| `EdgeRegisterParams` | `relay_port` | 10 | Edge 注册时告知 Hub 自己的 relay 端口 |
| `HubClusterPeerJoinedParams` | `relay_port` | 5 | Hub 广播新 peer 时包含其 relay 端口 |
| `PeerInfoProto` | `relay_port` | 7 | `edge.join` 响应包含已有 peer 的 relay 端口 |

## 6. 连接回退逻辑

`hub_client.rs` 中的 `run_single_slot()` 实现：

```
loop:
  if direct_fail_count >= RELAY_FALLBACK_THRESHOLD (3):
    try_connect_via_relay():
      1. 遍历 static_peers（config 中配置）
      2. 遍历 dynamic_peers（从 hub.peerJoined 动态发现）
      3. 每个 peer: try_connect_via_url(ws://peer_host:relay_port/)
  else:
    try_connect_slot() → direct ws://hub:control_port/
```

当任意连接（直连或 relay）恢复正常后，`direct_fail_count` 重置，下一轮优先尝试直连 Hub。

## 7. 语音三跳 Relay 路由（补充实现）

在 `udp.rs` 中实现了与控制信道中继类比的语音三跳 relay：

```
RELAY_MAGIC = [0xC1, 0xDE]

relay 包格式：
  [RELAY_MAGIC(2B)] [target_edge_id_BE(4B)] [EDGE_MAGIC(2B)] [sender_session_BE(4B)] [voice...]

路由决策（route_voice）：
  1. 直连 UDP → peer edge（优先）
  2. 失败：try_relay_via_peer() → 通过任意已知 peer 中转（三跳）
  3. 失败：Hub TCP relay（兜底）
```

中继节点（Edge B）收到 RELAY_MAGIC 包后：
1. 读取 `target_edge_id`
2. 在 PeerRegistry 中查找目标 Edge 的 UDP 地址
3. 将内层 `[EDGE_MAGIC...]` 包直接发送给目标 Edge

## 8. 已知限制

- **单跳限制**：控制信道 relay 只允许一跳（A→B→Hub），不支持 A→B→C→Hub
- **语音 relay 无质量感知**：三跳 relay 候选按 PeerRegistry 顺序遍历，未考虑网络质量
- **无超时健康检查**：relay 连接不主动检测中间节点是否存活（WebSocket 读超时作为被动检测）
- **端到端测试缺失**：需要可控制的网络断开基础设施才能做完整的网络分区测试

## 9. 变更历史

- 2026-03-12（v1）：初始实现（错误：`allow_peer_proxy` opt-in 模型 + 独立 `proxy_ws_port`）
- 2026-03-12（v2）：重新设计——移除 opt-in 标志，改为 always-on relay + static_peers + 动态发现；
  添加语音三跳 relay（`RELAY_MAGIC`）；与语音路由机制对齐
