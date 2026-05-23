# Edge 间语音路由重设计：自适应多路径路由

**状态**：已实施（Steps 1–14）  
**适用版本**：munode-edge / munode-hub（待实现）  
**替代文档**：原 `connection_strategy` 配置项  

---

## 1. 现有方案的问题

### 1.1 静态策略无法适应网络变化

当前的 `VoiceConnectionStrategy` 枚举（`auto_fallback` / `direct_only` / `tcp_only`）是**静态的全局配置**，无法按 per-peer 路径质量动态调整：

| 策略 | 实际行为 | 主要缺陷 |
|------|----------|----------|
| `auto_fallback` | 优先直连 UDP，发送失败后回退 Hub TCP | UDP 质量已经很差但未完全失败时不会切换 |
| `direct_only` | 仅直连 UDP | UDP 不可达时语音直接丢失，无任何保护 |
| `tcp_only` | 始终走 Hub TCP | 即使双 Edge 有良好 UDP 连接也消耗 Hub 带宽和 CPU |

### 1.2 路由表单路径 + 更新延迟

Hub 在收到 `edge.reportQuality` RPC 后重新计算路由表，质量上报间隔为 **30 秒**。当前每个 target 只推送**一条最优路径**——当该路径恶化时，Edge 没有预备候选路径可用，只能等待 Hub 下次推送或直接回退 Hub TCP。

### 1.3 多跳 UDP 中继未充分利用

当前代码中：
- `RouteDecision::RelayVia { relay_edge_id: u32 }` 仅编码**一个**中继跳点
- Hub 的 `find_best_path()` 已经通过 Dijkstra + `prev` 回溯重建完整路径，但 `compute_route_table()` 输出时只取 `path[1]` 存入路由表
- 中继 Edge 收到 `0x02` 包后，**不查询自己到目标的路由表**，而是直接重建为 `0x01` 包发给最终目的地

例如拓扑：

```
Edge A ←——(高丢包)——→ Edge B
Edge A ←——(良好)———→ Edge C ←——(良好)———→ Edge D ←——(良好)———→ Edge B
```

当前代码在 C 处将 relay 包重建为 `[0x01][session][voice]` 直接发给 B，但 C 到 B 实际需要经过 D——**多跳链没有正确建立**。

### 1.4 UDP 不可达时只能走 Hub TCP

当前架构中，当 Edge 间 UDP 不可达时，唯一的回退路径是 Hub TCP 中继——这使得 Hub 成为语音流量的单点瓶颈。但很多场景下（如企业防火墙阻止 UDP 但放行 TCP），Edge 间的 TCP 连接是完全可达的，只是缺乏对应的传输通道。

### 1.5 内在的二元矛盾

`direct_only` / `tcp_only` / `auto_fallback` 要求管理员能提前知道网络状况——但在多数复杂网络环境（跨数据中心、NAT、云服务商间）中，这是不现实的。

### 1.6 `relay_port` 动态发现曾是死代码

当前实现已经把 WebSocket relay server（`relay_server.rs`）合并到 `edge_port`，并删除了 `hub_server.relay_port` 配置。但在旧设计中，动态发现曾依赖单独的 `relay_port` 元数据；而 **Hub 的 protobuf 消息（`HubClusterPeerJoinedParams`、`PeerInfoProto`）中并不传播该字段**，导致：

- `hub_client.rs` 在处理 `hub.peerJoined` 和 `edge.join` 时，始终将 `PeerEdgeInfo.relay_port` 设为 `None`
- `peer_registry.relay_peers()` 永远返回空列表
- `try_connect_via_relay` 中的动态 Peer 中继分支**永远不执行**

因此旧设计里，实际能用的控制中继发现方式**只有静态配置**（`hub_server.static_peers`）。

本次重设计的修复方案是**将 relay/voice WebSocket 服务合并至主端口（`edge_port`）**，而非在 protobuf 中新增 `relay_port` 字段。Edge 已通过 Hub 广播 `edge_port`，其他 Edge 无需额外字段即可派生 TCP 通道地址。主端口通过**协议探测**复用：传入连接首字节为 `0x16`（TLS ClientHello）时按 Mumble 客户端连接处理，否则视为明文 HTTP WebSocket 升级握手（relay/voice）。这使得 `PeerEdgeInfo.relay_port` 字段可随之废弃，同时控制中继路径（`/relay`）和语音通道（`/voice`）均由同一端口提供，无需额外开放防火墙规则。详见 Step 14。

---

## 2. 设计目标

1. **零配置自适应**：默认行为在大多数网络环境下都能给出合理结果，无需手动调节策略类型
2. **最低资源消耗（网络状况良好时）**：Edge 间直连 UDP 是标准路径；仅在必要时引入中继或 TCP 回退
3. **多跳 UDP 中继**：支持 Edge 链式转发语音包（最多 N 跳），充分利用 UDP mesh 拓扑
4. **Edge 间 TCP 通道**：当 UDP 不可达时，Edge 间可通过 TCP 直接传输语音，避免 Hub 成为瓶颈
5. **快速故障切换**：Hub 预推送多条候选路径，Edge 本地即时切换，无需等待 Hub 重算
6. **Hub 集中决策，Edge 轻量执行**：路由策略和质量阈值由 Hub 统一管理，Edge 仅负责发包和即时故障检测
7. **防环保障**：多跳路径中引入 TTL 防止包循环

---

## 3. 核心概念

### 3.1 路径类型（Path Types）

```
DirectUdp                                      — Edge A → Edge B（直连 UDP）
DirectTcp                                      — Edge A → Edge B（直连 TCP，无中间跳）
RelayChain { hops: Vec<u32>,
             transports: Vec<Transport> }      — Edge A → … → Edge B（混合多跳中继）
HubTcp                                         — Edge A → Hub → Edge B（Hub TCP 中继，最后手段）
```

其中 `Transport = Udp | Tcp`，`transports[i]` 指定**发向 `hops[i]` 时所使用的传输层**（对于最后一跳中继节点而言，其向目标发送的传输层从该 Edge 自身的路由表中读取）。

**路径选择由 Hub 侧代价模型决定**（见 §3.2），不存在固定的类型优先级。代价最低的路径排在候选列表最前面——可能是 DirectUdp，也可能是 RelayChain 或 DirectTcp，取决于实时链路质量和配置参数。当两条路径代价相近时，类型惩罚参数（`relay_hop_penalty_ms`、`edge_tcp_penalty_ms`、`hub_tcp_penalty_ms`）隐式表达了偏好：UDP 路径零附加惩罚 → DirectTcp +20ms → HubTcp +50ms。

`RelayChain` 替代现有的 `RelayVia { relay_edge_id: u32 }`，存储完整中继链与每跳传输层，不再局限于 UDP：

- `RelayChain([C], [Udp])` = A → C → B，A→C 走 UDP（等同于现有 `RelayVia(C)`）
- `RelayChain([C], [Tcp])` = A → C → B，A→C 走 TCP WebSocket
- `RelayChain([C, D], [Udp, Tcp])` = A→C UDP → C→D TCP → D→B（D 的路由表决定最终段）

`DirectTcp` 是原 `EdgeTcp` 的重命名：Edge A 通过已有的 Edge-to-Edge WebSocket 直接向 Edge B 传输语音帧，无中间中继节点。与 HubTcp 的区别在于不经过 Hub 中转，延迟更低且不消耗 Hub 带宽。

### 3.2 路径代价模型（Path Cost Model）

Hub 侧计算，每条路径的代价用毫秒度量：

$$\text{cost}(\text{path}) = \sum_{e \in \text{links}} \bigl(\text{rtt}(e) + \text{loss}(e) \times P_{loss}\bigr) + H \times (\text{hops} - 1) + C_{\text{mode}}$$

其中：
- $\text{rtt}(e)$：链路 e 的探测平均 RTT（毫秒）
- $\text{loss}(e)$：链路 e 的丢包率（0.0–1.0）
- $P_{loss} = 500$：丢包惩罚系数（与现有 Dijkstra 一致，100% 丢包等价于 +500ms）
- $H$：每跳额外惩罚（默认 5ms，反映转发处理开销），Hub 可配置
- $C_{\text{mode}}$：路径类型附加惩罚

**路径类型惩罚** $C_{\text{mode}}$：

| 路径类型 | 附加惩罚 | 说明 |
|----------|----------|------|
| `DirectUdp` | 0 ms | 无附加代价 |
| `RelayChain(N hops)` | $N \times H$（已含在上式中） | 每跳转发开销；各跳传输层不影响基础惩罚 |
| `DirectTcp` | +20 ms（Hub 可配置） | TCP 协议开销，但不经过 Hub |
| `HubTcp` | +50 ms（Hub 可配置） | Hub 中转开销 + 瓶颈风险 |

> **Dijkstra 双轨建图**：Hub 对每对 Edge 同时建模 **UDP 边**和 **TCP 边**，两者代价独立计算（分别使用探测得到的 UDP RTT 和 TCP RTT）。路径搜索时可以在同一条路径中混用 UDP 跳和 TCP 跳，Dijkstra 自然找到代价最低的组合。详见 §7.1。

### 3.3 多候选路径与 Edge 本地故障切换

**核心改进**：Hub 为每个 target 推送**多条按代价排序的候选路径**（默认最多 3 条），而非仅推送一条最优路径。

Edge 本地仅维护**每个 next-hop 的连续失败计数**（`consecutive_failures: u32`），用于即时故障检测：

```
对于目标 Edge B，Hub 推送的候选路径列表（按代价升序）：
  [0] RelayChain([C], [Udp])  cost=45
  [1] Direct                  cost=55
  [2] DirectTcp(B)            cost=56
  [3] HubTcp                  cost=90

Edge 发包逻辑：
1. 尝试候选 [0]：检查 next_hop=C 的 consecutive_failures < threshold → 发送
2. 若 [0] 的 next-hop 失败次数 >= threshold → 跳过，尝试 [1]
3. 若 [1] 也失败 → 尝试 [2]（Edge TCP 直连 B）
4. 若 [2] 不可用（无 TCP 连接）→ 尝试 [3]（Hub TCP）
5. 所有候选均不可用 → 丢弃（仅在 enable_hub_tcp_fallback=false 时）
```

**失败计数重置**：
- UDP 发送成功 → 重置该 next-hop 的 `consecutive_failures`
- 收到该 peer 的 Quality Probe pong → 重置 `consecutive_failures`
- Hub 推送新路由表 → 清除所有失败计数（Hub 基于最新质量数据重新评估）

这个设计将路由策略的复杂性集中在 Hub 侧（Dijkstra 计算、质量阈值评估、多路径排序），Edge 侧只做最简单的事：**按序尝试、失败跳过**。

---

## 4. 路由决策流程

### 4.1 Edge 发包决策

```
对于目标 Edge B:

1. 查询 Hub 推送的候选路径列表 route_table[B] → Vec<RouteCandidate>（已按代价排序）

2. 遍历候选列表:
   a. DirectUdp → 检查 peer_registry 中 B 的 UDP 地址 + next_hop_failures[B] < threshold
   b. RelayChain(hops, transports) → 检查 hops[0] 的地址（UDP 或已建立的 TCP 连接）+ next_hop_failures[hops[0]] < threshold
   c. DirectTcp → 检查与 B 的 TCP 连接是否处于已连接且活跃状态（连接由 Edge 启动后主动建立，见 §6.3）
   d. HubTcp → 检查 Hub 连接可用 + enable_hub_tcp_fallback

3. 选择第一个可用的候选路径

4. 如果所有候选均不可用:
   - 若 enable_hub_tcp_fallback = true 且 Hub 连接可用 → 强制走 HubTcp
   - 否则 → 丢弃语音包，输出 warn! 日志
```

### 4.2 路径切换行为

由于 Hub 预推送了多条候选路径，Edge 侧的路径切换变得简单：

- **降级**（当前路径 next-hop 连续失败）：**立即**切换到下一个候选，无需等待 Hub
- **恢复**（Hub 推送新路由表，含更优路径）：收到新路由表后**立即**生效，因为 Hub 侧已经完成了质量评估和防抖

Hub 侧负责路径切换的防抖和稳定性：
- **hysteresis**：Hub 在路由表计算中引入迟滞，路径恢复后需连续多个上报周期（30s × N）质量达标才会重新推荐
- **min_improvement**：新路径的代价必须比当前路径低至少一个阈值才会更新路由表

这把"快速降级、缓慢恢复"的策略完全放在 Hub 侧，Edge 无需关心。

---

## 5. 多跳 UDP 协议调整

### 5.1 现有 Edge 间包格式

```
0x01  [0x01][sender_session BE(4)][voice payload]
      直接交付包（终极目的地为本 Edge）

0x02  [0x02][target_edge_id BE(4)][sender_session BE(4)][voice payload]
      中继转发包（本 Edge 为中间节点，需转发给 target）

0x03  [0x03][subtype(1)][seq BE(4)][sent_ms BE(8)]
      Quality Probe（保持不变）
```

### 5.2 问题

当前中继 Edge 收到 `0x02` 包后，直接将 payload 封装成 `0x01` 发给 `target_edge_id`——不查询自己到 `target_edge_id` 的路由表。这导致多跳路径无法建立。

### 5.3 新协议：添加 TTL 字段

将 `0x02` 包的格式升级为：

```
0x02  [0x02][ttl(1)][target_edge_id BE(4)][sender_session BE(4)][voice payload]
      中继转发包（+1 字节 TTL）
      ● ttl: 剩余跳数（初始值 = relay_chain 长度，每跳递减 1）
      ● target_edge_id: 最终目的地 Edge ID（不变）
      ● sender_session: 原始发送者 session ID（不变）
```

TTL 初始值由发送端根据 relay_chain 长度设定（Hub 计算出的路径长度即为自然上限），Hub 的 `max_relay_hops` 配置作为协议层安全上限。

**传输层通用性**：`0x02` 包格式同时适用于 UDP socket 和 TCP WebSocket 传输。发送 Edge 根据路由条目中当前跳的 `transports[i]` 字段决定通信通道：
- `Udp` → 直接通过 UDP socket 发送
- `Tcp` → 通过与该 peer 建立的 `/voice` WebSocket 连接，以二进制帧发送

接收端（无论是通过 UDP 还是 TCP 收到 `0x02` 包）均按同一转发逻辑处理，中继逻辑与传输层无关。

### 5.4 新的中继转发逻辑

```
收到 [0x02][ttl][target][session][voice] 时:

1. 若 ttl == 0 → 丢弃包，输出 debug! 日志（TTL 耗尽，防止循环）

2. 若 target == self.edge_id → 按 [0x01] 逻辑处理（交付给本地客户端）

3. 查询本地路由候选列表 route_table[target]，选择第一个可用候选:
   a. Direct 且 next-hop 可达:
      → 封装 [0x01][session][voice] 直发 target
   b. RelayChain(hops) 且 ttl > 1 且 next-hop 可达:
      → 封装 [0x02][ttl-1][target][session][voice] 发给 hops[0]
   c. HubTcp 或无可用 UDP 路径:
      → relay_voice_via_hub(target, session, voice)
   d. 全部不可用 → 丢弃，输出 warn!
```

关键点：**TTL 防环** + **中间节点查路由表**，两者合力实现真正的多跳转发。

### 5.5 非对称链路质量测量

当前 `0x03` 探针（ping/pong）只能测量**往返 RTT**，但实际链路的延迟和丢包往往是非对称的（A→B 与 B→A 可能差异显著）。若直接使用往返 RTT 建图，Dijkstra 会对两个方向使用相同代价，当链路非对称时路由决策会出现偏差（例如用质量差的 B→A 方向返回语音）。

**协议扩展**：Pong 包携带发送时间戳，使接收端可以计算单向延迟：

```
0x03 Ping: [0x03][0x00][seq BE(4)][ping_sent_ms BE(8)]               — 14 字节（不变）
0x03 Pong: [0x03][0x01][seq BE(4)][ping_sent_ms BE(8)][pong_sent_ms BE(8)]  — 22 字节（+8 字节）
```

- `ping_sent_ms`：回显 Ping 的发送时间戳
- `pong_sent_ms`：Pong 包发出时的本地时间戳

Ping 发送者收到 Pong 后可计算：
- `rtt = now_ms - ping_sent_ms`（往返，与原方案一致）
- `one_way_B→A = now_ms - pong_sent_ms`（B 发出 Pong 到 A 收到的单向延迟）
- `one_way_A→B ≈ rtt - one_way_B→A`（估算，受时钟漂移影响）

Hub 在 Dijkstra 中使用**有向边**：A 上报的"A→B RTT"和"A 侧测得的 B→A 单向延迟"对应两条方向不同的边。TCP 探针（WebSocket Ping/Pong）采用相同的时间戳扩展方案。

> **时钟漂移说明**：各 Edge 的系统时钟不同步，`one_way_A→B` 的绝对值意义有限，但**变化趋势**和**与对端测量的对比**足以检测方向性不对称。Hub 侧只需比较 `rtt_A_measures / 2` 与 `rtt_B_measures / 2` 的差异即可近似判断非对称程度，单向时间戳作为更精确的辅助数据。

## 6. Edge 间 TCP 语音通道

### 6.1 动机与适用场景

当前 Edge 间 UDP 不可达时，唯一的回退是 Hub TCP 中继——Hub 成为所有 TCP 语音流量的瓶颈。在以下场景中，Edge 间 TCP 直连优于 Hub TCP：

| 场景 | Edge TCP 效果 | 说明 |
|------|--------------|------|
| 企业防火墙阻止 UDP 但放行 TCP | ✅ 直接可用 | 最常见的 UDP 失败原因之一 |
| 跨云/跨数据中心的 TCP 可达 | ✅ 避免 Hub 瓶颈 | Hub 通常部署在单个数据中心 |
| NAT 对称型，UDP 穿透失败 | ✅ TCP 可通过 NAT | TCP 连接建立比 UDP 穿透更可靠 |
| Edge 和 Hub 之间链路拥塞 | ✅ 绕过 Hub | Edge 间可能有更好的直连路径 |
| Edge 间完全网络隔离（L3 不可达） | ❌ TCP 同样失败 | 此时只能走 Hub TCP 中继 |

### 6.2 复用现有基础设施

每个 Edge 已在 `edge_port` 上运行主 TCP 监听器（接受 Mumble 客户端的 TLS 连接）。本次重设计将 relay/voice WebSocket 服务**合并至同一端口**，通过协议探测区分连接类型——TLS 握手（首字节 `0x16`）转至 Mumble 处理器，明文 HTTP Upgrade 转至 WebSocket 路由器：

```
控制中继（现有，改为 edge_port）:  ws://edge-b:edge_port/relay
语音传输（新增，同端口）:          ws://edge-b:edge_port/voice
```

语音 WebSocket 连接建立后，双方通过二进制帧传输语音包，支持两种帧类型：

```
[0x01][session BE(4)][voice payload]   — 直接交付（本 Edge 为终点）
[0x02][ttl(1)][target_edge_id BE(4)][session BE(4)][voice payload]  — 中继转发（本 Edge 为中间节点）
```

即与 UDP 信道使用**同一套包格式**，无需额外封装。TCP WebSocket 端点同时处理两种类型，转发逻辑与 UDP 收包路径一致（见 §5.4）。

> **前置条件：端口合并（Step 14）**
>
> 当前 relay server 独立运行在 `edge_port + 2`，而 `PeerEdgeInfo.relay_port` 始终为 `None`（§1.6），导致动态发现无法工作。修复方案是将 relay/voice WebSocket 服务合并至 `edge_port`，使 Edge A 只需知道 Edge B 的 `host` 和 `edge_port`（Hub 已广播）即可建立 `/voice` 连接，无需单独传播 `relay_port`。

### 6.3 连接管理

- **主动建立（Proactive）**：Edge 启动后或收到新 `peerJoined` 通知后，立即尝试向所有已知 peer 建立 `/voice` WebSocket 连接，而非等到首次发包时才建立。这消除了"首次使用延迟"，并使 TCP RTT 探测在路由计算前就能运行（Hub 收到真实 TCP 质量数据后才能准确建模 DirectTcp 代价）。
- **端口发现**：使用 `PeerEdgeInfo` 中的 `host` 和 `edge_port`（Hub 已广播，无需额外字段），拼接 `/voice` 路径建立连接
- **TCP RTT 探测**：连接建立后，Edge 通过 WebSocket Ping/Pong（RFC 6455 §5.5.2）定期探测 TCP RTT，间隔与 UDP 一致（10s），并在上报周期（30s）通过 `edge.reportQuality` 的 TCP 变体上报实测 RTT（当前 `reportQuality` 仅上报 UDP 探测数据，需新增 TCP 来源标记或独立 RPC 字段）
- **超时回收**：若 60s 内持续无 Pong 响应或连接断开，关闭连接并标记该 peer 的 DirectTcp 为不可用；Hub 在下一个报告周期收不到 TCP 质量数据时，将该 TCP 边的估算代价调高（保守系数 1.5×UDP RTT），自然降低其在 Dijkstra 中的优先级
- **重连策略**：TCP 连接断开后以指数退避（1s → 2s → 4s，上限 60s）重试；重试期间该 peer 的 DirectTcp 候选标记为不可用，Edge 自动降级到下一候选路径，无需等待 Hub

### 6.4 代价模型中的 DirectTcp

Hub 在 Dijkstra 中为每对 Edge 同时建模 UDP 边和 TCP 边（详见 §7.1）。对于 A→B 的 TCP 直连（无中间跳），其代价为：

$$\text{cost}(\text{DirectTcp}) = \begin{cases} \text{rtt}_{tcp}(A,B) + C_{\text{edge\_tcp}} & \text{若已有 TCP RTT 探测数据} \\ \text{rtt}_{udp}(A,B) \times 1.5 + C_{\text{edge\_tcp}} & \text{若 TCP 连接尚未建立或无探测数据} \end{cases}$$

说明：
- $\text{rtt}_{tcp}$：Edge 侧 WebSocket Ping/Pong 测得的实际 TCP RTT，经 `edge.reportQuality`（TCP 变体）上报给 Hub
- $C_{\text{edge\_tcp}}$：Hub 可配置的惩罚（默认 20ms），反映 TCP 重传、排头阻塞等协议开销
- 无数据时保守系数取 **1.5**（而非之前的 1.2）：连接未建立时不应低估 TCP 路径代价，避免 Dijkstra 错误地将 DirectTcp 排在更优的 UDP 路径之前
- 一旦 TCP 连接建立并完成首次 Ping/Pong，Hub 即切换为使用实测值，代价估算更准确

DirectTcp 的惩罚（20ms）低于 HubTcp（50ms），确保在 UDP 不可达但 Edge 间 TCP 可达时优先选择 DirectTcp（或 TCP 中继链）。

当路径为 **TCP 中继链**（`RelayChain` 中某跳 transport = Tcp）时，该段链路代价直接使用其 TCP RTT（探测数据来自 §6.3 的 WebSocket Ping/Pong 机制），不再需要用 UDP RTT 乘以系数估算。

### 6.5 RelayChain 与 DirectTcp 的优先关系

路径选择**没有固定的类型优先级**——完全由 Hub 侧的 Dijkstra 代价模型决定。类型惩罚参数（`edge_tcp_penalty_ms = 20`）作为 Dijkstra 中的隐式偏好——在代价接近时倾向于 UDP 路径，但如果 UDP 路径代价确实更高，模型会自然选择 DirectTcp 或 TCP 中继链。

（假设 A→B 直连 TCP RTT 已由探测得出为 32ms）

| 条件 | RelayChain(UDP) 代价 | DirectTcp 代价（实测） | 结论 |
|------|---------------------|----------------------|------|
| A→C(10ms,1%) + C→B(15ms,2%) | 15 + 25 + 5 = **45ms** | 32 + 20 = **52ms** | RelayChain 胜 |
| A→C(40ms,10%) + C→B(40ms,10%) | 90+90+5 = **185ms** | 32 + 20 = **52ms** | DirectTcp 胜 |
| UDP 完全被防火墙阻止 | ∞（不可用） | 32 + 20 = **52ms** | DirectTcp 胜 |
| 仅有 3 跳高延迟链 | 高累积 RTT + 3×5ms | A→B 直连 TCP | DirectTcp 可能胜 |

### 6.6 TCP 信道上的中继转发

本期设计**支持** TCP 信道承载中继转发（即 `0x02` 包可通过 `/voice` WebSocket 连接发送和接收）。

由于 Hub Dijkstra 同时对每对 Edge 建模 UDP 边和 TCP 边（见 §7.1），路径搜索时可以自然地找出混合传输层的路径：

| 示例路径 | 传输层 | 适用场景 |
|---------|--------|---------|
| A→C→B | A→C: UDP，C→B: TCP | C-B 之间 UDP 被阻，但 TCP 可达 |
| A→C→B | A→C: TCP，C→B: UDP | A-C 之间 UDP 被阻，但 A-C TCP 可达且 C-B UDP 良好 |
| A→C→D→B | A→C: Udp，C→D: Tcp，D→B: Udp | 混合多跳 |

**实现方案：**

1. **路由条目含传输层**：Hub 推送的 `RelayChain` 条目携带 `transports: Vec<Transport>`，每个元素对应一跳的出向传输层（见 §3.1 和 §7.3）
2. **发送端判断传输层**：Edge 发送 `0x02` 时，根据路由条目 `transports[0]` 选择 UDP socket 或 TCP WebSocket 连接
3. **接收端处理统一**：无论 `0x02` 包通过 UDP 还是 TCP 到达，接收端查询路由表选择下一跳，按下一跳的传输层继续转发
4. **TCP 中继质量上报**：TCP 链路的质量由 §6.3 的 WebSocket Ping/Pong 机制独立测量，数据输入同一套 `edge.reportQuality` 上报流程

**关于排头阻塞影响**：单段 TCP 跳的 HOL 阻塞影响是局部的；多段 TCP 跳叠加时 Hub 可以通过配置较高的 `relay_hop_penalty_ms`（TCP 版本）来隐式降低全 TCP 中继链的竞争力，这取决于部署策略。

### 6.7 与 HubTcp 的关系

- **DirectTcp**：Edge A 直接 WebSocket 连 Edge B，延迟 = A→B 的 TCP RTT
- **TCP 中继链**：A→C→B（via TCP），延迟 = TCP RTT(A→C) + TCP RTT(C→B)，仅在 UDP 不可达时被 Dijkstra 选出
- **HubTcp**：Edge A → Hub → Edge B，延迟 = A→Hub RTT + Hub→B RTT + Hub 处理时间

即使在最好情况下，HubTcp 的延迟也是 DirectTcp 的两倍以上。DirectTcp 的引入使得 HubTcp 真正成为"最后手段"——只有当 Edge 间完全不可达时才会用到。

---

## 7. Hub 侧变更

### 7.1 Dijkstra 双轨建图 + 多候选

**当前行为**：`find_best_path()` 已经使用 `prev: HashMap<u32, u32>` 回溯重建完整路径，但 `compute_route_table()` 只提取 `path[1]` 作为 `next_hop`；图中每对 Edge 只有一条 UDP 边。

**新行为**：

1. **双轨建图**：对每对 Edge 同时建模 **UDP 边**（代价 = `rtt_udp + loss×P_loss`）和 **TCP 边**（代价 = `rtt_tcp + P_edge_tcp`，无 TCP 探测数据时使用 `rtt_udp × 1.5 + P_edge_tcp`）。两类边在同一图中参与 Dijkstra 搜索，路径可以混用 UDP 跳和 TCP 跳。
2. **输出完整中继链 + 传输层**：`compute_route_table()` 提取完整路径的中间节点列表（`hops`）以及每跳使用的边类型（`transports`）；直连路径（无中间节点）根据边类型输出 `DirectUdp` 或 `DirectTcp`。
3. **多候选路径**：对每个 target，运行 K-shortest-paths（或多次 Dijkstra 排除已选路径的首跳），输出最多 `max_route_candidates` 条候选路径。
4. **长度限制**：中继链长度超过 `max_relay_hops` 的路径改为 `HubTcp`。
5. **Hub TCP 建模**：Hub 作为特殊节点加入图中，入度/出度代价 = `rtt_to_hub + hub_tcp_penalty_ms / 2`。

返回类型：

```rust
pub enum HopTransport { Udp, Tcp }

pub struct RouteEntry {
    pub target_edge_id: u32,
    pub path: RoutePath,
    pub cost: f32,
}

pub enum RoutePath {
    DirectUdp,
    DirectTcp,
    RelayChain {
        hops: Vec<u32>,
        transports: Vec<HopTransport>,  // transports[i] = 到达 hops[i] 时使用的传输层
    },
    HubTcp,
}

/// 每个 target 返回多条候选，按 cost 升序
pub fn compute_route_table(&self, for_edge_id: u32) -> Vec<RouteEntry>
```

### 7.2 Hub 侧路由质量评估

Hub 在收到 `edge.reportQuality` 后，利用 Hub 侧配置的质量阈值决定路由推荐策略：

- 当某条直连链路的丢包率超过 `degraded_packet_loss` 阈值时，Dijkstra 的代价模型自然会将中继路径排在前面
- 当丢包率超过 `failed_packet_loss` 阈值时，Hub 可以直接将该链路从图中移除，确保不会被选为候选路径的一部分
- Hub 负责**防抖**：路径恢复后需要连续 N 个上报周期（30s × `recovery_report_count`）质量达标才重新纳入候选

### 7.3 Route Table 通知协议

现有 `HubRouteEntryProto`：

```protobuf
message HubRouteEntryProto {
    uint32 target_edge_id = 1;
    uint32 route_type = 2;    // 0=Direct, 1=RelayVia, 2=HubTcp
    optional uint32 next_hop = 3;
    float cost = 4;
}
```

替换为：

```protobuf
// 传输层类型
enum HopTransportProto {
    UDP = 0;
    TCP = 1;
}

message HubRouteEntryProto {
    uint32 target_edge_id = 1;
    uint32 route_type = 2;              // 0=DirectUdp, 1=DirectTcp, 2=RelayChain, 3=HubTcp
    repeated uint32 relay_chain = 3;    // 完整中继链（不含源和目的）
    repeated uint32 relay_transports = 4; // 每跳传输层：relay_transports[i] 对应 relay_chain[i]（0=UDP, 1=TCP）
    float cost = 5;
}

message HubRouteTableUpdateParams {
    repeated HubRouteEntryProto routes = 1;
    // 同一 target 出现多条记录 = 多候选路径（按 cost 升序排列）
    uint32 max_ttl = 2;  // 集群级 TTL 上限，Edge 发送 0x02 包时使用
}
```

Edge 侧解析：按 `target_edge_id` 分组，每组构成一个候选列表：

```rust
// route_table: HashMap<u32, Vec<RouteCandidate>>
// 每个 target_edge_id → 候选路径列表（按 cost 升序，与 Hub 推送顺序一致）
```

---

## 8. 配置设计

### 设计原则

**Hub 集中管理路由策略，Edge 只保留必须本地决定的配置。**

路径质量阈值、代价模型参数、切换防抖策略都是集群范围的策略，没有根据不同 Edge 节点环境单独配置的必要——它们应该统一在 Hub 侧配置。Edge 本地仅需要：
- 是否允许 Hub TCP 回退（运维级开关）
- 连续失败阈值（纯粹的本地故障检测参数）
- 中继节点配置（本 Edge 的中继能力）

### 8.1 废除的配置项

```toml
# ❌ 全部废除
[voice_routing]
connection_strategy = "auto_fallback"

[voice_routing.fallback]
enable_tcp_fallback = false
tcp_fallback_delay = 0
udp_recovery_check_interval = 0
```

### 8.2 Edge 侧配置（`edge.toml`）

```toml
[voice_routing]
# 是否启用跨 Edge 语音路由（总开关，默认 true）
enabled = true

# 是否允许在所有 UDP 路径不可用时使用 Hub TCP 作为最终回退
# 建议保持 true，除非 Hub 带宽严格受限
enable_hub_tcp_fallback = true

# 连续 UDP 发送失败次数达到此值后，跳过该 next-hop 尝试下一个候选路径
# 用于应对 UDP 地址突变（NAT 重映射）等快速失效场景
# 置 0 则禁用本地故障跳过（完全依赖 Hub 路由表更新）
consecutive_failure_threshold = 2

[voice_routing.relay]
# 是否允许本 Edge 作为其他 Edge 的 UDP 语音中继节点
enabled = true

# 本 Edge 作为中继节点的出口带宽上限（Kbps，0 = 不限制）
max_relay_bandwidth = 0
```

这就是 Edge 侧的全部配置——**5 个字段**，全部都是与本节点能力直接相关的运维参数。

### 8.3 Hub 侧配置（`hub.toml`）

现有字段 `enable_relay` **需要改名为 `enable_hub_tcp_relay`**。当前名称的字面意思是"是否启用中继功能"，容易误解为控制所有中继（包括 Edge 间 UDP 中继），但实际上它只控制 Hub 是否接受 `edge.relayVoiceViaTcp` 单向通知。改名后语义明确：只控制 Hub 作为 TCP 中继节点的开关。

```toml
[voice_routing]
# ─── Hub TCP 中继控制 ───
# Hub 是否接受 edge.relayVoiceViaTcp 单向通知（仅控制 Hub TCP 中继，不影响 Edge 间 UDP 中继）
# 原名 enable_relay，改名以避免歧义
enable_hub_tcp_relay = true
# Hub TCP 中继的全局带宽上限（Kbps，0 = 不限制）
max_total_relay_bandwidth = 0
# 最大同时中继流数/每对 Edge（0 = 不限）
max_relay_streams_per_pair = 0
# 最大同时中继流数/全局（0 = 不限）
max_total_relay_streams = 0

# ─── 拓扑与路由计算 ───
# 最大 UDP 多跳中继数（不含源和目标节点，超出则改为 HubTcp）
max_relay_hops = 2
# 每个 target 推送的最大候选路径数
max_route_candidates = 3

# ─── Dijkstra 代价模型参数 ───
# 丢包惩罚系数（ms），100% 丢包等价于 +N ms
packet_loss_penalty_ms = 500
# 每跳 UDP 中继的附加惩罚（ms）
relay_hop_penalty_ms = 5
# Edge TCP 直连在 Dijkstra 中的附加惩罚（ms）
edge_tcp_penalty_ms = 20
# Hub TCP 路径在 Dijkstra 中的附加惩罚（ms）
hub_tcp_penalty_ms = 50

# ─── 链路质量阈值 ───
# 丢包率超过此值的链路被标记为降级（Dijkstra 代价自然惩罚，但仍参与计算）
degraded_packet_loss = 0.10
# 丢包率超过此值的链路被从图中移除（不参与任何路径计算）
failed_packet_loss = 0.40
# RTT 超过此值的链路被标记为降级
degraded_rtt_ms = 150
# RTT 超过此值的链路被从图中移除
failed_rtt_ms = 500

# ─── 路由稳定性（防抖） ───
# 路径恢复后需要连续 N 个上报周期（30s × N）质量达标才重新纳入候选
recovery_report_count = 3
# 路径切换的最小代价差阈值（ms），低于此差值不触发路由表更新
min_improvement_ms = 25
```

### 8.4 配置对比（现有 vs 新设计）

**Edge 侧：**

| 现有字段 | 新设计 | 说明 |
|----------|--------|------|
| `connection_strategy` | 删除 | 自适应替代静态策略 |
| `fallback.enable_tcp_fallback` | `enable_hub_tcp_fallback` | 语义等价，简化命名 |
| `fallback.tcp_fallback_delay` | 删除 | 多候选路径即时切换替代延迟 |
| `fallback.udp_recovery_check_interval` | 删除 | Hub 侧 recovery_report_count 替代 |
| `relay.enabled` | 保留 | 不变 |
| `relay.max_relay_bandwidth` | 保留 | 不变 |
| — | `consecutive_failure_threshold` | 新增，本地快速故障检测 |

**Hub 侧：**

| 现有字段 | 新设计 | 说明 |
|----------|--------|------|
| `enable_relay` | **`enable_hub_tcp_relay`**（改名） | 原名歧义，字面意思像控制所有中继，实际只控制 Hub TCP 中继 |
| `max_relay_streams_per_pair` | 保留 | 不变 |
| `max_total_relay_streams` | 保留 | 不变 |
| `relay_cost_factor` | `relay_hop_penalty_ms` | 更精确的每跳代价（ms 而非倍数） |
| `direct_rtt_threshold` | `degraded_rtt_ms` / `failed_rtt_ms` | 细化为两级阈值 |
| `direct_loss_threshold` | `degraded_packet_loss` / `failed_packet_loss` | 细化为两级阈值 |
| — | `max_relay_hops` | 新增，控制多跳上限 |
| — | `max_route_candidates` | 新增，控制候选路径数 |
| — | `edge_tcp_penalty_ms` | 新增，Edge TCP 在 Dijkstra 中的代价 |
| — | `hub_tcp_penalty_ms` | 新增，Hub TCP 在 Dijkstra 中的代价 |
| — | `packet_loss_penalty_ms` | 新增，使丢包惩罚系数可配置 |
| — | `recovery_report_count` | 新增，路径恢复防抖 |
| — | `min_improvement_ms` | 新增，路径切换防抖 |

---

## 9. 数据结构变更

### 9.1 `RouteDecision` 枚举（`munode-edge/src/state.rs`）

```rust
// 现有
pub enum RouteDecision {
    Direct,
    RelayVia { relay_edge_id: u32 },
    HubTcp,
}

// 新设计
pub enum HopTransport { Udp, Tcp }

pub enum RouteDecision {
    DirectUdp,
    DirectTcp,                          // 原 EdgeTcp
    RelayChain {
        hops: Vec<u32>,                 // 完整中继链，不含源和目的
        transports: Vec<HopTransport>,  // transports[i] = 到达 hops[i] 时使用的传输层
    },
    HubTcp,
}
```

### 9.2 路由表结构（`munode-edge/src/state.rs`）

```rust
/// 单条路由候选
pub struct RouteCandidate {
    pub decision: RouteDecision,
    pub cost: f32,
}

/// EdgeState 变更
pub struct EdgeState {
    // ... 现有字段 ...

    /// 路由表：target_edge_id → 候选路径列表（按 cost 升序，Hub 推送）
    pub route_table: RwLock<HashMap<u32, Vec<RouteCandidate>>>,

    /// 每个 next-hop 的连续发送失败计数
    /// key = next_hop edge_id（不是 target，因为 RelayChain 首先发往 next_hop）
    pub next_hop_failures: RwLock<HashMap<u32, u32>>,

    /// Hub 推送的集群级 TTL 上限
    pub max_ttl: AtomicU32,
}
```

### 9.3 Edge TCP 连接管理（新增，`munode-edge/src/state.rs`）

```rust
pub struct VoiceTcpConn {
    pub sender: mpsc::Sender<Vec<u8>>,  // 发送语音帧到 WebSocket
    pub last_active: Instant,
}

/// EdgeState 新增字段
pub struct EdgeState {
    // ... 现有字段 ...

    /// Edge 间语音 TCP 连接池
    /// key = target edge_id, value = WebSocket sender handle
    /// 按需建立，空闲超时回收
    pub voice_tcp_conns: RwLock<HashMap<u32, VoiceTcpConn>>,
}
```

### 9.4 路由决策快照（`munode-edge/src/udp.rs`）

```rust
struct RouteSnapshot {
    /// target → 候选列表
    route_table: HashMap<u32, Vec<RouteCandidate>>,
    peer_registry: HashMap<u32, SocketAddr>,
    /// next-hop → 连续失败次数
    next_hop_failures: HashMap<u32, u32>,
    consecutive_failure_threshold: u32,
    allow_hub_relay: bool,
    my_edge_id: u32,
    max_ttl: u32,
}
```

快照在每次 `by_edge` 循环开始前一次性获取，避免在热路径上持锁。

---

## 10. 关键实现步骤

> 本节为实现者提供指引，按依赖顺序排列。

### Step 1：扩展 `RouteDecision` 枚举

将 `RelayVia { relay_edge_id }` 改为 `RelayChain { hops: Vec<u32> }`。更新所有 match 语句，对于 `RelayChain` 取 `hops[0]` 作为 next_hop（与现有单跳行为等价）。此步骤不改变功能。

### Step 2：路由表改为多候选结构

将 `route_table: HashMap<u32, RouteDecision>` 改为 `HashMap<u32, Vec<RouteCandidate>>`。现有代码取单一路由的地方改为取 `candidates[0]`，保持行为不变。

### Step 3：Hub 侧 `compute_route_table` 输出完整路径

`find_best_path()` 已经通过 `prev` 回溯重建完整路径。修改 `compute_route_table()`：将 `path[1..path.len()-1]` 作为 `relay_chain` 输出（当前只取 `path[1]` 作为 `next_hop`）。

### Step 4：Hub 侧输出多候选路径

在 `compute_route_table()` 中，对每个 target 计算多条候选路径。可以使用 Yen 的 K-shortest-paths 算法，或简单地多次运行 Dijkstra 并排除已选路径的首跳。

### Step 5：更新 Protobuf 和路由表推送

修改 `HubRouteEntryProto`，`relay_chain: repeated uint32` 替代 `next_hop: optional uint32`。增加 `max_ttl` 字段到 `HubRouteTableUpdateParams`。同一 target 的多条记录按 cost 排序。

### Step 6：Edge 侧解析多候选路由表

更新 `hub.routeTableUpdate` 通知处理：按 `target_edge_id` 分组，构建 `Vec<RouteCandidate>`。

### Step 7：添加 TTL 到 `0x02` 包

发送端：TTL = min(relay_chain.len(), max_ttl)。格式变为 `[0x02][ttl][target][session][voice]`。

### Step 8：重写中继转发逻辑

中继 Edge 收到 `0x02` 包后，查询自己对 target 的路由候选列表，选择可用路径继续转发。TTL 递减防环。

### Step 9：实现 next-hop 故障检测

在 `route_voice` 中，发送失败时递增 `next_hop_failures[next_hop]`，发送成功时重置。选择候选路径时跳过失败次数 >= threshold 的 next-hop。收到 probe pong 时重置对应 peer 的失败计数。

### Step 10：Hub 侧质量阈值与防抖

实现 `degraded_packet_loss`/`failed_packet_loss`/`degraded_rtt_ms`/`failed_rtt_ms` 阈值：超过 failed 阈值的链路从图中移除。实现 `recovery_report_count` 和 `min_improvement_ms` 防抖逻辑。

### Step 11：✅ 实现 Edge TCP 语音通道（直连 + 中继）

扩展 `relay_server.rs`，增加 `/voice` 路径的 WebSocket 处理。Edge 启动后主动向所有已知 peer 建立 `/voice` 连接（见 §6.3）。

`/voice` 端点同时处理两种包类型：
- `[0x01][session][voice]`：直接交付本 Edge 客户端（DirectTcp 路径终点逻辑）
- `[0x02][ttl][target][session][voice]`：中继转发——与 UDP 收包后的转发逻辑完全一致，查询路由表，按下一跳的传输层（UDP socket 或 TCP WebSocket）继续发送

在 `route_voice` 中增加对 `DirectTcp` 和 `RelayChain(transports[0]=Tcp)` 的处理分支：通过 `voice_tcp_conns[peer_id]` 的 sender 发送二进制帧。

### Step 12：✅ Hub Dijkstra 双轨建图 + 路由条目携带传输层

为每对 Edge 同时添加 UDP 边和 TCP 边：

- UDP 边代价 = `rtt_udp + loss×P_loss`（如链路标记为 failed 则从图中移除）
- TCP 边代价 = `rtt_tcp + P_edge_tcp`（若 TCP 探测数据可用）或 `rtt_udp × 1.5 + P_edge_tcp`（无数据时保守估算）；即使 UDP 链路被标记为 failed，TCP 边仍然保留（两者独立）

路径搜索结果中混合 UDP/TCP 跳时，`RouteEntry.path` 的 `RelayChain.transports` 携带每跳的传输层。`HubRouteEntryProto` 新增 `relay_transports` 字段传输至 Edge（见 §7.3）。

### Step 13：Hub `enable_relay` 改名为 `enable_hub_tcp_relay`

重命名 `HubVoiceRoutingConfig` 中的字段和代码中所有引用。

### Step 14：✅ 将 relay/voice WebSocket 合并至主端口

当前 relay server（`relay_server.rs`）独立运行在 `edge_port + 2`，导致 `PeerEdgeInfo.relay_port` 动态发现失效（§1.6）。修复方案：

1. 在主 TCP 监听器（`edge_port`）的 accept 循环中增加**协议探测**：peek 首字节，`0x16` → TLS 握手（Mumble 客户端），否则 → 明文 HTTP，交给 WebSocket 路由器
2. WebSocket 路由器按路径分发：`/relay` → 现有控制中继逻辑，`/voice` → Step 11 中的语音通道逻辑
3. 废弃 `relay_server.rs` 独立监听（或保留为兼容模式）；`PeerEdgeInfo.relay_port` 字段标记为 deprecated
4. 连接建立时使用 `PeerEdgeInfo.host + edge_port + "/voice"` 作为目标地址

### Step 15：移除 `VoiceConnectionStrategy` 枚举

删除 `VoiceConnectionStrategy`、`EdgeVoiceFallbackConfig`，替换为新的精简 Edge 配置。

---

## 11. 行为对比

| 场景 | 旧 `auto_fallback` | 新设计 |
|------|--------------------|--------|
| Edge 间直连 UDP 正常 | 使用直连 UDP ✅ | 使用直连 UDP（候选列表第一项）✅ |
| UDP 丢包 20%，有好的中继路径 | 继续走直连（未达失败阈值）⚠️ | Hub Dijkstra 代价模型将中继排在前面，推送为首选候选 ✅ |
| UDP 完全不可达，有中继 Edge | 发送失败后回退 Hub TCP（绕过中继）⚠️ | 发送失败 → 跳过该候选 → 尝试下一个候选（中继）✅ |
| 多跳拓扑 A→C→D→B | relay 在 C 处直发 B 失败 ❌ | Hub 推送 relay_chain=[C,D]，C 查路由表继续转发到 D ✅ |
| 防火墙阻止 UDP，Edge 间 TCP 可达 | 只能回退 Hub TCP ⚠️ | DirectTcp 候选：延迟低于 Hub TCP，不经过 Hub ✅ |
| 所有 UDP 路径均不可达 | 回退 Hub TCP ✅ | 候选列表中 HubTcp 作为兜底 ✅ |
| 路径短暂抖动后恢复 | 无自动恢复 ⚠️ | Hub 防抖后推送新路由表，Edge 立即生效 ✅ |
| 管理员需调试，禁用 Hub relay | `direct_only` ✅ | Edge `enable_hub_tcp_fallback = false` + Hub `enable_hub_tcp_relay = false` ✅ |

---

## 12. 附录：路径代价计算示例

**拓扑**：三个 Edge，延迟和丢包如下：

```
A→B: RTT=30ms, loss=5%
A→C: RTT=10ms, loss=1%
C→B: RTT=15ms, loss=2%
Hub RTT（A到Hub）= 20ms
```

**参数**：`packet_loss_penalty_ms = 500`, `relay_hop_penalty_ms = 5`, `hub_tcp_penalty_ms = 50`, `edge_tcp_penalty_ms = 20`

| 路径 | 计算 | 代价 |
|------|------|------|
| Direct A→B (UDP) | 30 + 0.05×500 | **55 ms** |
| Relay A→C→B (UDP) | (10+0.01×500) + (15+0.02×500) + 1×5 | 15 + 25 + 5 = **45 ms** |
| DirectTcp A→B | 32（实测 TCP RTT）+ 20 | **52 ms** |
| Relay A→C→B（C→B via TCP） | 15 + TCP_RTT(C→B)+20 + 5 = 15+22+5 | **42 ms**（若 C→B TCP RTT=17ms） |
| Hub TCP | (20×2) + 50 | **90 ms** |

Hub 向 Edge A 推送 target=B 的候选列表：
1. `RelayChain([C], [Udp])` cost=45
2. `DirectUdp` cost=55
3. `DirectTcp` cost=52
4. `HubTcp` cost=90

正常情况下 Edge A 使用候选 [0]（经 C 中继）。若 C 的 UDP 连续发送失败 2 次，立即切换到候选 [1]（直连 B）。若直连也失败，尝试候选 [2]（Edge TCP）。若 TCP 连接也无法建立，退回候选 [3]（Hub TCP）。

---

## 13. 已知局限与后续优化

1. **非对称链路（本期实现）**：链路的延迟和丢包往往是非对称的（A→B 与 B→A 质量不同），Hub Dijkstra 需要有向图才能正确建模。本期通过扩展 `0x03` Pong 包携带 `pong_sent_ms` 字段来支持单向延迟估算，并在 `edge.reportQuality` 中增加方向标记（见 §5.5）。Hub 以有向边代价建图，两个方向独立赋值。

2. **Relay 负载均衡**：当多条代价相近的中继路径存在时，可考虑按负载轮询分配，避免单一中继 Edge 过载。当前实现选取代价最低的单一路径；若集群中出现中继热点，可在候选列表的前几条之间引入轮询策略。

3. **`relay_port` 字段废弃**：`PeerEdgeInfo.relay_port` 因端口合并（§1.6、Step 14）而不再使用，应在 Step 14 完成后将其从 protobuf 消息和结构体中清理，避免残留字段造成混淆。
