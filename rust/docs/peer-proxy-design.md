# Peer Edge Control Relay — 概要设计文档

**版本**: 1.0  
**状态**: ✅ 已实现  
**优先级**: P2  
**实现日期**: 2026-03-12

---

## 1. 背景与目标

### 1.1 问题描述

在分布式 Edge 集群中，当 Edge A 与 Hub 之间发生网络分区或临时故障时，Edge A 无法向 Hub 注册或发送控制消息，导致用户无法登录或者 Edge 被孤立。

### 1.2 解决思路

允许同一 Hub 集群内其他已连接的 Edge（Peer Edge B）作为控制信道的透明代理。Edge A 通过 Edge B 的代理端口，把 WebSocket 控制流量转发到 Hub。

### 1.3 范围限制

- **仅适用于控制信道**（Edge-Hub WebSocket RPC），不用于语音流量（语音已有 Hub TCP 中继）。
- 代理链路最多**一跳**（Edge A → Edge B → Hub），防止环路。
- Hub 侧**无需任何修改**；代理在 Edge-to-Edge 层面完全透明地转发 WebSocket 帧。

---

## 2. 架构设计

### 2.1 整体流程

```
正常模式:
  Edge A ──WS──► Hub

代理模式（Hub 不可达时）:
  Edge A ──WS──► Edge B（代理服务器）──WS──► Hub
                 ↑
                 透明转发所有二进制帧
```

### 2.2 代理服务器设计（Edge B 侧）

- Edge B 在 `proxy_ws_port`（默认 `edge_port + 2`）上监听 HTTP/WebSocket 连接。
- 当收到来自 Edge A 的 WebSocket 连接时：
  1. Edge B 主动向 Hub 建立一个新的 WebSocket 连接（`ws://hub_host:hub_port/`）。
  2. 同时在两个 WebSocket 连接间**双向透明转发**所有二进制帧。
  3. 任意一侧断开时，关闭另一侧连接并清理资源。
- 代理服务器无需解析帧内容，仅负责透明转发。

### 2.3 代理客户端设计（Edge A 侧）

在 `HubClient.connect_and_run()` 中增加代理回退逻辑：

1. **正常尝试**：直连 Hub（现有行为）。
2. **代理回退**：当直连失败次数超过 `direct_fail_threshold`（默认 3 次）时，遍历已知 Peer Edge 列表，尝试通过 peer 的 proxy_ws_port 连接。
3. **恢复优先直连**：每次重连时，优先尝试直连 Hub；直连成功则切回正常模式，清除代理状态。

### 2.4 Proxy Port 发现机制

Edge A 如何知道 Edge B 的代理端口？

- Edge B 在向 Hub 注册时（`edge.register` RPC），在 `EdgeRegisterParams` 中携带 `proxy_port` 字段（可选，`tag = 10`）。
- Hub 在广播 `hub.clusterPeerJoined` 通知时，将 `proxy_port` 包含在 `HubClusterPeerJoinedParams` 中（`tag = 5`）。
- Edge A 收到通知后，更新本地 `PeerRegistry` 中对应 Peer 的 `proxy_port`。

---

## 3. 配置项

### 3.1 Edge 配置（`config/edge.toml`）

```toml
[hub_server]
# 允许本 Edge 被其他 Edge 用作控制信道代理（默认 false）
allow_peer_proxy = true

# 代理服务器监听端口（默认 0 = 禁用代理服务器）
# 若 allow_peer_proxy = true 且此值为 0，自动使用 edge_port + 2
proxy_ws_port = 0
```

### 3.2 配置说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `hub_server.allow_peer_proxy` | `bool` | `false` | 是否允许作为代理节点 |
| `hub_server.proxy_ws_port` | `u16` | `0`（自动） | 代理服务器监听端口 |

---

## 4. 协议变更

### 4.1 `EdgeRegisterParams` 新增字段

```protobuf
// tag = 10（可选）— 代理服务器端口；0 或缺失表示不支持代理
optional uint32 proxy_port = 10;
```

### 4.2 `HubClusterPeerJoinedParams` 新增字段

```protobuf
// tag = 5（可选）— 该 Peer 的代理服务器端口；0 或缺失表示不支持代理
optional uint32 proxy_port = 5;
```

由于两个字段均为 `optional`，对不携带该字段的旧版客户端完全向后兼容。

---

## 5. 关键实现文件

| 文件 | 变更 |
|------|------|
| `rust/munode-protocol/src/generated/hubedge.rs` | 添加 `proxy_port` 可选字段 |
| `rust/munode-common/src/config.rs` | 添加 `allow_peer_proxy`、`proxy_ws_port` 配置项 |
| `rust/munode-edge/src/proxy_server.rs` | **新建** — 代理服务器实现 |
| `rust/munode-edge/src/hub_client.rs` | 注册时携带 proxy_port；代理回退逻辑 |
| `rust/munode-edge/src/state.rs` | `PeerEdgeInfo` 添加 `proxy_port` 字段 |
| `rust/munode-hub/src/rpc_handler.rs` | 注册时保存并广播 proxy_port |
| `rust/munode-hub/src/server.rs` | `EdgeRegistration` 添加 `proxy_port` 字段 |
| `rust/munode-edge/src/lib.rs` | 注册 `proxy_server` 模块 |
| `rust/munode-edge/src/server.rs` | 启动代理服务器 task |

---

## 6. 代理服务器核心逻辑（伪代码）

```rust
// proxy_server.rs

pub async fn run_proxy_server(port: u16, hub_host: String, hub_port: u16) {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    while let Ok((stream, peer_addr)) = listener.accept().await {
        let hub_url = format!("ws://{}:{}", hub_host, hub_port);
        tokio::spawn(async move {
            if let Err(e) = handle_proxy_connection(stream, hub_url).await {
                warn!("Proxy connection from {} ended: {}", peer_addr, e);
            }
        });
    }
}

async fn handle_proxy_connection(client_stream: TcpStream, hub_url: String) -> Result<()> {
    // Upgrade incoming TCP connection to WebSocket
    let client_ws = tokio_tungstenite::accept_async(client_stream).await?;
    // Connect to Hub
    let (hub_ws, _) = tokio_tungstenite::connect_async(&hub_url).await?;
    // Bidirectional relay
    let (client_write, client_read) = client_ws.split();
    let (hub_write, hub_read) = hub_ws.split();
    tokio::select! {
        _ = relay(client_read, hub_write) => {}
        _ = relay(hub_read, client_write) => {}
    }
    Ok(())
}
```

---

## 7. 代理回退逻辑（伪代码）

```rust
// hub_client.rs — connect_and_run 修改

async fn try_proxy_connect(self: &Arc<Self>) -> Result<()> {
    let peers = self.edge_state.peer_registry.read().await;
    for (peer_id, info) in peers.iter() {
        if let Some(proxy_port) = info.proxy_port {
            let proxy_url = format!("ws://{}:{}", info.host, proxy_port);
            info!("Trying peer proxy via Edge {} at {}", peer_id, proxy_url);
            if let Ok(()) = self.try_connect_via_url(proxy_url, slot, is_primary).await {
                return Ok(());
            }
        }
    }
    Err(anyhow!("No available peer proxy"))
}
```

---

## 8. 集成测试场景

| 测试场景 | 描述 |
|----------|------|
| 基本代理功能 | Edge A 通过 Edge B 代理成功注册到 Hub |
| 用户登录代理 | 通过代理的 Edge A 可以正常认证用户 |
| 无可用代理 | 无 proxy 时直接报错（不影响正常模式） |
| 代理端口可达性 | diagnose 命令正确报告代理端口状态 |

> 注：端到端的网络分区测试（强制断开 Edge A 到 Hub 的连接）在受控测试环境中实现困难，暂不实现该用例。基本代理功能通过直接向代理端口发起连接来测试。

---

## 9. 已知限制

1. **不支持 TLS 的代理链路**：Edge A → Edge B 之间的代理通信是明文 WebSocket。在生产环境中，建议代理通信也走 TLS（待后续实现）。
2. **单跳限制**：Edge B 不会继续代理给 Edge C，防止环路。
3. **Hub 通知路径**：Hub 推送的通知（如用户加入/离开）会正常通过代理链路到达 Edge A，因为代理是透明的。
4. **连接数**：每个代理连接在 Edge B 上打开两个 WebSocket（一个客户侧，一个 Hub 侧），要注意连接数限制。
