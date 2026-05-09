# Rust 实现：语音路由 & 控制信道中继

> 文档版本: 2.0
> 日期: 2026-03-12
> 覆盖范围: `munode-edge` / `munode-hub` Rust 实现

---

## 概述

MuNode Rust 版本的跨 Edge 通信分为两个独立的平面：

| 平面 | 用途 | 协议 | 主要文件 |
|------|------|------|---------|
| **语音平面** | 音频包的低延迟传输 | UDP（主）/ Hub TCP 兜底 | `udp.rs`, `hub_client.rs` |
| **控制平面** | RPC 通知、用户/频道同步 | WebSocket over TCP | `hub_client.rs`, `relay_server.rs` |

### 路由决策模型

语音平面使用 **Hub 驱动的质量感知路由**，不再是简单的"直连优先"策略：

```
质量感知路由流程:
  1. Edge 定期发送 UDP 探针测量到 peer 的 RTT 和丢包率
  2. Edge 定期上报质量数据 → Hub (edge.reportQuality RPC)
  3. Hub 用 Dijkstra 算法计算最优路由表
  4. Hub 推送路由表 → Edge (hub.routeTableUpdate 通知)
  5. Edge 按 Hub 指定路由转发语音包:
     - Direct   → 直连 UDP
     - RelayVia → 三跳 UDP relay (A→B→C)
     - HubTcp   → Hub TCP 中继兜底
```

控制平面使用渐进式回退：
```
① 直连 Hub WS  →（3 次失败后）→  ② 静态 peer relay  →  ③ 动态 peer relay
```

---

## 一、语音平面：质量感知 UDP 路由

### 1.1 整体架构

```
Edge A (UdpServer)
┌─────────────────────────────────────────────────────┐
│  run() loop                                         │
│    ├── 接收客户端 OCB2 加密包                         │
│    │     └─ route_voice(sender, plaintext)          │
│    │          ├── 本地客户端: OCB2 重加密 → UDP send  │
│    │          └── 远程 Edge: 按 Hub 路由决策发送      │
│    ├── 接收 peer Edge 包（按首字节类型分发）            │
│    │     ├── 0x01 VOICE → handle_edge_packet()      │
│    │     ├── 0x02 RELAY → handle_relay_packet()     │
│    │     └── 0x03 PROBE → handle_probe_packet()     │
│    └── 探针任务 (probe_task, 独立 tokio::spawn)      │
│          ├── 每 10s 发送 UDP 探针 → 所有 peer Edges  │
│          └── 每 30s 上报质量 → Hub (reportQuality)  │
└─────────────────────────────────────────────────────┘
```

### 1.2 质量测量：UDP 探针协议

每个 Edge 在 `edge_socket` 上发送和响应 UDP 探针：

**探针包格式（14 字节）：**
```
[0x03][subtype(1B): 0=ping 1=pong][seq_BE(4B)][sent_ms_BE(8B)]
```

**探针流程：**
```
Edge A                              Edge B
  │ ─── [0x03][0=ping][seq][ts] ─→ │
  │                                  │ handle_probe_packet()
  │                                  │ → 回送 pong（相同 seq + 原始 timestamp）
  │ ←── [0x03][1=pong][seq][ts] ── │
  │ 计算 RTT = now - sent_ms        │
  │ 更新 PeerQualityState           │
```

**探针常量（`udp.rs`）：**
```rust
const PROBE_PING_INTERVAL_SECS: u64 = 10;    // 探针发送间隔
const PROBE_REPORT_INTERVAL_SECS: u64 = 30;  // 质量上报间隔
const EDGE_PKT_PROBE: u8 = 0x03;             // 探针包类型字节
```

**PeerQualityState（`udp.rs`）：**
```rust
struct PeerQualityState {
    pending_pings: HashMap<u32, u64>,          // seq → sent_ms
    rtt_samples: VecDeque<f32>,                // 最近 10 次 RTT
    probes_sent: u32,                          // 本窗口发送数
    pongs_received: u32,                       // 本窗口收到数
    next_seq: u32,                             // 下一个序列号
}
```

### 1.3 质量上报与路由表生成

**Edge → Hub 质量上报：**
```
Edge (report_quality RPC)
  edge_id, target_edge_id, rtt_ms, packet_loss, jitter_ms, samples
  → hub.handle_report_quality()
  → topology_manager.report_quality(from, to, LinkQuality)
  → 触发 push_route_tables_to_all()
```

**Hub 路由表计算（`topology_manager.rs`）：**
```
compute_route_table(for_edge_id):
  对每个目标 Edge 执行 Dijkstra(from=for_edge_id, to=target_id):
    │
    ├── path.len() == 1 or 0  → 无路径 (route_type=0, cost=9999)
    │
    ├── path.len() == 2 → 直连 (route_type=0, Direct)
    │     cost = rtt_ms + packet_loss * 500.0
    │
    └── path.len() >= 3 → 中继 (route_type=1, RelayVia)
          next_hop = path[1]
          cost = sum(each hop: rtt + loss * 500)
```

路由成本公式：`cost = RTT(ms) + 丢包率 × 500`（500 为丢包惩罚系数 `PACKET_LOSS_PENALTY_MS`）

**Hub → Edge 路由表推送：**
- 触发时机：`edge.reportQuality` 收到后；新 Edge 注册完成后
- 方法：`push_route_tables_to_all()` → `hub.routeTableUpdate` 通知
- 每个 Edge 收到自己的定制路由表（其他 Edge 对自己的最优路径）

### 1.4 Edge 路由决策（`udp.rs route_voice()`）

```
for each target_edge_id (远程 Edge):
    route = EdgeState.route_table.get(target_edge_id)
    
    match route:
        Direct | None     → 直连 UDP [0x01][session][voice]
                            失败 → Hub TCP 兜底
        RelayVia(relay_id) → 三跳 relay [0x02][target][session][voice]
                            失败 → Hub TCP 兜底
        HubTcp             → Hub TCP relay (edge.relayVoiceViaTcp RPC)
```

**`connection_strategy` 配置覆盖：**

| 策略 | allow_direct_udp | allow_hub_relay | 效果 |
|------|-----------------|-----------------|------|
| `auto_fallback`（默认） | true | true | 按 Hub 路由决策执行，HubTcp/失败时走 Hub TCP |
| `tcp_only` | false | true | 跳过 UDP，始终走 Hub TCP relay |
| `direct_only` | true | false | 仅 UDP，不允许 Hub TCP 兜底 |

### 1.5 包格式设计：为什么用 1-byte 类型字节而不是 2-byte 魔术字节或 protobuf

#### 设计决策分析

Edge-to-Edge 流量走独立的 `edge_socket`（`edge_port`），与客户端 Mumble UDP 端口**完全隔离**。这一隔离使得端口层的包类型识别变得简单：

**不需要 2-byte 魔术字节的原因：**
- `EDGE_MAGIC=[0x00,0x00]` 的原始目的是在**共享端口**上区分 Edge 包和 OCB2 客户端包
- 在独立 `edge_port` 上，所有流量已是 Edge-to-Edge，无需再检测 `[0x00,0x00]`
- 1 字节已足够区分 3 种包类型（VOICE / RELAY / PROBE）

**protobuf 开销对比（以 32kbps Opus 帧为例）：**

| 方案 | voice(50B) 包 | relay(50B) 包 | probe(14B) |
|------|-------------|-------------|----------|
| 旧 2-byte 魔术字节 | 50+6=**56 B** | 50+12=**62 B** | **15 B** |
| **新 1-byte 类型前缀**（当前实现）| 50+5=**55 B** | 50+9=**59 B** | **14 B** |
| protobuf 封装 | 50+10~12=**62 B** | 50+14~16=**66 B** | **20~24 B** |

- 语音包（最高频，50k+ pkt/s）：protobuf 比 1-byte 方案多 **10-14 bytes（+20%~+28%）**
- 对 1000 并发频道（50 pkt/s）：protobuf 方案每秒多消耗 **~500 KB** 额外带宽
- protobuf 还有序列化开销（heap allocation + varint 编解码），在 voice 热路径上不可接受

**结论：**  
→ 独立端口 + 1-byte 类型字节是最优选择，同时满足零歧义、最小开销、代码清晰三个目标。  
→ protobuf 适合 Hub↔Edge 控制信道（低频 RPC），不适合 UDP 语音热路径。

#### 包格式汇总

**客户端→Edge（OCB2 加密层，Mumble 端口）：**
```
[OCB2 密文]
```

**Edge→Edge 直连 Voice（`edge_port`，类型字节 0x01）：**
```
[0x01][sender_session_BE(4B)][plaintext voice...]
   ↑
   5-byte header (saves 1 byte vs old 2-byte EDGE_MAGIC)
```

**Edge→Edge 三跳 Relay（`edge_port`，类型字节 0x02，发给中间节点）：**
```
[0x02][target_edge_id_BE(4B)][sender_session_BE(4B)][plaintext voice...]
   ↑
   9-byte header (saves 3 bytes vs old 12-byte RELAY_MAGIC+inner_EDGE_MAGIC)
```
中间节点（Edge B）收到后，重建 Voice 包 `[0x01][session][voice]` 转发给 Edge C。

**Hub TCP relay（`edge.relayVoiceViaTcp` RPC）：**
```
EdgeRelayVoiceViaTcpParams { from_edge_id, target_edge_id, voice_packet }
→ Hub 推送 hub.relayVoicePacket 到目标 Edge
```

**UDP 探针（`edge_port`，类型字节 0x03）：**
```
[0x03][subtype(1B): 0=ping 1=pong][seq_BE(4B)][sent_ms_BE(8B)]
   ↑
   14-byte total (saves 1 byte vs old 2-byte PROBE_MAGIC)
```

**遗留/降级模式（共享端口，无独立 `edge_port`）：**
```
[EDGE_MAGIC(2B): 0x00,0x00][sender_session_BE(4B)][voice...]
```
仅在 `edge_socket == socket`（未配置 `edge_port`）时生效，不支持 relay 和 probe。

### 1.6 本地客户端语音路由

**普通 PTT（target=0）：**
- 遍历 sender_channel 及所有链接频道（`get_all_linked_channels`）
- 本地客户端：OCB2 重加密 → UDP；无地址则走 TCP UDPTunnel
- 远程 Edge：按 Hub 路由决策（见 1.4）

**Whisper（target 1-30）：**
- 从 `voice_targets` 缓存查 VoiceTarget 配置
- 支持 session 目标 + 频道目标（含 links/children 递归）
- 跨 Edge：使用 Hub TCP relay（whisper 跨 Edge 不走 UDP relay）

**Loopback（target=31）：**
- 注入 session 后直接回发给发送者

**Suppress 静默：**
- `client.suppress=true` 且不是 loopback → 丢弃

### 1.7 路由表数据结构

**Protocol（`hubedge.proto` / `hubedge.rs`）：**
```protobuf
message HubRouteEntryProto {
  required uint32 target_edge_id = 1;
  required uint32 route_type = 2;  // 0=direct, 1=relay, 2=hub_tcp
  optional uint32 next_hop = 3;    // relay 时的中间节点 edge_id
  required float cost = 4;
}

message HubRouteTableUpdateParams {
  repeated HubRouteEntryProto routes = 1;
}
```

**Edge 存储（`state.rs`）：**
```rust
pub enum RouteDecision {
    Direct,
    RelayVia { relay_edge_id: u32 },
    HubTcp,
}

// EdgeState 字段:
pub route_table: RwLock<HashMap<u32, RouteDecision>>,
```

---

## 二、控制信道：中继架构

### 2.1 整体架构

每个 Edge 同时扮演两个角色：

```
                     ┌────────────────────────────────────┐
                     │  Edge B                            │
                     │                                    │
                     │  ┌─────────────────────────────┐   │
 Edge A  ──ws──────► │  │ relay_server.rs             │   │
（无法直连 Hub）       │  │ 0.0.0.0:{relay_port}        │   │
                     │  │ 接受 WS → 透明转发到 Hub     │   │
                     │  └───────────┬─────────────────┘   │
                     │              │ ws://hub:port/        │
                     └──────────────┼────────────────────┘
                                    ▼
                                   Hub（看到普通 WS 连接）
```

### 2.2 relay_server.rs — 透明 WebSocket 中继

- **监听地址**：`0.0.0.0:{relay_port}`（默认 `edge_port + 2`）
- **每连接行为**：
  1. 接受 TCP 连接，升级为 WebSocket（服务端角色）
  2. 新开一条 WebSocket 到 Hub
  3. 双向中继所有 Binary / Text 帧，直到任一侧关闭
- **单跳限制**：不接受来自其他 relay 的链式转发
- **TLS**：relay 监听为明文 WS（集群内可信网络；TLS 终止在 Edge→Hub 的那条连接上）

### 2.3 hub_client.rs — 控制信道三级回退

`run_single_slot()` 的连接逻辑：

```
direct_fail_count = 0
RELAY_FALLBACK_THRESHOLD = 3

LOOP:
  if direct_fail_count >= RELAY_FALLBACK_THRESHOLD:
    try_connect_via_relay()
      ① 静态 peers (hub_server.static_peers)
      ② 动态 peers (PeerRegistry.relay_peers())
  else:
    try_connect_slot() → ws://hub:port/

  成功 → reset direct_fail_count
  失败 → direct_fail_count++
  等待 exponential backoff
```

连接成功后（无论直连还是 relay，完全相同）：
1. 发送 `edge.register`
2. 接收 Hub 响应
3. 执行 `edge.fullSync` 同步频道树
4. 发送 `edge.joinComplete`
5. 进入消息收发循环

### 2.4 relay 端点发现

```
Edge 启动
  → hub_client::new()
       → relay listener = network.edge_port

Peer 发现
  → Hub 广播 peer host + edge_port

收到 hub.peerJoined / fullSync peer 信息
  → PeerRegistry.upsert(id, PeerEdgeInfo { host, relay_port: None | Some(...) })
  → PeerRegistry.relay_peers() 优先使用显式 relay_port，缺失时回退到 peer edge_port
```

---

## 三、两个平面对照

| 特征 | 语音平面 | 控制信道平面 |
|------|---------|------------|
| 传输协议 | UDP (`edge_socket`) | WebSocket over TCP |
| 路由决策者 | Hub（Dijkstra + 质量数据） | Edge 自身（失败计数） |
| 主路径 | Hub 指定的最优路径 | 直连 Hub WebSocket |
| 质量测量 | UDP probe ping/pong | WebSocket 连接成功率 |
| 回退逻辑 | Direct → RelayVia → HubTcp | 直连 → static peer → dynamic peer |
| 回退触发 | Hub 路由决策（质量感知） | 连续 3 次连接失败 |
| 类型标识 | 1-byte 类型前缀（0x01/0x02/0x03），独立端口消除歧义 | N/A（WebSocket 协议） |
| 单跳限制 | relay 仅支持一次中间节点 | relay_server 不接受链式 relay |
| Peer 发现 | PeerRegistry.all_udp_peers() | PeerRegistry.relay_peers() |
| 静态配置 | 无（UDP 地址从 peerJoined 获取） | `hub_server.static_peers` |

---

## 四、配置参考

### Edge 语音路由（`voice_routing` 段）

```toml
[voice_routing]
enabled = true
# 连接策略: auto_fallback | tcp_only | direct_only
connection_strategy = "auto_fallback"

[voice_routing.fallback]
enable_tcp_fallback = true

[voice_routing.relay]
enabled = true               # 本 Edge 是否作为中转节点接受 relay 请求
max_relay_bandwidth = 0      # Kbps，0 = 不限制
```

### Hub 语音路由策略（`voice_routing` 段）

```toml
[voice_routing]
enable_relay = true          # false = 拒绝所有 edge.relayVoiceViaTcp 请求
relay_cost_factor = 1.5
direct_rtt_threshold = 500   # ms
direct_loss_threshold = 0.05
```

### Edge 控制信道中继（`hub_server` 段）

```toml
[hub_server]
host = "hub.example.com"
control_port = 8443
relay_port = 0               # 0 = 自动（edge_port + 2）
static_peers = [
  { host = "10.0.0.2", relay_port = 19335 },
]
```

---

## 五、关键实现文件索引

| 文件 | 职责 |
|------|------|
| `rust/munode-edge/src/udp.rs` | UDP 接收、OCB2 解密、路由决策（按 Hub 路由表）、探针发送/接收、三跳 relay 收发 |
| `rust/munode-edge/src/relay_server.rs` | 控制信道透明 WebSocket relay 服务器 |
| `rust/munode-edge/src/hub_client.rs` | Hub WS 连接管理（直连+relay 回退）、`hub.routeTableUpdate` 处理、`report_quality` RPC |
| `rust/munode-edge/src/state.rs` | `RouteDecision` 枚举、`EdgeState.route_table`、`PeerRegistry`（UDP+relay 地址） |
| `rust/munode-edge/src/server.rs` | TCP UDPTunnel 语音处理、whisper 路由、`RelayedVoice` 事件处理 |
| `rust/munode-hub/src/topology_manager.rs` | Dijkstra 路径计算、质量更新、`compute_route_table()` |
| `rust/munode-hub/src/rpc_handler.rs` | `handle_report_quality()`、`push_route_tables_to_all()`、`handle_relay_voice_via_tcp()` |
| `rust/munode-common/src/config.rs` | `EdgeVoiceRoutingConfig`、`VoiceConnectionStrategy`、`HubVoiceRoutingConfig`、`StaticPeerConfig` |
| `rust/munode-protocol/src/generated/hubedge.rs` | `HubRouteEntryProto`、`HubRouteTableUpdateParams`（tag=36 in TypedRpcNotification） |

---

## 六、已知限制 & 后续工作

### 已知限制

1. **relay 健康检查**：控制信道 relay 链路没有独立的超时/健康检查（留待后续实现）
2. **whisper 跨 Edge**：Whisper（target 1-30）的跨 Edge 路由仅支持 Hub TCP relay，不支持直连 UDP 和三跳 relay
3. **路由表更新延迟**：质量数据 30s 上报一次，加上 Dijkstra 计算时间，路由表更新有 30-60s 延迟
4. **无数据时的默认路由**：当没有质量数据时（新节点），Hub 给出 `cost=9999` 的 direct 路由；Edge 仍会尝试直连 UDP，失败后回退 Hub TCP

### 后续工作

- [ ] relay 链路健康检查（`relay_server.rs`）
- [ ] whisper 跨 Edge 的 UDP 三跳 relay 路径
- [ ] 缩短质量上报间隔（可配置化 `PROBE_REPORT_INTERVAL_SECS`）
- [ ] 路由表 TTL — 过期时自动降级为 Direct 直连兜底
- [ ] 控制信道失败率追踪 → 动态调整 `RELAY_FALLBACK_THRESHOLD`
