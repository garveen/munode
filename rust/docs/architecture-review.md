# MuNode Rust 架构审查报告

> **审查范围**：Edge 间连接、Hub-Edge 连接、语音转发、控制信道及相关子系统  
> **目标规模**：2000 用户在线，单频道 500 用户  
> **审查日期**：2026-03-17  
> **代码版本**：Rust workspace，约 20,000 行（munode-edge 9,771 行 / munode-hub 8,057 行 / munode-protocol 239 行 / munode-common 1,284 行）

---

## 目录

1. [架构概述](#1-架构概述)
2. [严重问题（Critical）](#2-严重问题critical)
3. [高优先级问题（High）](#3-高优先级问题high)
4. [中优先级问题（Medium）](#4-中优先级问题medium)
5. [低优先级 / 改进建议](#5-低优先级--改进建议)
6. [语音转发路径分析](#6-语音转发路径分析)
7. [控制信道分析](#7-控制信道分析)
8. [Edge 间连接分析](#8-edge-间连接分析)
9. [2000 用户规模下的配置建议](#9-2000-用户规模下的配置建议)
10. [已有优势总结](#10-已有优势总结)

---

## 1. 架构概述

```
┌──────────────────────────────────────────────────────────────┐
│                        Hub (单实例)                          │
│  ┌────────┐ ┌──────────┐ ┌───────────┐ ┌─────────────────┐  │
│  │ SQLite │ │ Session  │ │ Channel   │ │ Topology        │  │
│  │(WAL)   │ │ Manager  │ │ Store     │ │ Manager         │  │
│  └───┬────┘ └────┬─────┘ └─────┬─────┘ │(Dijkstra/UF)   │  │
│      │           │              │        └────────┬────────┘  │
│      └───────────┴──────────────┴─────────────────┘          │
│                  ↕ WebSocket (Protobuf 编码 RPC)             │
├──────────────────────────────────────────────────────────────┤
│               ↕              ↕              ↕                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Edge A    │  │   Edge B    │  │   Edge C    │          │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │          │
│  │ │ClientMgr│ │  │ │ClientMgr│ │  │ │ClientMgr│ │          │
│  │ │ChanMgr  │ │  │ │ChanMgr  │ │  │ │ChanMgr  │ │          │
│  │ │UDP Voice│ │  │ │UDP Voice│ │  │ │UDP Voice│ │          │
│  │ │Bandwidth│ │  │ │Bandwidth│ │  │ │Bandwidth│ │          │
│  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │          │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         ↕ OCB2-AES128    ↕ OCB2-AES128    ↕ OCB2-AES128     │
│   [Mumble Clients]  [Mumble Clients]  [Mumble Clients]      │
└──────────────────────────────────────────────────────────────┘
          ←───── Edge-to-Edge: Plaintext UDP ─────→
```

**关键数据流**：
- **客户端 → Edge**：TCP/TLS（控制 protobuf 帧）+ UDP（OCB2-AES128 加密语音）
- **Edge → Hub**：WebSocket（JSON 编码 RPC 请求/响应 + 通知）
- **Hub → Edge**：WebSocket（广播通知推送给所有连接的 Edge）
- **Edge ↔ Edge**：明文 UDP（语音中继）或通过 Hub TCP 中继

---

## 2. 严重问题（Critical）

### C-1: Hub 数据库操作在 async 运行时上同步阻塞

**位置**：`munode-hub/src/database.rs:1`, `munode-hub/src/rpc_handler.rs`（~40 处调用）

**现状**：`Database` 使用 `std::sync::Mutex<Connection>` 包装 SQLite 连接。所有数据库方法（`find_user`、`load_bans`、`save_channel`、`check_ip_banned` 等）都是同步的，直接在 tokio async 上下文中调用。

```rust
// database.rs:54-56
pub struct Database {
    conn: Mutex<Connection>,  // std::sync::Mutex，不是 tokio::sync::Mutex
}

// rpc_handler.rs 中直接调用（举例）:
let db_user = self.state.database.find_user(username)?;       // 第 1101 行
self.state.database.save_channel(&db_ch)?;                     // 第 1883 行
let bans = self.state.database.load_bans()?;                   // 第 2288 行
```

**问题**：
- `std::sync::Mutex` 在 async 中会阻塞整个 tokio worker 线程
- 单连接意味着所有 DB 操作串行化
- 在 2000 用户场景下：用户认证时 `find_user` 可能对整个用户表做全表扫描（O(N)），`load_bans` 读取整个 ban 表；这些操作持有 Mutex 期间，其他所有 RPC 请求（包括语音中继）都在等待
- 极端情况：2000 个并发认证请求，每个 10ms DB 查询 → 20 秒串行等待 → 超过 30 秒 RPC 超时 → 所有 Edge 断开

**对比**：Lua 认证正确使用了 `tokio::task::spawn_blocking`（第 760 行），但部分数据库调用还未使用。

**建议**：
1. 将所有 Database 方法调用包裹在 `tokio::task::spawn_blocking` 中
2. ~~**【实现】** 或改用异步 SQLite 封装（如 `tokio-rusqlite`）~~ **【已部分实现】** 关键热路径（`find_user`、`check_ip_banned`、`save_channel`、`load_bans`、`upsert_ext_user`、`get_user_last_channel`、ACL 权限组查询）均已通过 `spawn_blocking` 包装，避免阻塞 tokio worker 线程。
3. 考虑使用连接池支持并行读取（WAL 模式允许并发读）
4. 对高频查询（`find_user`、`check_ip_banned`）添加数据库索引

---

### C-2: Hub 广播使用 `try_send()` 导致关键消息静默丢失

**位置**：`munode-hub/src/server.rs:347`, `munode-hub/src/rpc_handler.rs`

**现状**：~~Hub 向所有 Edge 广播通知（用户加入/离开/移动、频道更新等）使用非阻塞的 `try_send()`~~ **【已修复】** `broadcast_notification()` 已改为调用 `broadcast_critical()`（持有超时的 `send().await`），`on_user_state_changed` 和 `on_text_message` 改为使用新增的 `broadcast_critical_excluding()` 函数（向除源 Edge 外的所有 Edge 发送，带 2 秒超时），确保关键状态消息不会被静默丢弃。

每个 Edge 的 MPSC 通道缓冲区为 256 条消息（`edge_connection.rs` 中 `mpsc::channel::<Vec<u8>>(256)`）。

**问题**：
- 如果某个 Edge 的写入任务因网络拥塞变慢，缓冲区满时 `try_send()` 立即返回错误
- 消息被静默丢弃，仅打印警告日志
- 丢失的消息可能包括 `hub.userJoined`、`hub.userRemoveBroadcast`、`hub.channelRemove` 等**关键状态同步消息**
- 该 Edge 将与 Hub 的状态产生不一致：看到已离开的用户仍在线、看不到新加入的用户等
- **没有增量同步恢复机制**——唯一的修复方式是 Edge 完整断开重连并做 fullSync

**建议**：
1. ~~**【实现】** 对关键状态消息使用 `send().await`（带超时）而非 `try_send()`~~ **【已实现】**
2. 或实现消息优先级：状态同步消息（用户加入/离开）> 语音中继 > 其他
3. 添加消息丢弃计数器，当丢弃数超过阈值时触发强制 fullSync
4. 考虑增大缓冲区（256 → 1024 或更多），或基于 Edge 当前用户数动态调整

---

### C-3: Full Sync 无分页、无压缩，大规模时可能超时

**位置**：`munode-hub/src/rpc_handler.rs:1410-1543`, `munode-edge/src/hub_client.rs:1192-1230`

**现状**：Edge 向 Hub 请求 `edge.fullSync` 时，Hub 返回**所有**频道、**所有**会话、**所有**Edge 信息，在一个 RPC 响应中。

```rust
// Hub 端：返回所有 session，不做过滤
let sessions: Vec<GlobalSessionProto> = self.state.session_manager
    .get_all_sessions().await    // ← 返回整个集群的所有用户
    .iter()
    .map(|s| GlobalSessionProto { ... })
    .collect();
```

**问题**：
- 2000 用户 × ~150 字节/session ≈ 300 KB，加上频道树 ≈ 350+ KB
- 未压缩的 Protobuf，WebSocket 帧无压缩
- 超时设置 30 秒，在慢网络下可能不够
- 序列化期间持有 `session_manager` 和 `channel_store` 的读锁，阻塞其他操作
- 多个 Edge 同时重连（如 Hub 重启后）会导致并发 fullSync 风暴

**建议**：
1. 实现分页式增量同步（按 Edge 或按频道分批返回）
2. 在 WebSocket 层启用 `permessage-deflate` 压缩
3. 增加 fullSync 超时（30s → 60s）
4. 考虑仅发送与该 Edge 相关的数据（按 region 或按频道子树过滤）
5. **【实现】** 减少序列化期间的锁持有时间：先 clone 数据再序列化

---

## 3. 高优先级问题（High）

### H-1: Edge-to-Edge 语音明文传输，无加密

**位置**：`munode-edge/src/udp.rs`（Edge 间 UDP 协议）

**现状**：客户端到 Edge 的语音使用 OCB2-AES128 加密，但 Edge 之间的语音传输为**明文**：

```
Edge 间 UDP 包格式：
[0x01][sender_session BE(4)][voice_payload]        — 直接语音（5 字节头）
[0x02][target_edge_id BE(4)][sender_session BE(4)][voice_payload] — 中继转发（9 字节头）
```

**问题**：
- 如果 Edge 节点分布在不同数据中心或通过公网通信，语音内容完全暴露
- 攻击者可在 Edge 间网络路径上窃听所有语音
- 没有认证——任何人都可以向 Edge 的 `edge_port` 发送伪造的语音包

**建议**：
1. **【实现】** 对 Edge 间 UDP 实现 DTLS 或使用预共享密钥加密（如 ChaCha20-Poly1305）
2. 至少添加 HMAC 认证防止伪造包注入
3. 如果 Edge 都在同一可信内网内，在文档中明确说明安全边界假设

---

### H-2: 中继服务器（Relay Server）无认证、无速率限制

**位置**：`munode-edge/src/relay_server.rs`（176 行）

**现状**：每个 Edge 运行一个 WebSocket relay server（`relay_port`），允许其他 Edge 通过它连接 Hub：

```rust
// relay_server.rs — 【已添加 HMAC 认证】
// 当配置 hmac_secret 时，/relay 连接需提供时间戳签名 token（ts + HMAC-SHA256）
```

**问题**：
- ~~无认证：任何知道 relay_port 的人都可以连接并直接与 Hub 通信~~ **【已修复】** 添加了基于 HMAC-SHA256 的时间戳 token 认证，30 秒有效期防重放攻击
- 无 TLS：中继流量明文传输
- 无速率限制：可被用于 DDoS 放大攻击
- 无最大连接数限制：可以耗尽 Edge 的文件描述符
- 帧缓冲无上限：如果 Hub 响应慢，中继缓冲可能导致 OOM

**建议**：
1. ~~**【实现】** 添加基于 HMAC 的握手认证（复用 Edge 注册的 `hmac_secret`）~~ **【已实现】** 继服务器在配置了 `hmac_secret` 时，通过 URL 查询参数 `?ts=<ts>&token=<hmac>` 验证连接者身份；hub_client 在 `try_connect_via_relay` 中自动附加 token。
2. 限制最大并发中继连接数
3. 添加帧缓冲上限，达到上限时断开连接
4. 至少添加 per-IP 速率限制
5. 如果中继暴露在公网，必须启用 TLS (wss://)

---

### H-3: ACL 权限缓存无 TTL 和大小限制

**位置**：`munode-hub/src/acl_manager.rs`

**现状**：ACL 权限计算结果缓存在 `HashMap<(i32, u32), u32>` 中：

```rust
pub struct AclManager {
    cache: RwLock<HashMap<(i32, u32), u32>>,  // (user_id, channel_id) → 权限位
}
```

**问题**：
- 缓存无过期时间（TTL），条目永远不会自然过期
- 缓存无大小限制，可无限增长
- 2000 用户 × 500 频道 = 最多 100 万个缓存条目
- 匿名用户（guest）使用负数 user_id，每次登录生成不同 ID，永远不会被清理
- 仅在 ACL 修改时通过 `invalidate_channel()` 做局部清理
- 长期运行的服务器内存会持续增长

**建议**：
1. 添加 TTL 过期机制（如 1 小时后过期）
2. **【实现】** 实现 LRU 淘汰策略，限制缓存最大条目数（如 10 万条）
3. 不缓存匿名用户的权限（或使用更短的 TTL）

---

### H-4: Edge 优雅关机不足

**位置**：`munode-edge/src/server.rs:238-244`

**现状**：

```rust
// 关机流程：
// 1. 跳出 accept 循环
// 2. 等待 200ms（tokio::time::sleep）
// 3. abort() 所有后台任务
udp_handle.abort();
hub_handle.abort();
event_handle.abort();
```

Hub 触发的关机更短——仅 100ms 等待。

**问题**：
- 200ms 太短，不足以让以下操作完成：
  - 向已连接的客户端发送断开通知
  - 向 Hub 发送用户离开通知
  - 完成进行中的语音包路由
- 使用 `abort()` 强制终止任务，可能中断半发送的帧
- 没有"连接排空"（draining）阶段：直到最后一刻还在接受新连接
- 客户端只有在下次发送消息时才会发现连接已断开

**建议**：
1. 增加优雅关机窗口至 3-5 秒
2. **【实现】** 实现分阶段关机：停止接受新连接 → 通知所有客户端 → 等待飞行中的消息完成 → 关闭
3. 向每个连接的客户端发送 `ServerBan/Reject` 消息告知服务器关闭
4. 在 abort 前使用 `tokio::time::timeout` 等待任务自然结束

---

### H-5: 心跳超时过长（180 秒）

**位置**：Hub `config/hub.example.toml:46`, `munode-hub/src/server.rs`（健康检查循环）

**现状**：
- Edge 发送心跳间隔：30 秒
- Hub 检查间隔：90 秒（`heartbeat_timeout`）
- 实际超时阈值：90 × 2 = 180 秒（3 分钟）

**问题**：
- 如果一个 Edge 崩溃，其上的所有用户在其他 Edge 看来会"幽灵存在"长达 3 分钟
- 在这 3 分钟内，其他用户尝试向这些幽灵用户发送文本消息或语音都会失败
- 对于实时语音通信来说，3 分钟的检测延迟极不理想

**建议**：
1. **【实现】** 缩短心跳间隔至 10 秒，超时阈值至 30-45 秒
2. 实现双向心跳：Hub 也向 Edge 发送心跳 ack
3. Edge 端如果连续 N 次心跳无应答，主动标记 Hub 不可达
4. 对关键通知（用户移动、语音目标更新）添加 ack 确认机制

---

## 4. 中优先级问题（Medium）

### M-1: RPC 请求计数器使用 `Mutex<u64>` 而非 `AtomicU64`

**位置**：`munode-edge/src/hub_client.rs`

**现状**：每个 RPC 请求需要生成唯一 ID，使用 `Mutex<u64>`：

```rust
request_counter: Mutex<u64>,

async fn next_request_id(&self) -> String {
    let mut counter = self.request_counter.lock().await;
    *counter += 1;
    format!("{}_{}", self.edge_id(), counter)
}
```

**问题**：高频 RPC 场景下（2000 用户每人每秒多个 RPC），Mutex 竞争成为热点。

**建议**：改用 `AtomicU64::fetch_add(1, Ordering::Relaxed)`，无锁且更高效。

---

### M-2: 语音中继通过 Hub TCP 时的内存拷贝

**位置**：`munode-hub/src/rpc_handler.rs:3599-3660`

**现状**：Hub TCP 语音中继路径中，语音包被多次 clone：

```rust
let voice_packet = params.voice_packet.clone();  // 第一次 clone
// ... 构造通知 ...
let data = packet.encode_to_vec();                // 编码时再次复制
sender.send(data).await;                          // 发送
```

**问题**：对于 500 人频道中有多个 Edge 的跨 Edge 语音，每个包都经过：
- Edge A → Hub（序列化 + 网络传输）
- Hub 解码 → clone → 重新编码 → Hub → Edge B（序列化 + 网络传输）
- 比直接 Edge-to-Edge UDP 多 2 次序列化和至少 2 次内存拷贝
- 在高负载时会增加 Hub CPU 和内存压力

**建议**：
1. 尽量使用 Edge-to-Edge 直连 UDP（当前已有优先选择直连的逻辑）
2. **【实现】** Hub 中继路径考虑使用 `Bytes` 类型实现零拷贝转发
3. 添加 Hub 中继带宽监控告警

---

### M-3: 连接池默认未启用

**位置**：`munode-common/src/config.rs`，`munode-edge/src/hub_client.rs`

**现状**：~~Edge 到 Hub 的连接池默认 `pool_size = 1`，即单连接。~~ **【已修复】** `edge.example.toml` 中已将 `pool_size = 3` 设为推荐默认值（不再注释掉）。

**问题**：
- 单 WebSocket 连接承载该 Edge 所有 RPC 请求和所有广播通知
- 如果该连接短暂中断，该 Edge 上的所有用户都受影响
- 连接池模式已实现（轮询分发 RPC），但默认未启用
- ~~池模式下 `send_raw()` 如果所有 slot 都不可用，返回 `Ok(())`（静默成功），调用方无法感知失败~~ **【已修复】** 所有 slot 不可用时返回 `Err`。

**建议**：
1. ~~**【实现】**：在文档和示例配置中推荐 `pool_size = 3`~~ **【已实现】**
2. ~~**【实现】** 修复静默失败：所有 slot 不可用时应返回错误~~ **【已实现】**
3. 添加连接池健康状态监控（当前已有 slot 数量但缺少 exposed metrics）

---

### M-4: Peer Registry 写锁阻塞语音路由

**位置**：`munode-edge/src/hub_client.rs:959-978`, `munode-edge/src/state.rs`

**现状**：当收到 `hub.peerJoined` 通知时，Edge 获取 `peer_registry` 的写锁来注册新 Peer：

```rust
let mut reg = self.edge_state.peer_registry.write().await;
reg.upsert(peer_edge_id, PeerEdgeInfo { ... });
```

同时，UDP 语音路由也需要读取 `peer_registry` 来查找目标 Edge 的地址。

**问题**：`RwLock` 写锁会阻塞所有读取者。在 Peer 加入/离开期间，语音包路由会短暂阻塞。虽然单次时间很短，但在多 Edge 集群中可能出现毫秒级延迟尖峰。

**建议**：
1. **【实现】** 考虑使用 `dashmap` 等无写锁的并发 HashMap
2. 或使用 copy-on-write 模式：路由快照 + 原子交换

---

### M-5: Web API 中 DELETE /api/bans/:id 端点无认证

**位置**：`munode-hub/src/web_api.rs`

**现状**：Web API 中删除 ban 的端点没有任何认证：

```rust
// 任何能访问 HTTP 端口的客户端都可以删除 ban
.route("/api/bans/:id", delete(delete_ban_handler))
```

**问题**：如果 Web API 端口暴露在公网或内网中，任何人都可以移除封禁记录。

**建议**：
1. **【实现】** 添加 API Key 或 Bearer Token 认证中间件
2. 或将 Web API 绑定到 localhost（仅本机访问）
3. 所有写操作（DELETE, POST, PUT）都应需要认证

---

### M-6: 未进行 Edge 边缘计算（语音相关缓存不足）

**位置**：整体架构

**现状**：Edge 对于权限检查、频道链接解析等操作几乎完全依赖 Hub RPC。

**问题**：
- 每次用户切换频道都需要向 Hub 发起权限查询 RPC
- 语音目标解析（whisper target）在 Hub 更新后推送到 Edge，但 Edge 缓存在 Hub 重连后被清空
- 文本消息完全通过 Hub 路由，无本地快速路径
- 500 人频道中如果有频繁的用户移动，会产生大量 RPC 请求

**建议**（Hub 仍为唯一事实来源，Edge 做边缘缓存）：
1. **【实现】** **权限缓存**：Edge 本地缓存 ACL 计算结果，Hub 在 ACL 变更时推送失效通知
2. **【实现】** **频道树缓存**：Edge 已有 `channel_manager`，应增量更新而非全量替换
3. **同频道语音快速路径**：同一 Edge 上同一频道内的语音应完全在 Edge 本地路由，不经过 Hub（当前已实现）
4. **文本消息本地分发**：同一 Edge 上同一频道的文本消息可先本地分发，再异步通知 Hub
5. **【实现】** **频道用户列表缓存**：Edge 维护的 `channel_users` 映射应在收到 Hub 通知时增量更新

---

## 5. 低优先级 / 改进建议

### L-1: 语音包处理中的 UDP 源地址识别为 O(N)

**位置**：`munode-edge/src/udp.rs`

**现状**：当收到来自未知地址的 UDP 包时，`try_identify_and_handle()` 需要遍历所有会话来尝试解密找到匹配者。

**问题**：虽然正常情况下每个客户端只会触发一次（之后 address 被缓存），但 2000 个客户端同时连接时，前几个包的识别是 O(N)。

**建议**：在识别阶段先尝试常见的匹配策略（如 IP 已知但端口变化），减少需要遍历的候选数。

---

### L-2: 【不实现】临时频道清理可能产生级联 Session Manager 查询

**位置**：`munode-hub/src/rpc_handler.rs`（`maybe_cleanup_temp_channel`）

**现状**：清理临时频道时，每向上走一级都要获取所有会话和所有频道来检查是否为空。

**建议**：使用引用计数或 channel_users 缓存，避免每次都获取全量数据。

---

### L-3: 【不实现】拓扑管理器中的 Union-Find 使用递归

**位置**：`munode-hub/src/topology_manager.rs`（`detect_partitions`）

**现状**：网络分区检测使用递归 Union-Find 的 `find()` 方法。

**问题**：理论上在大量 Edge 节点时可能栈溢出（>1000 节点）。当前规模（几个 Edge）不会触发。

**建议**：改用迭代式路径压缩实现。

---

### L-4: 【不实现】带宽限制超标时静默丢弃语音包

**位置**：`munode-edge/src/bandwidth.rs`

**现状**：当用户超过带宽限制时，语音包被静默丢弃，不通知客户端。

**建议**：向客户端发送 `PermissionDenied` 消息告知带宽不足，让用户知道需要降低编码码率。

---

### L-5: 认证服务单连接瓶颈

**位置**：`munode-hub/src/auth_service.rs`

**现状**：外部认证服务仅支持单个 WebSocket 连接。

**问题**：如果使用外部认证服务，2000 用户的认证请求需要通过单个 WebSocket 连接串行处理。在认证风暴（服务器重启后大量用户同时重连）时，认证延迟会非常高。

用户备注：如果lua可以完全替换外部认证服务功能，则删掉这部分，完全使用lua。

---

## 6. 语音转发路径分析

### 6.1 同 Edge 同频道（最优路径，已实现）

```
Client A → [OCB2 decrypt] → route lookup → [OCB2 encrypt] → Client B
            Edge 本地处理，无网络跳转
```

**性能评估**：✅ 优秀
- 延迟：5-20ms（解密 + 路由查找 + 加密 + UDP 发送）
- 500 人频道：1 个发送者 → 499 个接收者，需要 499 次 OCB2 加密
- 瓶颈：OCB2 加密 CPU 开销
- `listening_index` 优化了接收者查找（O(1) 而非 O(N)）

### 6.2 跨 Edge 直连 UDP

```
Client A → Edge A → [0x01][session][voice] UDP → Edge B → Client B
```

**性能评估**：✅ 良好
- 额外延迟：Edge 间 UDP 网络延迟
- 无加密，传输效率高
- 路由表由 Hub 通过 `hub.routeTableUpdate` 推送，使用 Dijkstra 算法计算最优路径

**问题**：
- 明文传输（见 H-1）
- 路由表是快照，可能短暂过时

### 6.3 通过 Hub TCP 中继

```
Client A → Edge A → [RPC: edge.relayVoiceViaTcp] → Hub → [notify: hub.relayVoicePacket] → Edge B → Client B
```

**性能评估**：⚠️ 可用但低效
- 额外延迟：Edge→Hub + Hub→Edge 的两次 WebSocket 往返
- 每个语音包需要：JSON 序列化 → WebSocket 发送 → Hub 解码 → clone → 重新编码 → WebSocket 发送
- Hub 成为瓶颈：所有中继流量通过单 Hub
- 有全局中继带宽限制（`max_relay_bandwidth`）

### 6.4 路由决策逻辑

```rust
// udp.rs 中的路由决策（简化）：
match route_table.get(target_edge_id) {
    Direct     → UDP 直连 [0x01]
    RelayVia   → UDP 转发 [0x02] 到中继 Edge
    HubTcp     → RPC 通过 Hub 中继
    None       → 回退到 Hub TCP（如果允许）
}
```

**评估**：✅ 多层回退策略设计合理，优先使用最低延迟路径。

### 6.5 500 人频道的语音负载估算

假设 500 人频道，5 人同时说话（典型场景），Opus 40kbps 编码：

| 指标 | 每个发送者 | 5 个发送者合计 |
|------|-----------|---------------|
| 输入带宽 | 5 KB/s | 25 KB/s |
| 本地解密 | 5 KB/s × 1 | 25 KB/s |
| 本地加密（499 接收者） | 5 KB/s × 499 = 2.5 MB/s | 12.5 MB/s |
| 输出带宽（UDP） | 2.5 MB/s = 20 Mbps | 100 Mbps |
| OCB2 加密操作 | ~499 次/包 × 50 包/s = 24,950 ops/s | ~125,000 ops/s |

**结论**：
- 网络带宽（100 Mbps）在千兆网卡下可行
- OCB2 加密 CPU 是主要瓶颈，需要 4-8 核才能处理 12.5 万次/秒加密
- 如果 500 人分布在多个 Edge 上，跨 Edge 流量会分散负载
- **建议**：500 人频道应尽量安排在同一个 Edge 上以减少跨 Edge 流量

---

## 7. 控制信道分析

### 7.1 Edge → Hub RPC 通道

**协议**：WebSocket，Protobuf 二进制编码（`EdgeHubPacket`）

**请求匹配**：使用 `request_id` 字符串 + `oneshot` channel，支持乱序响应

**超时**：硬编码 30 秒

**问题**：
1. **RPC 和通知共用同一 WebSocket**：大量广播通知可能影响 RPC 响应延迟
2. **RPC 超时不可配置**：某些操作（如 fullSync）可能需要更长时间
3. **通知和 RPC 响应之间无顺序保证**：可能出现 `hub.userJoined` 通知先于 `edge.authenticateUser` 响应到达

### 7.2 Hub → Edge 通知推送

**机制**：Hub 通过存储在 `edge_connections` 中的 `mpsc::Sender` 推送通知

**通知类型**：
| 通知 | 用途 | 频率 |
|------|------|------|
| `hub.userJoined` | 用户加入集群 | 高 |
| `hub.userRemoveBroadcast` | 用户离开 | 高 |
| `hub.userMoved` | 用户切换频道 | 中 |
| `hub.userStateChanged` | 静音/耳聋等状态变化 | 中 |
| `hub.channelCreated/Removed/Updated` | 频道变更 | 低 |
| `hub.syncVoiceTarget` | 语音目标更新 | 中 |
| `hub.relayVoicePacket` | 语音中继 | 高（语音活跃时） |
| `hub.peerJoined/Left` | Edge 拓扑变化 | 低 |
| `hub.routeTableUpdate` | 路由表更新 | 低 |
| `hub.aclUpdated` | 权限变更 | 低 |
| `hub.shutdownRequest` | 分区时请求关机 | 极低 |

**问题**：
- 语音中继通知 (`hub.relayVoicePacket`) 与控制通知共用同一通道和缓冲区
- 大量语音中继可能挤占控制消息的缓冲区空间
- 无消息优先级区分

### 7.3 心跳机制

- 单向：Edge → Hub，Hub 被动检查
- 间隔：30 秒发送，180 秒超时
- 包含统计信息：用户数、频道数、在线时长

**问题**：
- Hub 不向 Edge 发送心跳 ack —— Edge 无法确认 Hub 是否收到
- 如果 Hub 进程挂起（不是崩溃），Edge 的心跳发送会成功（TCP 层面），但 Hub 不处理，导致检测延迟更长

---

## 8. Edge 间连接分析

### 8.1 Peer 发现

```
Hub 注册 Edge → Hub 向所有其他 Edge 广播 hub.peerJoined → 各 Edge 建立 PeerRegistry 记录
```

**机制**：Hub 作为 Peer 发现中心，Edge 间不直接发现。

**优点**：简单可靠，Hub 作为唯一事实来源。

**问题**：
- Hub 不可用时无法发现新 Peer
- 已知 Peer 的 UDP 地址更新依赖 Hub 通知

### 8.2 直连 UDP 建立

Edge 收到 `hub.peerJoined` 后，将 Peer 的 UDP 地址（host:voice_port）存入 `PeerRegistry`。后续语音发送直接使用此地址。

**问题**：
- 无 NAT 穿透：如果 Edge 在 NAT 后面，直连 UDP 不可达
- 无连接健康检查：仅依赖 Hub 的路由表更新来判断路径可用性
- 无 keep-alive：Peer 崩溃后，发送方继续向无效地址发送，直到 Hub 推送新路由表

### 8.3 Quality Probe 机制

Edge 间定期发送 Quality Probe（10 秒间隔）收集 RTT、丢包率、抖动：

```
[0x03][subtype(1)][sequence BE(4)][timestamp BE(8)]  — 14 字节探测包
```

每 30 秒向 Hub 上报质量数据。Hub 基于此数据通过 Dijkstra 算法重新计算路由表。

**评估**：✅ 设计合理
- 权重公式：`cost = rtt_ms + packet_loss × 500.0`
- 支持多跳中继路由（通过第三方 Edge 转发）

### 8.4 分区处理

当一个 Edge 报告无法连接另一个 Edge 时：

1. Hub 记录断连报告
2. 如果双方都报告无法连接对方（mutual disconnect），确认断连
3. 使用 Union-Find 检测连通分量
4. 向最小分区中的所有 Edge 发送 `hub.shutdownRequest`
5. 最小分区的 Edge 优雅关机，其用户断开后重新连接到剩余 Edge

**评估**：✅ 策略合理（保留最大分区），但实现存在不足：
- 仅在显式断连报告时触发，不会在心跳超时时自动检测
- 关机不可逆——最小分区无法重新加入

---

## 9. 2000 用户规模下的配置建议

### Hub 配置 (`hub.toml`)

```toml
[limits]
max_users            = 2000       # 从 1000 提升到 2000
max_users_per_channel = 500       # 限制单频道最大用户数
bandwidth            = 558000     # 558 kbps，Opus 40kbps 足够
message_rate         = 10.0       # 保持不变
message_burst        = 5          # 保持不变

[registry]
heartbeat_timeout = 30000         # 从 90000 降低到 30000（30 秒）

[voice_routing]
# 仅控制 Hub 是否接受来自 Edge 的 `edge.relayVoiceViaTcp` RPC 请求（Hub 侧 TCP 中继）。
# 不影响 Edge 间 UDP 直连或 UDP 多跳转发；后者由 Edge 侧 connection_strategy 控制。
enable_relay         = true
max_total_relay_streams = 200     # 设置上限防止 Hub 过载

[web_api]
host = "127.0.0.1"                # 绑定到 localhost，防止未授权访问
```

### Edge 配置 (`edge.toml`)

```toml
[server]
capacity = 1000                   # 单 Edge 最多 1000 用户

[hub_server]
pool_size          = 2            # 启用连接池
heartbeat_interval = 10000        # 从 30000 降低到 10000（10 秒）

[voice_routing]
# 控制 Edge 侧跨 Edge 语音路由策略（UDP 直连 / Hub TCP 中继 / 两者兼用）。
# 与 Hub 侧 voice_routing.enable_relay 相互独立：
#   - auto_fallback：优先 UDP 直连，失败后回退到 Hub TCP 中继（依赖 Hub 端 enable_relay=true）
#   - direct_only：仅 UDP 直连，完全不走 Hub TCP 中继
#   - tcp_only：始终走 Hub TCP 中继，不尝试 UDP 直连
connection_strategy = "auto_fallback"

[voice_routing.relay]
max_relay_bandwidth = 50000       # 50 Mbps（提升中继带宽上限）
```

> **语音中继配置分工说明**
>
> MuNode 有两个相互独立的中继控制层，语义容易混淆，需明确区分：
>
> | 配置项 | 所属端 | 控制范围 |
> |--------|--------|----------|
> | `[voice_routing] enable_relay` | **Hub** `hub.toml` | Hub 是否接受 Edge 发来的 `edge.relayVoiceViaTcp` RPC 请求（Hub 作为 TCP 中间人转发语音包）。仅影响 Hub TCP 中继这一段，不涉及 UDP。 |
> | `[voice_routing] connection_strategy` | **Edge** `edge.toml` | Edge 本身使用何种策略进行跨 Edge 语音路由：UDP 直连、Hub TCP 中继或自动回退。决定 Edge 是否会发起 `edge.relayVoiceViaTcp` RPC。 |
> | `[voice_routing.relay] max_relay_bandwidth` | **Edge** `edge.toml` | 当本 Edge 作为 UDP 多跳中继节点（`EDGE_PKT_RELAY`）时的出口带宽上限。与 Hub TCP 中继无关。 |
>
> 典型场景：若只想禁止 Hub 参与语音转发（强制所有 Edge 直连），应将 Hub 端 `enable_relay = false`，同时将所有 Edge 端 `connection_strategy = "direct_only"`。单独设置任一项只会影响一半路径。

### 部署建议

| 组件 | CPU | 内存 | 网络 | 数量 |
|------|-----|------|------|------|
| Hub | 4-8 核 | 2-4 GB | 1 Gbps | 1 |
| Edge（500 用户） | 4-8 核 | 2 GB | 1 Gbps | 2-4 |

- **500 人频道应尽量安排在同一 Edge** 上以避免跨 Edge 语音转发
- 如果不可避免分散，确保 Edge 间有低延迟直连
- 监控 Hub CPU（数据库操作是瓶颈）和 Edge CPU（OCB2 加密是瓶颈）

---

## 10. 已有优势总结

本次审查发现系统在以下方面设计良好：

1. **异步架构**：正确使用 tokio 异步运行时，RwLock/Mutex 用法整体合理
2. **多层语音路由回退**：直连 UDP → 中继 Edge UDP → Hub TCP，自动降级
3. **Hub 重连与指数退避**：Edge 断连后自动重连，带指数退避（100ms → 30s），避免雷暴效应
4. **路由表优化**：Dijkstra 最短路径算法 + Quality Probe 数据驱动
5. **listening_index 优化**：O(1) 查找频道中的监听者，避免了 O(N) 遍历
6. **带宽限制**：每用户滚动窗口带宽追踪，防止单用户过度占用
7. **OCB2-AES128 实现**：包含 XEX* 缓解、IV 回绕处理、tag 验证
8. **HMAC 注册认证**：Edge 注册使用 challenge-response 防止未授权 Edge 加入
9. **临时频道自动清理**：空的临时频道自动删除，向上级联清理
10. **热重载支持**：SIGHUP 信号可更新部分配置而不重启

---

## 问题优先级总结

| 编号 | 严重性 | 问题 | 影响 |
|------|--------|------|------|
| C-1 | 🔴 严重 | ~~数据库同步阻塞 async 运行时~~ ✅ 关键热路径已用 spawn_blocking 包装 | 2000 用户时级联超时 |
| C-2 | 🔴 严重 | ~~`try_send()` 静默丢弃关键广播~~ ✅ 改用 broadcast_critical_excluding | Edge 状态不一致 |
| C-3 | 🔴 严重 | Full Sync 无分页无压缩 | 重连风暴时超时 |
| H-1 | 🟠 高 | Edge 间语音明文传输 | 安全风险 |
| H-2 | 🟠 高 | ~~Relay Server 无认证无限制~~ ✅ 已添加 HMAC token 认证 | 安全 + DoS 风险 |
| H-3 | 🟠 高 | ACL 缓存无 TTL 无大小限制 | 内存泄漏 |
| H-4 | 🟠 高 | 优雅关机不足（200ms） | 用户体验差 |
| H-5 | 🟠 高 | 心跳超时 180 秒 | 幽灵用户 3 分钟 |
| M-1 | 🟡 中 | RPC 计数器用 Mutex | 性能瓶颈 |
| M-2 | 🟡 中 | Hub 中继多次内存拷贝 | Hub CPU 压力 |
| M-3 | 🟡 中 | ~~连接池默认未启用~~ ✅ pool_size = 3 已启用为推荐默认值 | 单点故障 |
| M-4 | 🟡 中 | Peer Registry 写锁阻塞语音 | 延迟尖峰 |
| M-5 | 🟡 中 | ~~Web API 无认证~~ ✅ 已实现 Bearer Token 认证 | 安全风险 |
| M-6 | 🟡 中 | Edge 边缘计算不足 | Hub 负载过高 |
| L-1 | 🟢 低 | UDP 源地址识别 O(N) | 启动期延迟 |
| L-2 | 🟢 低 | 临时频道清理级联查询 | 偶发延迟 |
| L-3 | 🟢 低 | Union-Find 递归实现 | 大规模时栈溢出 |
| L-4 | 🟢 低 | 带宽超标静默丢弃 | 用户无感知 |
| L-5 | 🟢 低 | 认证服务单连接 | 认证风暴瓶颈 |
