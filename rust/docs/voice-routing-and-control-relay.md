# Rust 实现：语音路由 & 控制信道中继

> 文档版本: 1.0  
> 日期: 2026-03-12  
> 覆盖范围: `munode-edge` / `munode-hub` Rust 实现

---

## 概述

MuNode Rust 版本的跨 Edge 通信分为两个独立的平面：

| 平面 | 用途 | 协议 | 主要文件 |
|------|------|------|---------|
| **语音平面** | 音频包的低延迟传输 | UDP（主）/ Hub TCP 兜底 | `udp.rs`, `hub_client.rs` |
| **控制平面** | RPC 通知、用户/频道同步 | WebSocket over TCP | `hub_client.rs`, `relay_server.rs` |

这两个平面都实现了三级路由策略，但实现方式不同：

```
语音平面（UDP）:
  ① 直连 UDP  →  ② 三跳 UDP relay（A→B→C）  →  ③ Hub TCP 兜底

控制平面（WebSocket）:
  ① 直连 Hub WS  →  ② 静态 peer relay  →  ③ 动态 peer relay
```

---

## 一、语音平面：UDP 路由

### 1.1 整体架构

```
Client A (Edge 1, UDP port)
        │ OCB2-AES128 加密包
        ▼
  Edge 1 UdpServer (udp.rs)
  ┌──────────────────────────────────────────────┐
  │  handle_client_datagram()                    │
  │    └─ handle_known_client()                  │
  │         └─ route_voice(sender, plaintext)    │
  │              │                               │
  │              ├── 本地客户端（同 channel）     │
  │              │     OCB2 重加密 → UDP send     │
  │              │     fallback_to_tcp()          │
  │              │                               │
  │              └── 远程 Edge（其他 Edge）       │
  │                    见 1.2 三级路由决策        │
  └──────────────────────────────────────────────┘
```

### 1.2 跨 Edge 语音三级路由决策

`route_voice()` 对每个目标 Edge 按以下优先级依次尝试：

```
目标 Edge N
    │
    ├── [策略允许直连 UDP？]
    │    └── EdgeState.allow_direct_udp == true
    │         └── PeerRegistry 中有 N 的 UDP 地址？
    │              ├── 是 → 发送直连 UDP 包（EDGE_MAGIC 格式）
    │              │         发送失败 → 尝试三跳 relay
    │              └── 否 → 尝试三跳 relay（try_relay_via_peer）
    │
    ├── [三跳 relay] try_relay_via_peer(target_edge_id)
    │         从 PeerRegistry 选取中间节点 M（排除 target 和自己）
    │         发送 RELAY_MAGIC 格式包给 M
    │         M.handle_relay_packet() → 转发 EDGE_MAGIC 包给 N
    │
    └── [Hub TCP 兜底] EdgeState.allow_hub_relay == true
              hub_client.relay_voice_via_hub(target_edge_id, payload)
              → RPC: edge.relayVoiceViaTcp
              → Hub 将包推送给目标 Edge（hub.relayVoicePacket 通知）
```

### 1.3 包格式

**客户端→Edge（OCB2 加密层）：**
```
[OCB2 密文]  （包含内部 Mumble 语音包）
```

**Edge→Edge 直连（edge_socket，edge_port）：**
```
[EDGE_MAGIC (2B): 0x4D4D] [sender_session_BE (4B)] [raw plaintext voice...]
```

**Edge→Edge 三跳 relay（中间节点接收格式）：**
```
[RELAY_MAGIC (2B): 0xC1 0xDE] [target_edge_id_BE (4B)] [EDGE_MAGIC (2B)] [sender_session_BE (4B)] [voice...]
```
中间节点 `handle_relay_packet()` 收到后：
1. 读取 `target_edge_id`（前 4 字节，RELAY_MAGIC 已由调用方剥离）
2. 在 PeerRegistry 中查找 target 的 UDP 地址
3. 将后面的 `[EDGE_MAGIC][session][voice]` 原样转发给目标 Edge

**Hub TCP 兜底（RPC edge.relayVoiceViaTcp）：**
```
Edge A → Hub：EdgeRelayVoiceViaTcpParams { from_edge_id, target_edge_id, voice_packet }
Hub → Edge B：hub.relayVoicePacket 通知 { voice_packet（含 session 的 Mumble 格式） }
```
接收端 Edge B 的 `server.rs` 处理 `RelayedVoice` 事件，解析并分发给本地客户端。

### 1.4 本地客户端语音路由

**普通 PTT（target=0）：**
- 遍历 `sender_channel` 及所有链接频道（`get_all_linked_channels`）
- 本地客户端：OCB2 重加密 → UDP；无 UDP 地址则走 TCP UDPTunnel
- 监听者（Listening）：同上处理

**Whisper（target 1-30）：**
- 从 `voice_targets` 缓存查 sender_session 的 VoiceTarget 配置
- 支持直接 session 列表 + 频道目标（含 links / children 递归）
- 跨 Edge：按 `allow_hub_relay` 走 Hub TCP 中继（UDP 路径暂不支持 whisper 的 edge 间路由）

**Loopback（target=31）：**
- 注入 session 后直接回发给发送者

**Suppress 静默：**
- `client.suppress=true` 且不是 loopback → 直接丢弃

### 1.5 TCP UDPTunnel 回退（本地客户端）

当本地客户端无 UDP 地址（仅 TCP 连接）时：
```rust
fn fallback_to_tcp(session_id, plaintext) {
    // 封装成 Mumble UdpTunnel 帧（明文，TLS 层保护）
    build_udp_tunnel_packet(plaintext)  // Type=1 + Len(4B) + data
}
```
TCP 隧道包在 TLS 连接内传输，无需额外加密。

### 1.6 连接策略配置

通过 `voice_routing.connection_strategy` 控制行为：

| 策略 | allow_direct_udp | allow_hub_relay | 说明 |
|------|-----------------|-----------------|------|
| `auto_fallback`（默认） | true | true | 先 UDP 直连，失败走三跳 relay，再走 Hub TCP |
| `tcp_only` | false | true | 跳过 UDP，始终走 Hub TCP 中继 |
| `direct_only` | true | false | 仅 UDP，不允许 Hub TCP 兜底 |

向后兼容：旧版 `server.disable_hub_relay = true` 等价于 `direct_only`。

### 1.7 关键数据结构

**PeerRegistry（`state.rs`）：**
```rust
pub struct PeerEdgeInfo {
    pub udp_addr: SocketAddr,  // edge_port 的 UDP 地址（语音用）
    pub host: String,
    pub relay_port: Option<u16>,  // 控制信道中继端口
}
```
- `all_udp_peers()` — 用于三跳 relay 候选选择
- `relay_peers()` — 用于控制信道中继候选选择

**UdpServer（`udp.rs`）：**
- `socket` — Mumble 客户端端口（client_port）
- `edge_socket` — Edge 间专用端口（edge_port，可与 socket 相同）
- `addr_to_session` / `session_to_addr` — UDP 地址↔session 双向映射

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
- **透明性**：Hub 完全无感知，看到的是 Edge B 建立的普通 WS 连接

### 2.3 hub_client.rs — 控制信道三级回退

`run_single_slot()` 的连接逻辑（每轮循环）：

```
direct_fail_count = 0
┌─────────────────────────────────────────────────────┐
│ LOOP                                                │
│   if direct_fail_count >= 3:                        │
│     try_connect_via_relay()                         │
│       ① 静态 peers (hub_server.static_peers)        │
│       ② 动态 peers (PeerRegistry.relay_peers())     │
│   else:                                             │
│     try_connect_slot() → ws://hub:port/             │
│                                                     │
│   成功 → reset direct_fail_count                   │
│   失败 → direct_fail_count++                       │
│   等待 exponential backoff                          │
└─────────────────────────────────────────────────────┘
```

**连接成功后的正常流程**（无论直连还是 relay，完全相同）：
1. 发送 `edge.register`（携带 `relay_port` 字段）
2. 接收 Hub 响应（edge_id、加密密钥、peer 列表）
3. 执行 `edge.fullSync` 同步频道树和用户状态
4. 发送 `edge.joinComplete`
5. 进入消息收发循环

### 2.4 relay_port 的发现和传播

```
Edge 启动
  └─ hub_client::new()
       └─ 从 config.hub_server.relay_port 或 edge_port+2 计算 relay_port

Edge 注册
  └─ edge.register { ..., relay_port: <my_relay_port> }
       └─ Hub 保存，并在广播 hub.peerJoined 时携带

收到 hub.peerJoined { id, host, relay_port, ... }
  └─ PeerRegistry.upsert(id, PeerEdgeInfo { udp_addr, host, relay_port })

Edge B 断开后直连失败 3 次
  └─ try_connect_via_relay()
       └─ 读取 PeerRegistry.relay_peers()
            └─ ws://peer_host:peer_relay_port/
```

### 2.5 静态 peer 的作用

**场景**：Hub 完全不可达时新 Edge 冷启动。
此时 `hub.peerJoined` 通知还没有收到，PeerRegistry 为空。
静态配置的 `hub_server.static_peers` 提供引导路径：

```toml
[hub_server]
host = "hub.example.com"
control_port = 8443
relay_port = 0          # 0 = 自动 (edge_port + 2)
static_peers = [
  { host = "10.0.0.2", relay_port = 19335 },  # 预知的其他 Edge
  { host = "10.0.0.3", relay_port = 19336 },
]
```

---

## 三、两个平面的对照

| 特征 | 语音平面 | 控制信道平面 |
|------|---------|------------|
| 传输协议 | UDP（edge_socket） | WebSocket over TCP |
| 主路径 | 直连 Edge UDP | 直连 Hub WebSocket |
| 中继包格式 | `[RELAY_MAGIC(2B)][target_id(4B)][EDGE_MAGIC(2B)][session(4B)][voice]` | 透明 WebSocket 帧转发 |
| 兜底路径 | Hub TCP relay（`edge.relayVoiceViaTcp`） | 无兜底（失败则重试） |
| Peer 发现 | `PeerRegistry.all_udp_peers()` | `PeerRegistry.relay_peers()` |
| 静态配置 | 无（UDP 地址从 peerJoined 获取） | `hub_server.static_peers` |
| 失败计数 | 每次发送 I/O 错误 | `direct_fail_count`（连续 3 次 → 切 relay） |
| 单跳限制 | 仅支持一次中继（A→B→C，不支持 A→B→C→D） | 同（relay_server 不接受链式 relay） |

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
tcp_fallback_delay = 0       # ms，切换前等待时间
udp_recovery_check_interval = 30000  # ms，探测 UDP 是否恢复

[voice_routing.relay]
enabled = true               # 本 Edge 是否作为中转节点接受 relay 请求
max_relay_bandwidth = 0      # Kbps，0 = 不限制
```

### Hub 语音路由策略（`voice_routing` 段）

```toml
[voice_routing]
enable_relay = true          # false = 拒绝所有 edge.relayVoiceViaTcp 请求
relay_cost_factor = 1.5      # 中继路由的成本系数（用于路由决策建议）
direct_rtt_threshold = 500   # ms，RTT 低于此值优先选直连
direct_loss_threshold = 0.05 # 丢包率，低于此值优先选直连
max_relay_streams_per_pair = 0  # 0 = 不限
max_total_relay_streams = 0     # 0 = 不限
```

### Edge 控制信道中继（`hub_server` 段）

```toml
[hub_server]
host = "hub.example.com"
control_port = 8443
relay_port = 0               # 0 = 自动（edge_port + 2）
static_peers = [             # 可选，用于 Hub 不可达时冷启动
  { host = "10.0.0.2", relay_port = 19335 },
]
```

---

## 五、关键实现文件索引

| 文件 | 职责 |
|------|------|
| `rust/munode-edge/src/udp.rs` | UDP 语音包接收、OCB2 解密、路由决策（直连/三跳/Hub TCP）、relay 包收发 |
| `rust/munode-edge/src/relay_server.rs` | 控制信道透明 WebSocket relay 服务器 |
| `rust/munode-edge/src/hub_client.rs` | Hub WebSocket 连接管理（直连+relay 回退）、relay_voice_via_hub RPC |
| `rust/munode-edge/src/state.rs` | `EdgeState`（allow_hub_relay/allow_direct_udp 标志）、`PeerRegistry`（UDP+relay 地址） |
| `rust/munode-edge/src/server.rs` | TCP UDPTunnel 语音处理、whisper/VoiceTarget 路由、`RelayedVoice` 事件处理 |
| `rust/munode-hub/src/rpc_handler.rs` | `handle_relay_voice_via_tcp()`、`handle_partition_after_disconnect()` |
| `rust/munode-common/src/config.rs` | `EdgeVoiceRoutingConfig`、`VoiceConnectionStrategy`、`HubVoiceRoutingConfig`、`StaticPeerConfig` |

---

## 六、已知限制 & 后续工作

### 已知限制

1. **三跳 relay 中间节点选择**：当前实现遍历 PeerRegistry 中所有已知 peer，选第一个发送成功的作为中间节点，没有基于质量数据的最优节点选择。
2. **whisper 跨 Edge**：Whisper（target 1-30）的跨 Edge 路由仅支持 Hub TCP 中继，不支持直连 UDP 和三跳 relay（语义复杂，当前实现省略）。
3. **relay 健康检查**：控制信道 relay 链路没有独立的超时/健康检查；依赖 WebSocket 层面的关闭检测（见 `relay_server.rs` — 留待后续实现）。
4. **质量指标**：无实时 RTT/丢包监测，无法基于实时质量动态切换路由（留待后续实现）。
5. **control relay 单跳限制**：relay_server.rs 中的 `run_relay_server()` 不接受来自其他 relay 的链式转发。

### 后续工作

- [ ] relay 链路健康检查和超时（`relay_server.rs`）
- [ ] whisper 跨 Edge 的 UDP 三跳 relay 路径
- [ ] 基于实时 RTT/丢包的动态路由切换
- [ ] 三跳 relay 中间节点质量排序
